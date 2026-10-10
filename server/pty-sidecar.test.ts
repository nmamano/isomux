import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalOwner } from "./pty-owner.ts";

type Message = {
  type: string;
  data?: string;
  process?: string;
  shell?: boolean;
  exitCode?: number;
  signal?: string | null;
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function waitFor(check: () => boolean, label: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function waitForOwner(pid: number, owner: string) {
  const deadline = Date.now() + 5000;
  while ((await terminalOwner(pid)) !== owner) {
    if (Date.now() >= deadline)
      throw new Error(`Missing foreground owner ${owner}`);
    await Bun.sleep(10);
  }
}

async function fixture(shellName?: string) {
  const home = await mkdtemp(join(tmpdir(), "isomux-pty-"));
  await writeFile(
    join(home, ".bash_profile"),
    "stty -echo\nPS1='PTY_READY> '\n",
  );
  const shell = shellName ? join(home, shellName) : "/bin/bash";
  if (shellName) await symlink("/bin/bash", shell);
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "pty-sidecar.ts")],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let output = "";
  const messages: Message[] = [];
  const stderr = new Response(child.stderr).text();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let partial = "";
    for await (const bytes of child.stdout) {
      partial += decoder.decode(bytes, { stream: true });
      let index;
      while ((index = partial.indexOf("\n")) >= 0) {
        const line = partial.slice(0, index);
        partial = partial.slice(index + 1);
        const message = JSON.parse(line) as Message;
        messages.push(message);
        if (message.type === "output") output += message.data;
      }
    }
  })();
  const send = (message: object) => {
    void child.stdin.write(JSON.stringify(message) + "\n");
  };
  cleanups.push(async () => {
    if (child.exitCode === null) {
      send({ type: "kill" });
      await Promise.race([child.exited, Bun.sleep(1000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await child.exited;
    await reading;
    await rm(home, { recursive: true, force: true });
  });
  send({
    type: "spawn",
    shell,
    cwd: home,
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    },
  });
  await waitFor(() => output.includes("PTY_READY> "), "login shell ready");
  expect(output).not.toMatch(
    /no job control|cannot set terminal process group/,
  );
  const command = async (text: string, match: RegExp) => {
    output = "";
    send({ type: "input", data: text + "\n" });
    await waitFor(() => match.test(output), text.slice(0, 100));
    return output;
  };
  const identity = await command("printf 'PID=%s\\n' $$", /PID=\d+\r?\n/);
  const shellPid = Number(identity.match(/PID=(\d+)/)![1]);
  return {
    child,
    shellPid,
    send,
    command,
    messages,
    stderr,
    reading,
    get output() {
      return output;
    },
  };
}

async function processState(pid: number) {
  const child = Bun.spawn(["/bin/ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const state = (await new Response(child.stdout).text()).trim();
  await child.exited;
  return state;
}
async function gone(pid: number, parentExited = false) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await processState(pid);
    // A zombie counts only after its original parent has exited.
    if (!state || (parentExited && state.startsWith("Z"))) return;
    await Bun.sleep(20);
  }
  throw new Error(`Process ${pid} survived terminal teardown`);
}

async function jobs(f: Awaited<ReturnType<typeof fixture>>) {
  const background = await f.command(
    "sleep 300 & printf 'BG=%s\\n' $!",
    /BG=\d+\r?\n/,
  );
  const bg = Number(background.match(/BG=(\d+)/)![1]);
  f.send({ type: "input", data: "sleep 300\n" });
  await waitFor(
    () =>
      f.messages.some(
        (m) => m.type === "status" && m.process === "sleep" && !m.shell,
      ),
    "foreground sleep",
  );
  const p = Bun.spawn(["/bin/ps", "-o", "pid=,pgid=,comm=", "-ax"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const listing = await new Response(p.stdout).text();
  await p.exited;
  // Find the foreground group through the shell's kernel tpgid, using the
  // same portable ps field that macOS owner detection uses.
  const group = Bun.spawn(
    ["/bin/ps", "-o", "tpgid=", "-p", String(f.shellPid)],
    { stdout: "pipe", stderr: "ignore" },
  );
  const fg = Number((await new Response(group.stdout).text()).trim());
  await group.exited;
  expect(fg).toBeGreaterThan(0);
  expect(fg).not.toBe(f.shellPid);
  expect(listing).toContain(String(fg));
  cleanups.push(async () => {
    for (const pid of [bg, fg]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
  return { bg, fg };
}

describe("Bun PTY sidecar", () => {
  it("owns a controlling terminal, supports job control and reports the foreground owner", async () => {
    const f = await fixture();
    const details = await f.command(
      "tty; stty size; ps -o pid=,pgid=,tpgid= -p $$; set -o | grep monitor; printf 'TERM=%s\\n' \"$TERM\"",
      /TERM=xterm-256color\r?\n/,
    );
    expect(details).toMatch(/\/dev\/\S+/);
    expect(details).toMatch(/monitor\s+on/);
    expect(details).toMatch(/24 80/);
    const ids = details.match(
      /(?:\n|\r)[ \t]*(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*\r?\n/,
    )!;
    expect(Number(ids[1])).toBe(f.shellPid);
    expect(Number(ids[2])).toBe(f.shellPid);
    expect(Number(ids[3])).toBeGreaterThan(0);
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${f.shellPid}/stat`, "utf8");
      expect(Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3])).toBe(
        f.shellPid,
      );
    }
    expect(await terminalOwner(f.shellPid)).toBe("bash");
    const { bg, fg } = await jobs(f);
    expect(await terminalOwner(f.shellPid)).toBe("sleep");
    f.send({ type: "input", data: "\x1a" });
    await waitFor(() => /Stopped.*sleep/.test(f.output), "stopped foreground");
    const resumed = await f.command("bg %+; jobs -l", /Running.*sleep/);
    expect(resumed).toContain(String(fg));
    f.send({ type: "input", data: "fg %+\n" });
    await waitForOwner(f.shellPid, "sleep");
    f.send({ type: "input", data: "\x03" });
    await gone(fg);
    await waitFor(
      () => f.messages.findLast((m) => m.type === "status")?.shell === true,
      "shell owner after Ctrl+C",
    );
    const status = await f.command(
      "printf 'RESULT=%s PID=%s\\n' \"$?\" $$",
      /RESULT=130 PID=\d+\r?\n/,
    );
    expect(status).toContain(`PID=${f.shellPid}`);
    expect(await processState(bg)).not.toBe("");
    expect(await terminalOwner(f.shellPid)).toBe("bash");
    await f.command("trap 'echo WINCH $(stty size)' WINCH", /PTY_READY> /);
    f.send({ type: "resize", cols: 120, rows: 40 });
    await waitFor(() => /WINCH 40 120/.test(f.output), "SIGWINCH");
    // The background sleep deliberately keeps the slave open: this pins the drain bound.
    f.send({ type: "input", data: "exit 7\n" });
    await waitFor(
      () => f.messages.some((m) => m.type === "exit"),
      "exit event",
    );
    expect(f.messages.find((m) => m.type === "exit")).toMatchObject({
      exitCode: 7,
      signal: null,
    });
  }, 15000);

  it.skipIf(process.platform !== "linux")(
    "recognizes a shell whose name exceeds the kernel comm limit",
    async () => {
      const name = "terminal-shell-with-a-long-name";
      const f = await fixture(name);
      expect(await terminalOwner(f.shellPid)).toBe(name);
      const start = f.messages.length;
      f.send({ type: "status" });
      await waitFor(
        () => f.messages.slice(start).some((m) => m.type === "status"),
        "explicit owner reply",
      );
      expect(
        f.messages.slice(start).find((m) => m.type === "status"),
      ).toMatchObject({ process: name, shell: true });
    },
  );

  it("delivers megabytes and complete UTF-8 before the exit message", async () => {
    const f = await fixture();
    const count = 400_000;
    const expected = "x" + "😀".repeat(count) + "TAIL";
    const source = `process.stdout.write(${JSON.stringify("x")}); process.stdout.write(${JSON.stringify("😀")}.repeat(${count})); process.stdout.write("TAIL");`;
    const offset = f.messages.length;
    f.send({
      type: "input",
      data: `${quote(process.execPath)} -e ${quote(source)}; exit 3\n`,
    });
    await waitFor(
      () => f.messages.some((m) => m.type === "exit"),
      "output and exit",
      15000,
    );
    await f.child.exited;
    await f.reading;
    const data = f.messages
      .slice(offset)
      .filter((m) => m.type === "output")
      .map((m) => m.data)
      .join("");
    expect(data).not.toContain("\ufffd");
    expect(data).toContain(expected);
    expect(data.split("😀").length - 1).toBe(count);
    const exitIndex = f.messages.findIndex((m) => m.type === "exit");
    expect(
      f.messages.slice(exitIndex + 1).some((m) => m.type === "output"),
    ).toBe(false);
    expect(f.messages[exitIndex]).toMatchObject({ exitCode: 3 });
  }, 20000);

  it("decodes a UTF-8 code point split across callbacks", async () => {
    const f = await fixture();
    // The child waits for an acknowledgement after the parent receives
    // READY, so the two halves cannot arrive in the same data callback.
    const source =
      "process.stdout.write(Buffer.from([82,69,65,68,89,240,159])); const r = Bun.stdin.stream().getReader(); await r.read(); await r.cancel(); process.stdout.write(Buffer.from([152,128]));";
    await f.command(
      `stty raw -echo; ${quote(process.execPath)} -e ${quote(source)}; stty -raw -echo; echo UTF_DONE`,
      /READY/,
    );
    f.send({ type: "input", data: "!" });
    await waitFor(() => f.output.includes("UTF_DONE"), "second UTF-8 half");
    expect(f.output).toContain("READY😀");
    expect(f.output).not.toContain("\ufffd");
  }, 10000);

  it("accepts a one-megabyte paste without dropping or repeating bytes", async () => {
    const f = await fixture();
    await f.command(
      "stty raw -echo; printf 'PASTE_READY'; head -c 1048576 | wc -c; stty sane; echo PASTE_DONE",
      /PASTE_READY/,
    );
    f.send({ type: "input", data: "a".repeat(1048576) });
    await waitFor(
      () => f.output.includes("PASTE_DONE"),
      "paste drained",
      15000,
    );
    expect(f.output).toMatch(/1048576/);
  }, 20000);

  for (const abrupt of [false, true]) {
    it(`${abrupt ? "sidecar SIGKILL" : "panel close"} ends the shell and foreground and background jobs`, async () => {
      const f = await fixture();
      const { bg, fg } = await jobs(f);
      if (abrupt) f.child.kill("SIGKILL");
      else f.send({ type: "kill" });
      const exited = await Promise.race([
        f.child.exited.then(() => true),
        Bun.sleep(1500).then(() => false),
      ]);
      expect(exited).toBe(true);
      await gone(f.shellPid, true);
      await gone(fg, true);
      await gone(bg, true);
    }, 15000);
  }

  it("panel close ends stopped and background jobs and exits the sidecar", async () => {
    const f = await fixture();
    const { bg, fg } = await jobs(f);
    f.send({ type: "input", data: "\x1a" });
    await waitFor(() => /Stopped.*sleep/.test(f.output), "stopped foreground");
    expect(await processState(fg)).toMatch(/^T/);
    f.send({ type: "kill" });
    const exited = await Promise.race([
      f.child.exited.then(() => true),
      Bun.sleep(1500).then(() => false),
    ]);
    expect(exited).toBe(true);
    await gone(f.shellPid, true);
    await gone(fg, true);
    await gone(bg, true);
  }, 15000);

  it("reports an actionable error and exits when Bun.Terminal is unavailable", async () => {
    const source =
      'Reflect.set(Bun, "Terminal", undefined); await import(' +
      JSON.stringify(join(import.meta.dir, "pty-sidecar.ts")) +
      ");";
    const child = Bun.spawn([process.execPath, "-e", source], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    });
    void child.stdin.write(JSON.stringify({ type: "spawn" }) + "\n");
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(1500).then(() => false),
    ]);
    expect(exited).toBe(true);
    const messages = (await new Response(child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Message);
    expect(messages.map((m) => m.type)).toEqual(["output", "exit"]);
    expect(messages[0].data).toMatch(/Bun 1\.3\.11/);
    expect(messages[0].data).toMatch(/Update Bun.*restart Isomux/);
    expect(messages[1]).toMatchObject({ exitCode: 127, signal: null });
  });

  it("reports the shell signal separately from its numeric exit status", async () => {
    const f = await fixture();
    process.kill(f.shellPid, "SIGKILL");
    await waitFor(
      () => f.messages.some((m) => m.type === "exit"),
      "signal exit",
    );
    expect(f.messages.find((m) => m.type === "exit")).toMatchObject({
      exitCode: 137,
      signal: "SIGKILL",
    });
  }, 10000);
});
