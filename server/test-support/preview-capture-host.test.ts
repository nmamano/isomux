// Preview capture for an isolated member's agent (task b94dfd25 part 2b-iii):
// capturePreviewOnHost with a stand-in member host. The stand-in runs the
// real local spawn, run and file calls in a temp agent root, and records each
// call, so the tests see what went through the host. The "browser" is a fake
// shell script; the pre-flight is the stand-in's runEntry answer.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  failedAgentChild,
  localAgentFs,
  localAgentHost,
  type AgentFileStat,
  type AgentHost,
} from "../agent-host.ts";
import { NOT_READY_PATH } from "../member-hosts.ts";
import {
  capturePreview,
  capturePreviewOnHost,
  startPage,
  type PreviewResult,
} from "../preview-capture.ts";
import {
  checkUrlProbeInput,
  parseUrlProbeReply,
  URL_PROBE_ERROR_MAX,
} from "../preview-probe.ts";

let scripts: string;
let handoff: string;

function script(name: string, body: string): string {
  const p = join(scripts, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// The --screenshot path, and the start page (the last argument).
const ARGS = `out=""; start=""
for a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}";; esac; start="$a"; done
page="\${start#file://}"`;
// A png that isCompletePng accepts: signature, body, IEND trailer.
const PNG_HEAD = `printf '\\211PNG\\r\\n\\032\\n' > "$out"; printf 'IHDRfakepixels' >> "$out"`;
const PNG_END = `printf '\\0\\0\\0\\0IEND\\256B\\140\\202' >> "$out"`;
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("IHDRfakepixels"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("IEND"),
  Buffer.from([0xae, 0x42, 0x60, 0x82]),
]);

let hangingBrowser: string; // copies the start page out, writes a png, hangs
let quickBrowser: string; // writes a png and exits 0 at once
let partialBrowser: string; // writes an incomplete png and sleeps
let slowBrowser: string; // writes nothing, sleeps

beforeAll(() => {
  scripts = mkdtempSync(join(tmpdir(), "preview-host-scripts-"));
  handoff = mkdtempSync(join(tmpdir(), "preview-host-handoff-"));
  hangingBrowser = script(
    "hanging.sh",
    `${ARGS}
cp "$page" "${handoff}/page.html"; stat -c %a "$page" > "${handoff}/page.mode"
${PNG_HEAD}; ${PNG_END}
sleep 600`,
  );
  quickBrowser = script("quick.sh", `${ARGS}\n${PNG_HEAD}; ${PNG_END}`);
  partialBrowser = script("partial.sh", `${ARGS}\n${PNG_HEAD}\nsleep 600`);
  slowBrowser = script("slow.sh", "sleep 600");
});

afterAll(() => {
  rmSync(scripts, { recursive: true, force: true });
  rmSync(handoff, { recursive: true, force: true });
});

interface StandIn {
  host: AgentHost;
  root: string;
  ops: string[];
  probes: unknown[];
  spawned: string[][];
  runs: string[][];
  signals: string[];
  reads: () => number;
  // Calls of process.kill made outside the host's signalGroup.
  directKills: number[];
  // Per run call: whether a browser of this host was still running.
  aliveAtRun: boolean[];
  done: () => void;
}

function standIn(opts: {
  probe?: (input: unknown) => unknown;
  root?: string;
  stat?: (path: string) => AgentFileStat | null;
  spawnFails?: boolean;
}): StandIn {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "preview-host-root-"));
  const ops: string[] = [];
  const probes: unknown[] = [];
  const spawned: string[][] = [];
  const runs: string[][] = [];
  const signals: string[] = [];
  const directKills: number[] = [];
  const aliveAtRun: boolean[] = [];
  const children: { exitCode: number | null; signalCode: unknown }[] = [];
  let reads = 0;
  let inSignalGroup = false;
  const realKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (!inSignalGroup) directKills.push(pid);
    return realKill(pid, signal);
  }) as typeof process.kill;
  const host: AgentHost = {
    ...localAgentHost,
    kind: "runner",
    member: "rig-member",
    agentRoot: () => root,
    fs: {
      ...localAgentFs,
      stat: async (path) => {
        ops.push("stat");
        return opts.stat?.(path) ?? localAgentFs.stat(path);
      },
      readBytes: async (path, max) => {
        ops.push("readBytes");
        reads++;
        return localAgentFs.readBytes(path, max);
      },
      mkdir: async (path, mode) => {
        ops.push("mkdir");
        return localAgentFs.mkdir(path, mode);
      },
    },
    runEntry: async (name, input) => {
      ops.push(`runEntry:${name}`);
      probes.push(input);
      return (opts.probe ?? (() => ({ reachable: true })))(input);
    },
    spawnChild: (argv, options) => {
      ops.push("spawnChild");
      spawned.push(argv);
      if (opts.spawnFails)
        return failedAgentChild(
          Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
        );
      const child = localAgentHost.spawnChild(argv, options);
      children.push(child);
      const group = child.signalGroup.bind(child);
      child.signalGroup = (signal) => {
        signals.push(signal);
        inSignalGroup = true;
        try {
          group(signal);
        } finally {
          inSignalGroup = false;
        }
      };
      return child;
    },
    run: async (argv, options) => {
      ops.push("run");
      runs.push(argv);
      aliveAtRun.push(
        children.some((c) => c.exitCode === null && c.signalCode === null),
      );
      return localAgentHost.run(argv, options);
    },
  };
  return {
    host,
    root,
    ops,
    probes,
    spawned,
    runs,
    signals,
    reads: () => reads,
    directKills,
    aliveAtRun,
    done: () => {
      process.kill = realKill;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function expectFail(r: PreviewResult, code: string): string {
  if (r.ok) throw new Error(`expected ${code}, got ok`);
  expect(r.code).toBe(code as never);
  return r.error;
}

const previewDir = (s: StandIn) => join(s.root, "preview");
const leftovers = (s: StandIn) =>
  existsSync(previewDir(s)) ? readdirSync(previewDir(s)) : [];

const URL_WITH_TOKEN = "http://127.0.0.1:47111/page?token=rig-secret-token";

describe("a member's capture", () => {
  // MUTANTS: the page URL as the last argument again (dies on the argv
  // check); the start page written 0644 (dies on the mode); stop() with
  // process.kill(-pid) (dies on directKills); no removal of the folder (dies
  // on the leftovers).
  it("asks the member's runner, starts the browser at a 0600 start page, stops it through the host, and removes its folder", async () => {
    const s = standIn({});
    try {
      const r = await capturePreviewOnHost({ url: URL_WITH_TOKEN }, s.host, {
        findBrowser: () => hangingBrowser,
        pollMs: 10,
      });
      if (!r.ok) throw new Error(`capture failed: ${r.error}`);
      expect(Buffer.compare(r.png, PNG_BYTES)).toBe(0);
      expect(r.caption).toBe("http://127.0.0.1:47111/page");

      // The pre-flight went to the runner, before the browser.
      expect(s.ops.indexOf("runEntry:url-probe")).toBeGreaterThanOrEqual(0);
      expect(s.ops.indexOf("runEntry:url-probe")).toBeLessThan(
        s.ops.indexOf("spawnChild"),
      );
      const probe = s.probes[0] as { url: string; timeoutMs: number };
      expect(probe.url).toBe(URL_WITH_TOKEN);
      expect(probe.timeoutMs).toBeGreaterThan(0);
      expect(probe.timeoutMs).toBeLessThanOrEqual(2000);

      // argv names a start page in a fresh folder of the member's agent
      // space, and holds no part of the URL.
      const argv = s.spawned[0];
      expect(argv[0]).toBe(hangingBrowser);
      const start = argv.at(-1)!;
      expect(start).toMatch(
        new RegExp(`^file://${s.root}/preview/[0-9a-f]{16}/go\\.html$`),
      );
      for (const arg of argv) {
        expect(arg).not.toContain("47111");
        expect(arg).not.toContain("rig-secret-token");
      }
      expect(readFileSync(join(handoff, "page.mode"), "utf8").trim()).toBe(
        "600",
      );
      expect(readFileSync(join(handoff, "page.html"), "utf8")).toBe(
        startPage(URL_WITH_TOKEN),
      );

      // Stopped through the host only.
      expect(s.signals[0]).toBe("SIGTERM");
      expect(s.directKills).toEqual([]);

      // The folder is gone, removed through the host after the close.
      const dir = start.slice("file://".length, -"/go.html".length);
      expect(s.runs).toContainEqual(["rm", "-rf", "--", dir]);
      expect(leftovers(s)).toEqual([]);
    } finally {
      s.done();
    }
  });

  // MUTANT: no last read at the close (dies: "produced no screenshot").
  it("takes a screenshot that a browser wrote just before a clean exit", async () => {
    const s = standIn({});
    try {
      const r = await capturePreviewOnHost({ url: URL_WITH_TOKEN }, s.host, {
        findBrowser: () => quickBrowser,
        pollMs: 1000,
      });
      if (!r.ok) throw new Error(`capture failed: ${r.error}`);
      expect(Buffer.compare(r.png, PNG_BYTES)).toBe(0);
      expect(leftovers(s)).toEqual([]);
    } finally {
      s.done();
    }
  });

  // C1. The stand-in's stat shows a file that changes at each of the first
  // 30 polls and then holds, incomplete (the real file the browser wrote).
  // MUTANTS: seen < 2 dropped (a read at each poll while it changes); the
  // incomplete key not kept (a read at each poll once it holds).
  it("reads the file only once its state held for two polls, and never twice in the same state", async () => {
    let polls = 0;
    const s = standIn({
      stat: (path) => {
        if (!path.endsWith("shot.png")) return null;
        polls++;
        const size = polls <= 30 ? 1000 + polls : 5000;
        return { type: "file", size, mtimeMs: size, ino: 1 };
      },
    });
    try {
      const r = await capturePreviewOnHost({ url: URL_WITH_TOKEN }, s.host, {
        findBrowser: () => partialBrowser,
        pollMs: 10,
        deadlineMs: 900,
      });
      expectFail(r, "capture_timeout");
      // The enabling condition: the poll saw both phases.
      expect(polls).toBeGreaterThan(45);
      expect(s.reads()).toBe(1);
      expect(leftovers(s)).toEqual([]);
    } finally {
      s.done();
    }
  });

  // C1. MUTANT: no size check on the stat (dies: a read runs).
  it("fails a file over the cap from its stat, with no read", async () => {
    const s = standIn({
      stat: (path) =>
        path.endsWith("shot.png")
          ? { type: "file", size: 20 * 1024 * 1024 + 1, mtimeMs: 1, ino: 1 }
          : null,
    });
    try {
      const r = await capturePreviewOnHost({ url: URL_WITH_TOKEN }, s.host, {
        findBrowser: () => hangingBrowser,
        pollMs: 10,
        deadlineMs: 3000,
      });
      expect(expectFail(r, "capture_failed")).toContain("20.0 MB");
      expect(s.reads()).toBe(0);
      expect(s.signals[0]).toBe("SIGTERM");
      expect(leftovers(s)).toEqual([]);
    } finally {
      s.done();
    }
  });

  // P2. MUTANT: settle at the deadline, before the close (dies on
  // aliveAtRun).
  it("stops a browser at the deadline through the host, and removes the folder after it closed", async () => {
    const s = standIn({});
    try {
      const r = await capturePreviewOnHost({ url: URL_WITH_TOKEN }, s.host, {
        findBrowser: () => slowBrowser,
        pollMs: 10,
        deadlineMs: 300,
      });
      expectFail(r, "capture_timeout");
      expect(s.signals[0]).toBe("SIGTERM");
      expect(s.directKills).toEqual([]);
      expect(s.aliveAtRun).toEqual([false]);
      expect(leftovers(s)).toEqual([]);
    } finally {
      s.done();
    }
  });

  it("reports a browser that the member cannot start, and removes the folder", async () => {
    const s = standIn({ spawnFails: true });
    try {
      const r = await capturePreviewOnHost({ url: URL_WITH_TOKEN }, s.host, {
        findBrowser: () => hangingBrowser,
      });
      expect(expectFail(r, "capture_failed")).toContain("EACCES");
      expect(s.runs.length).toBe(1);
      expect(leftovers(s)).toEqual([]);
    } finally {
      s.done();
    }
  });
});

describe("a member's pre-flight", () => {
  // C4. A false answer carries its error; a throw or a bad shape gets the
  // fixed text and never the runner's words. In each case nothing starts and
  // no folder is made. MUTANT: the thrown message in the text (dies on the
  // throw row).
  for (const [why, probe, carries] of [
    [
      "an unreachable answer",
      () => ({ reachable: false, error: "connect ECONNREFUSED" }),
      "ECONNREFUSED",
    ],
    [
      "a runner that throws",
      () => {
        throw new Error("runner-words-123");
      },
      null,
    ],
    ["an answer out of shape", () => ({ reachable: true, extra: 1 }), null],
  ] as const)
    it(`fails ${why} as unreachable, before any folder or browser`, async () => {
      const s = standIn({ probe });
      try {
        const r = await capturePreviewOnHost({ url: URL_WITH_TOKEN }, s.host, {
          findBrowser: () => hangingBrowser,
        });
        const text = expectFail(r, "unreachable");
        if (carries) expect(text).toContain(carries);
        else expect(text).not.toContain("runner-words-123");
        expect(s.ops).toEqual(["runEntry:url-probe"]);
        expect(existsSync(previewDir(s))).toBe(false);
      } finally {
        s.done();
      }
    });

  // C3. MUTANT: the not-ready check removed (dies: the runner is asked).
  it("refuses a host that is not ready before any call to it", async () => {
    const s = standIn({ root: NOT_READY_PATH });
    try {
      const r = await capturePreviewOnHost({ url: URL_WITH_TOKEN }, s.host, {
        findBrowser: () => hangingBrowser,
      });
      expectFail(r, "capture_failed");
      expect(s.ops).toEqual([]);
    } finally {
      s.done();
    }
  });
});

describe("the url-probe messages", () => {
  it("takes exactly the two reply shapes", () => {
    expect(parseUrlProbeReply({ reachable: true })).toEqual({
      reachable: true,
    });
    const atBound = "e".repeat(URL_PROBE_ERROR_MAX);
    expect(parseUrlProbeReply({ reachable: false, error: atBound })).toEqual({
      reachable: false,
      error: atBound,
    });
  });

  // MUTANT per row: that check removed.
  for (const [why, reply] of [
    ["reachable true with an error", { reachable: true, error: "x" }],
    ["reachable false with no error", { reachable: false }],
    [
      "an error over the bound",
      { reachable: false, error: "e".repeat(URL_PROBE_ERROR_MAX + 1) },
    ],
    ["an error that is not a string", { reachable: false, error: ["x"] }],
    [
      "an error reply with another key",
      { reachable: false, error: "x", url: "y" },
    ],
    [
      "an error reply whose reachable is not false",
      { reachable: "false", error: "x" },
    ],
    ["reachable that is not a boolean", { reachable: "true" }],
    ["another key", { reachable: true, url: "x" }],
    ["an array", [{ reachable: true }]],
    ["null", null],
  ] as const)
    it(`refuses ${why}`, () => {
      expect(parseUrlProbeReply(reply)).toBeNull();
    });

  it("takes an http(s) url and a timeout in 1..2000 in the runner", () => {
    expect(
      checkUrlProbeInput({ url: "https://x.test/", timeoutMs: 2000 }),
    ).toEqual({
      url: "https://x.test/",
      timeoutMs: 2000,
    });
    for (const input of [
      { url: "file:///etc/passwd", timeoutMs: 100 },
      { url: "not a url", timeoutMs: 100 },
      { url: `https://x.test/${"a".repeat(2048)}`, timeoutMs: 100 },
      { url: "https://x.test/", timeoutMs: 0 },
      { url: "https://x.test/", timeoutMs: 2001 },
      { url: "https://x.test/", timeoutMs: 1.5 },
      null,
    ])
      expect(() => checkUrlProbeInput(input)).toThrow();
  });
});

describe("the start page", () => {
  // G1. MUTANT: no "<" escape (dies: a second "</script").
  it("holds the URL as one script string that no URL can end", () => {
    const url = 'http://x.test/a?q=</script><script>alert(1)</script>&b="c"';
    const page = startPage(url);
    expect(page.indexOf("</script")).toBe(page.lastIndexOf("</script"));
    const literal = /location\.replace\((.*)\)<\/script>$/.exec(page)?.[1];
    expect(JSON.parse(literal!)).toBe(url);
  });

  // G1 on the office branch. MUTANT: the office argv with the page URL
  // (dies on the argv check).
  it("is where the office's browser starts too, 0600, with no URL in argv", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "preview-host-office-"));
    const argvFile = join(handoff, "office-argv");
    const recorder = script(
      "office-recorder.sh",
      `printf '%s\\n' "$@" > "${argvFile}"
exec "${hangingBrowser}" "$@"`,
    );
    try {
      const r = await capturePreview(
        { url: URL_WITH_TOKEN },
        {
          findBrowser: () => recorder,
          fetchFn: (() =>
            Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
          tmpBase,
        },
      );
      if (!r.ok) throw new Error(`capture failed: ${r.error}`);
      const argv = readFileSync(argvFile, "utf8");
      expect(argv).toMatch(/file:\/\/.*\/go\.html/);
      expect(argv).not.toContain("47111");
      expect(argv).not.toContain("rig-secret-token");
      expect(readFileSync(join(handoff, "page.mode"), "utf8").trim()).toBe(
        "600",
      );
      expect(readFileSync(join(handoff, "page.html"), "utf8")).toBe(
        startPage(URL_WITH_TOKEN),
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
