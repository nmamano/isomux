import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAuthorityBroker } from "./authority-broker.ts";

// The broker's real peer-credential and process-ancestry reads, on this host.
// A stand-in "server" process runs curl through a shell, the way an OpenCode
// bash tool does, and other processes of the same user try the same call.

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const CURL_STATUS = `curl -s -o /dev/null -w '%{http_code}' --unix-socket "$1" -H "X-Isomux-Turn: $2" http://isomux/agents`;

const SERVER_SCRIPT = `
const socketPath = process.argv[2];
for await (const line of console) {
  const [command, handle, output] = line.trim().split(" ");
  if (command === "call") {
    const shell = Bun.spawnSync(["sh", "-c", ${JSON.stringify(CURL_STATUS)}, "sh", socketPath, handle]);
    console.log(shell.stdout.toString());
  } else if (command === "orphan") {
    // The subshell exits at once, so curl runs reparented, outside this tree.
    Bun.spawnSync(["sh", "-c", '( sleep 0.5; ' + ${JSON.stringify(CURL_STATUS)} + ' > "$3" ) &', "sh", socketPath, handle, output]);
    console.log("started");
  }
}
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "isomux-aba-"));
  const socketPath = join(root, "private", "authority.sock");
  const upstream = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  const broker = new OpenCodeAuthorityBroker(
    socketPath,
    process.getuid?.() ?? -1,
    `http://127.0.0.1:${upstream.port}`,
  );
  const script = join(root, "server.ts");
  writeFileSync(script, SERVER_SCRIPT);
  const server = Bun.spawn([process.execPath, "run", script, socketPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const lines = server.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  async function ask(line: string): Promise<string> {
    void server.stdin.write(`${line}\n`);
    void server.stdin.flush();
    while (!pending.includes("\n")) {
      const { value, done } = await lines.read();
      if (done) throw new Error("stand-in server exited");
      pending += value;
    }
    const newline = pending.indexOf("\n");
    const answer = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    return answer.trim();
  }
  cleanup.push(async () => {
    server.kill();
    await server.exited;
    broker.close();
    await upstream.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, broker, socketPath, server, ask };
}

async function curlStatus(socketPath: string, handle: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", CURL_STATUS, "sh", socketPath, handle], {
    stdout: "pipe",
  });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

describe("OpenCode authority broker process ancestry", () => {
  it("lets a descendant of the bound server through and refuses every other process of the same user", async () => {
    const f = fixture();
    const handle = f.broker.bind("agent-b", "token-b").activate(f.server.pid);

    expect(await f.ask(`call ${handle}`)).toBe("200");
    // A curl spawned by this test process, a sibling of the server.
    expect(await curlStatus(f.socketPath, handle)).toBe("403");
    // A descendant that detached from the server's tree before the call.
    const output = join(f.root, "orphan-status");
    expect(await f.ask(`orphan ${handle} ${output}`)).toBe("started");
    let orphanStatus = "";
    for (let i = 0; i < 100 && !orphanStatus; i++) {
      await Bun.sleep(50);
      try {
        orphanStatus = readFileSync(output, "utf8").trim();
      } catch {}
    }
    expect(orphanStatus).toBe("403");
    // A handle bound to another live process refuses this server's children.
    const sibling = Bun.spawn(["sleep", "30"]);
    const siblingHandle = f.broker
      .bind("agent-d", "token-d")
      .activate(sibling.pid);
    expect(await f.ask(`call ${siblingHandle}`)).toBe("403");
    sibling.kill();
    await sibling.exited;
  }, 30_000);

  it("refuses to bind a server that has exited", async () => {
    const f = fixture();
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    expect(() =>
      f.broker.bind("agent-b", "token-b").activate(exited.pid),
    ).toThrow();
  });
});
