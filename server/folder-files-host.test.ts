// The folder file tools run outside the server's event loop (task 25015e41):
// a child of the server in local mode, the agent runner's folder-files entry
// in split mode. A call that runs too long answers with an error by its
// deadline, and the server keeps serving meanwhile.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getAgentHost,
  localAgentHost,
  setAgentHost,
  type AgentHost,
} from "./agent-host.ts";
import { runFolderFiles } from "./folder-files-host.ts";
import type { FolderFilesRequest } from "./folder-files.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => setAgentHost(localAgentHost));

function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folder-files-host-")));
  made.push(dir);
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "alpha-25015e41\n");
  // Lines on which a backtracking regex engine gives up only after its own
  // limit: about a second each in Bun 1.4, so eight seconds for the file.
  writeFileSync(join(dir, "sub", "trap.txt"), `${"a".repeat(48)}!\n`.repeat(8));
  return dir;
}

// The children of this process whose command line names the entry.
function entryChildren(): number[] {
  const pids: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (ppid === process.pid && cmd.includes("folder-files"))
        pids.push(Number(name));
    } catch {
      // gone meanwhile
    }
  }
  return pids;
}

// Runs `work` while a 20 ms interval ticks, and returns the longest gap
// between two ticks, or from the last tick to the end: how long the event
// loop was blocked, also when it was blocked until the work ended.
async function longestStall<T>(
  work: () => Promise<T>,
): Promise<{ value: T; stallMs: number; ms: number }> {
  let last = performance.now();
  let stallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
  }, 20);
  const started = performance.now();
  try {
    const value = await work();
    const end = performance.now();
    stallMs = Math.max(stallMs, end - last);
    return { value, stallMs, ms: end - started };
  } finally {
    clearInterval(timer);
  }
}

describe("runFolderFiles in local mode", () => {
  it("answers a call from a child process", async () => {
    const dir = folder();
    const result = await runFolderFiles({
      tool: "read_file",
      args: { file_path: "a.txt" },
      folder: dir,
      access: "folder",
    });
    expect(result).toMatchObject({ ok: true });
    expect((result as { text: string }).text).toContain("alpha-25015e41");
  }, 15_000);

  it("a regex that never ends stops at the deadline, the server keeps serving, and no child is left", async () => {
    const dir = folder();
    const req: FolderFilesRequest = {
      tool: "grep_files",
      args: { pattern: "^(a+)+$", path: "sub" },
      folder: dir,
      access: "folder",
    };
    const DEADLINE = 1_500;
    const run = await longestStall(() => runFolderFiles(req, DEADLINE));
    // A linear-time engine may answer with no match: either way it answers
    // by the deadline.
    expect(run.value).toHaveProperty("ok");
    expect(run.stallMs).toBeLessThan(500);
    expect(run.ms).toBeLessThan(DEADLINE + 2_000);
    await Bun.sleep(200);
    expect(entryChildren()).toEqual([]);
  }, 15_000);
});

describe("runFolderFiles in split mode", () => {
  const req: FolderFilesRequest = {
    tool: "list_dir",
    args: { dir_path: "." },
    folder: "/srv/agent-folder",
    access: "web",
  };

  function runner(runEntry: AgentHost["runEntry"]): unknown[][] {
    const calls: unknown[][] = [];
    setAgentHost({
      ...getAgentHost(),
      kind: "runner",
      runEntry: (...args: Parameters<AgentHost["runEntry"]>) => {
        calls.push(args);
        return runEntry(...args);
      },
    });
    return calls;
  }

  it("runs the call as the runner's folder-files entry", async () => {
    const calls = runner(async () => ({ ok: true, text: "sub/" }));
    expect(await runFolderFiles(req)).toEqual({ ok: true, text: "sub/" });
    expect(calls.map((c) => [c[0], c[1]])).toEqual([["folder-files", req]]);
  });

  it("answers with an error by the deadline when the runner does not, or answers in another shape", async () => {
    runner(() => new Promise(() => {}));
    const started = performance.now();
    const late = await runFolderFiles(req, 300);
    expect(late).toMatchObject({ ok: false });
    expect(performance.now() - started).toBeLessThan(2_000);

    for (const answer of [null, "sub/", { ok: true }, { text: "x" }]) {
      runner(async () => answer);
      const result = await runFolderFiles(req);
      expect({ answer, ok: result.ok }).toEqual({ answer, ok: false });
    }
    runner(() => Promise.reject(new Error("runner gone")));
    expect(await runFolderFiles(req)).toMatchObject({ ok: false });
  });
});
