// Slice 2a of task b94dfd25 (internal-docs/member-os-user-design.md, section
// 1.4): a file that an isolated member's agent names is read as the member,
// through their host. Three parts: the runner's reads (a real runner in this
// process), the server's bounds on what a runner sends (a false runner), and
// each surface with a host that is not ready, where the office must refuse
// and never read the file itself.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createServer, type Server } from "net";
import { tmpdir } from "os";
import { join } from "path";
import {
  localAgentFs,
  localAgentHost,
  type AgentFileStat,
  type AgentHost,
} from "../agent-host.ts";
import {
  hostFileResponse,
  HostFileReadError,
  openHostFileRange,
  readHostFile,
} from "../agent-file-read.ts";
import { probeEditFile, probeReadFile } from "../affordance-checks.ts";
import { BrowserUploadError, openBrowserUpload } from "../browser-upload.ts";
import {
  openFile,
  saveFile,
  stopWatch,
  watchFile,
  type WatchFileEvent,
} from "../file-editor.ts";
import { createNotReadyHost } from "../member-hosts.ts";
import { RunnerAgentHost, runnerAgentFs } from "../agent-runner/client.ts";
import {
  encodeData,
  encodeJson,
  FRAME_STDOUT,
} from "../agent-runner/frames.ts";
import { startRunner } from "../agent-runner/runner.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "member-host-files-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (error: NodeJS.ErrnoException) => error.code ?? "rejected",
  );

// Settles within `ms`, or "stalled": a read that blocks on a FIFO never
// settles, and the test must say so, not time out.
const within = <T>(p: Promise<T>, ms = 2000) =>
  Promise.race([p, Bun.sleep(ms).then(() => "stalled" as const)]);

const fifo = (path: string) => execFileSync("mkfifo", [path]);

describe("a member's runner reads", () => {
  let runner: { stop(): void } | null = null;
  let host: RunnerAgentHost;
  beforeEach(async () => {
    const socketPath = join(dir, "runner.sock");
    runner = startRunner({
      socketPath,
      serverUid: process.getuid!(),
      readPeerUid: () => process.getuid!(),
      killGraceMs: 300,
    });
    host = await RunnerAgentHost.connect(socketPath);
  });
  afterEach(() => {
    runner?.stop();
    runner = null;
  });

  it("gives a regular file up to max bytes, and refuses one byte more, a FIFO, a device and a folder at once", async () => {
    writeFileSync(join(dir, "at"), "x".repeat(64));
    writeFileSync(join(dir, "over"), "x".repeat(65));
    fifo(join(dir, "pipe"));
    mkdirSync(join(dir, "folder"));
    expect((await host.fs.readBytes(join(dir, "at"), 64)).length).toBe(64);
    expect(await code(host.fs.readBytes(join(dir, "over"), 64))).toBe("EFBIG");
    for (const path of [join(dir, "pipe"), "/dev/null", join(dir, "folder")])
      expect([path, await within(code(host.fs.readBytes(path, 64)))]).toEqual([
        path,
        "EINVAL",
      ]);
  }, 10_000);

  it("does not block on a FIFO in readText either", async () => {
    fifo(join(dir, "pipe"));
    expect(await within(host.fs.readText(join(dir, "pipe")))).toBe("");
  }, 10_000);

  it("stats a file, a folder and something else, following links", async () => {
    writeFileSync(join(dir, "f"), "abc");
    mkdirSync(join(dir, "d"));
    fifo(join(dir, "p"));
    execFileSync("ln", ["-s", join(dir, "f"), join(dir, "link")]);
    const type = async (name: string) =>
      (await host.fs.stat(join(dir, name))).type;
    expect(await Promise.all(["f", "d", "p", "link"].map(type))).toEqual([
      "file",
      "dir",
      "other",
      "file",
    ]);
    expect((await host.fs.stat(join(dir, "f"))).size).toBe(3);
    expect(await code(host.fs.stat(join(dir, "absent")))).toBe("ENOENT");
  });

  it("streams a range of a file with its real path, and refuses a FIFO", async () => {
    writeFileSync(join(dir, "f.bin"), "0123456789");
    execFileSync("ln", ["-s", join(dir, "f.bin"), join(dir, "alias")]);
    const opened = await openHostFileRange(host, join(dir, "alias"), {
      offset: 2,
      length: 5,
      sizeMax: 100,
      timeoutMs: 10_000,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of opened.bytes) chunks.push(Buffer.from(chunk));
    expect([
      opened.real,
      opened.size,
      Buffer.concat(chunks).toString(),
    ]).toEqual([join(dir, "f.bin"), 10, "23456"]);
    fifo(join(dir, "pipe"));
    const refused = await within(
      openHostFileRange(host, join(dir, "pipe"), {
        offset: 0,
        length: 10,
        sizeMax: 100,
        timeoutMs: 10_000,
      }).then(
        () => "opened",
        (error: unknown) => (error as HostFileReadError).code,
      ),
      5000,
    );
    expect(refused).toBe("failed");
  }, 15_000);
});

// A false runner on the member's socket: every reply is member data.
describe("the server holds a runner to what it asked", () => {
  let fake: Server | null = null;
  const socketPath = () => join(dir, "fake.sock");
  async function fakeRunner(
    reply: (send: (frames: Buffer | Buffer[]) => void) => void,
  ) {
    fake = createServer((socket) => {
      socket.on("error", () => {});
      reply((frames) => {
        for (const f of [frames].flat()) socket.write(f);
      });
      socket.end();
    });
    await new Promise<void>((resolve) => fake!.listen(socketPath(), resolve));
  }
  afterEach(() => {
    fake?.close();
    fake = null;
  });

  it("refuses a readBytes answer longer than max, on the server's own count", async () => {
    await fakeRunner((send) => {
      send(encodeData(FRAME_STDOUT, Buffer.alloc(64 * 1024, 1)));
      send(encodeJson({ type: "fs" }));
    });
    const fs = runnerAgentFs(socketPath());
    expect(await code(fs.readBytes("/any", 16))).toBe("EFBIG");
    // The control: the same answer fits a larger max.
    expect((await fs.readBytes("/any", 64 * 1024)).length).toBe(64 * 1024);
  });

  it("refuses a stat whose fields are out of range, and a stat that sends bytes", async () => {
    const good: AgentFileStat = { type: "file", size: 3, mtimeMs: 1, ino: 7 };
    let stat: unknown = good;
    let bytes = false;
    await fakeRunner((send) => {
      if (bytes) send(encodeData(FRAME_STDOUT, Buffer.from("x")));
      send(encodeJson({ type: "fs", stat }));
    });
    const fs = runnerAgentFs(socketPath());
    expect(await fs.stat("/any")).toEqual(good);
    for (const bad of [
      { ...good, size: -1 },
      { ...good, type: "socket" },
      { ...good, ino: undefined },
      { ...good, mtimeMs: Number.NaN },
      null,
    ]) {
      stat = bad;
      expect([bad, await code(fs.stat("/any"))]).toEqual([bad, "EPROTO"]);
    }
    stat = good;
    bytes = true;
    expect(await code(fs.stat("/any"))).not.toBe("resolved");
  });

  it("gives up on a runner that does not answer, and closes the stream", async () => {
    let closed = false;
    fake = createServer((socket) => {
      socket.on("error", () => {});
      // Read the request and drop it: a socket whose input is never read
      // sees no end, so it would not close when the client closes.
      socket.resume();
      socket.on("close", () => {
        closed = true;
      });
    });
    await new Promise<void>((resolve) => fake!.listen(socketPath(), resolve));
    const fs = runnerAgentFs(socketPath(), 200);
    expect(await within(code(fs.stat("/any")))).toBe("ETIMEDOUT");
    expect(await within(code(fs.readBytes("/any", 16)))).toBe("ETIMEDOUT");
    const deadline = Date.now() + 1000;
    while (!closed && Date.now() < deadline) await Bun.sleep(10);
    expect(closed).toBe(true);
  });
});

// A runner host whose file-read entry answers with `header` and then `body`,
// and whose stat gives `statSize`.
function streamHost(
  header: unknown,
  body: Buffer[],
  statSize: number,
): { host: AgentHost; closed: () => boolean } {
  let closed = false;
  const host = {
    kind: "runner",
    member: "member-files-test",
    home: () => dir,
    fs: {
      ...localAgentFs,
      stat: async () => ({ type: "file", size: statSize, mtimeMs: 0, ino: 1 }),
    },
    runEntryOut: (name: string) => {
      if (name !== "file-read") throw new Error(`unexpected entry ${name}`);
      return (async function* () {
        try {
          yield Buffer.from(`${JSON.stringify(header)}\n`);
          for (const chunk of body) {
            await Bun.sleep(0);
            yield chunk;
          }
        } finally {
          closed = true;
        }
      })();
    },
  } as unknown as AgentHost;
  return { host, closed: () => closed };
}

const body = (response: Response | null) =>
  response!.text().then(
    (text) => text,
    () => "error",
  );

describe("a file-read stream", () => {
  const real = "/member/clip.mp4";

  it("fails the response when the runner sends fewer or more bytes than the file holds", async () => {
    const whole = streamHost(
      { real, size: 10 },
      [Buffer.from("0123456789")],
      10,
    );
    const short = streamHost({ real, size: 10 }, [Buffer.from("01234")], 10);
    const long = streamHost(
      { real, size: 10 },
      [Buffer.from("0123456789A")],
      10,
    );
    const respond = (h: AgentHost) =>
      hostFileResponse(h, real, "video/mp4", {}, null);
    expect(await body(await respond(whole.host))).toBe("0123456789");
    const cut = await respond(short.host);
    expect([cut!.status, cut!.headers.get("content-length")]).toEqual([
      200,
      "10",
    ]);
    expect(await body(cut)).toBe("error");
    expect(await body(await respond(long.host))).toBe("error");
  });

  it("answers a Range with 206 and its bytes, and a range past the end with 416", async () => {
    const h = streamHost({ real, size: 10 }, [Buffer.from("234")], 10);
    const part = await hostFileResponse(
      h.host,
      real,
      "video/mp4",
      {},
      "bytes=2-4",
    );
    expect([
      part!.status,
      part!.headers.get("content-range"),
      await body(part),
    ]).toEqual([206, "bytes 2-4/10", "234"]);
    const past = await hostFileResponse(
      h.host,
      real,
      "video/mp4",
      {},
      "bytes=10-",
    );
    expect(past!.status).toBe(416);
  });

  it("serves nothing when the runner's size is not the size of the stat, or is past the cap", async () => {
    const other = streamHost(
      { real, size: 11 },
      [Buffer.from("0123456789A")],
      10,
    );
    expect(
      await hostFileResponse(other.host, real, "video/mp4", {}, null),
    ).toBeNull();
    expect(other.closed()).toBe(true);
    const big = streamHost({ real, size: 101 }, [], 101);
    expect(
      await openHostFileRange(big.host, real, {
        offset: 0,
        length: 101,
        sizeMax: 100,
        timeoutMs: 1000,
      }).then(
        () => "opened",
        (error: HostFileReadError) => error.code,
      ),
    ).toBe("too_large");
  });

  it("closes the runner's stream when the client goes away", async () => {
    const h = streamHost(
      { real, size: 30 },
      [
        Buffer.from("0123456789"),
        Buffer.from("0123456789"),
        Buffer.from("0123456789"),
      ],
      30,
    );
    const response = await hostFileResponse(
      h.host,
      real,
      "video/mp4",
      {},
      null,
    );
    const reader = response!.body!.getReader();
    await reader.read();
    expect(h.closed()).toBe(false);
    await reader.cancel();
    expect(h.closed()).toBe(true);
  });

  it("refuses an upload whose real path, as the runner reports it, is a sensitive file", async () => {
    const asked = "/member/notes.txt";
    const sensitive = streamHost(
      { real: "/member/private.key", size: 3 },
      [Buffer.from("abc")],
      3,
    );
    expect(
      await openBrowserUpload(asked, sensitive.host).then(
        () => "opened",
        (error: unknown) => error instanceof BrowserUploadError,
      ),
    ).toBe(true);
    expect(sensitive.closed()).toBe(true);
    // The control: the same file under a plain real path opens, whole.
    const plain = streamHost(
      { real: "/member/notes.txt", size: 3 },
      [Buffer.from("abc")],
      3,
    );
    const opened = await openBrowserUpload(asked, plain.host);
    const parts: Buffer[] = [];
    for await (const chunk of opened.chunks()) parts.push(Buffer.from(chunk));
    await opened.close();
    expect(Buffer.concat(parts).toString()).toBe("abc");
  });
});

// A host whose runner is not connected: each surface refuses, and the office
// never reads or writes the file in its place. The file is the office's own
// and readable to this process, so a read as the office would succeed.
describe("a member whose runner is not ready", () => {
  const notReady = () =>
    createNotReadyHost(
      "member-files-test",
      "the member's OS user is not ready",
    );
  const OFFICE_TEXT = "office-only-content";
  let path: string;
  beforeEach(() => {
    path = join(dir, "office.txt");
    writeFileSync(path, OFFICE_TEXT);
  });

  it("refuses the probes, the editor open and save, and the reads", async () => {
    // The condition: the office host reads this file.
    expect([
      (await probeReadFile(path, dir, localAgentHost)).ok,
      (await probeEditFile(path, dir, localAgentHost)).ok,
      (await openFile(path, localAgentHost)).kind,
      (await readHostFile(localAgentHost, path, 100)).ok,
    ]).toEqual([true, true, "ok", true]);

    const host = notReady();
    expect((await probeReadFile(path, dir, host)).ok).toBe(false);
    expect((await probeEditFile(path, dir, host)).ok).toBe(false);
    expect((await openFile(path, host)).kind).toBe("io_error");
    const saved = await saveFile(path, "member text", 0, undefined, true, host);
    expect([saved.kind, readFileSync(path, "utf8")]).toEqual([
      "io_error",
      OFFICE_TEXT,
    ]);
    expect((await readHostFile(host, path, 100)).ok).toBe(false);
    expect(
      await hostFileResponse(host, path, "text/plain", {}, null),
    ).toBeNull();
    expect(
      await openBrowserUpload(path, host).then(
        () => "opened",
        (error: unknown) => error instanceof BrowserUploadError,
      ),
    ).toBe(true);
  });

  it("ends the editor's watch with failed, with no rejection that escapes", async () => {
    const events: WatchFileEvent[] = [];
    const watcher = watchFile(
      path,
      (ev) => events.push(ev),
      "baseline",
      notReady(),
    );
    try {
      const deadline = Date.now() + 3000;
      while (events.length === 0 && Date.now() < deadline) await Bun.sleep(50);
    } finally {
      stopWatch(watcher);
    }
    expect(events).toEqual([{ kind: "failed" }]);
  }, 6000);
});

describe("a member's paths", () => {
  // A runner host that reads this process's file system.
  const memberHost = (home: string, member = "member-files-test") =>
    ({
      ...localAgentHost,
      kind: "runner",
      member,
      home: () => home,
      fs: localAgentFs,
    }) as unknown as AgentHost;

  it("resolves ~ to the member's home, not the office user's", async () => {
    const home = join(dir, "member-home");
    mkdirSync(home);
    writeFileSync(join(home, "notes.txt"), "mine");
    const probe = await probeReadFile("~/notes.txt", "/", memberHost(home));
    expect(probe).toMatchObject({ ok: true, path: join(home, "notes.txt") });
  });

  it("keeps one revision per host for the same path", async () => {
    writeFileSync(join(dir, "same.txt"), "x");
    const path = join(dir, "same.txt");
    const rev = async (host: AgentHost) => {
      const opened = await openFile(path, host);
      if (opened.kind !== "ok") throw new Error(opened.kind);
      return opened.rev;
    };
    const office = await rev(localAgentHost);
    const member = await rev(memberHost(dir));
    // The condition: a second open of an unchanged file keeps its revision.
    expect(await rev(memberHost(dir))).toBe(member);
    expect(await rev(localAgentHost)).toBe(office);
    expect(member).not.toBe(office);
  });
});
