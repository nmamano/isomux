// The office's own link to an agent's engine session (task 3a2de351):
// keepSessionFiles gives the store the session's current files and keeps
// only that session per agent; prepareResume puts back what the engine lost
// and touches every file so the engine's sweep does not take it again.
// Real files in a temp tree; copy mode is forced by a link that fails with
// EXDEV, as across file systems.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { afterEach, describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  keepSessionFiles,
  prepareResume,
  removeSessionStore,
  type StoreFs,
} from "./engine-session-store.ts";

const SID = "5e55a7f0-0000-4000-8000-000000000001";
const AGENT = "agent-store-test";
const ENTRIES = [
  `${SID}.jsonl`,
  `${SID}.ccr-tip.json`,
  `${SID}.precompact.json`,
  `${SID}/`,
];
// The files the engine has in these tests: one listed side file is absent.
const FILES = [
  `${SID}.jsonl`,
  `${SID}.precompact.json`,
  `${SID}/subagents/agent-a.jsonl`,
  `${SID}/tool-results/t1.txt`,
];
const DAY_MS = 24 * 60 * 60 * 1000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree() {
  const base = mkdtempSync(join(tmpdir(), "engine-session-store-"));
  dirs.push(base);
  const root = join(base, "projects", "-work");
  const agentRoot = join(base, "agent-root");
  const agentStore = join(agentRoot, "engine-sessions", AGENT);
  const store = join(agentStore, SID);
  mkdirSync(root, { recursive: true });
  return { base, root, agentRoot, agentStore, store };
}

function put(path: string, text: string, ageDays = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (ageDays > 0) {
    const t = new Date(Date.now() - ageDays * DAY_MS);
    utimesSync(path, t, t);
  }
}

function engineFiles(root: string, ageDays = 0): void {
  for (const f of FILES)
    put(join(root, f), `content of ${f}\n`.repeat(4), ageDays);
}

// Replace a file by rename, as an engine rewrite does: a new inode.
function replaceByRename(path: string, text: string): void {
  const tmp = `${path}.tmp-test`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const ino = (p: string) => statSync(p).ino;
const fresh = (p: string) => statSync(p).mtimeMs > Date.now() - 60_000;

// A fs whose link fails as across file systems; counts copies.
function crossDevice(): StoreFs & { copies: () => number } {
  let copies = 0;
  return {
    ...nodeFs,
    linkSync: () => {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
        code: "EXDEV",
      });
    },
    copyFileSync: ((
      src: nodeFs.PathLike,
      dest: nodeFs.PathLike,
      mode?: number,
    ) => {
      copies++;
      nodeFs.copyFileSync(src, dest, mode);
    }) as StoreFs["copyFileSync"],
    copies: () => copies,
  };
}

const keep = (
  t: ReturnType<typeof tree>,
  fs?: StoreFs,
  sessionId = SID,
  entries = ENTRIES,
) =>
  keepSessionFiles(
    { root: t.root, entries, agentStore: t.agentStore, sessionId },
    fs,
  );

describe("keepSessionFiles", () => {
  // MUTANTS: entries "<id>/" not walked (the subagent and tool result files
  // are missing); a copy in place of a link (another inode); a listed file
  // that does not exist written as an empty file in the store.
  it("links each file of the session into the store, in the engine's layout, and skips a listed file that does not exist", () => {
    const t = tree();
    engineFiles(t.root);
    const result = keep(t);
    expect(result.kept).toBe(FILES.length);
    for (const f of FILES)
      expect([f, ino(join(t.store, f))]).toEqual([f, ino(join(t.root, f))]);
    expect(existsSync(join(t.store, `${SID}.ccr-tip.json`))).toBe(false);
    // An append through the engine's name shows in the store.
    appendFileSync(join(t.root, `${SID}.jsonl`), "a new line\n");
    expect(readFileSync(join(t.store, `${SID}.jsonl`), "utf8")).toEndWith(
      "a new line\n",
    );
    // Nothing changed: nothing is linked again.
    expect(keep(t).kept).toBe(0);
  });

  // MUTANT: keep removes a store file whose engine file is gone (mirrors
  // the engine side).
  it("keeps a store file whose engine file is gone", () => {
    const t = tree();
    engineFiles(t.root);
    keep(t);
    unlinkSync(join(t.root, `${SID}.jsonl`));
    rmSync(join(t.root, SID), { recursive: true });
    expect(keep(t).kept).toBe(0);
    for (const f of FILES)
      expect([f, readFileSync(join(t.store, f), "utf8")]).toEqual([
        f,
        `content of ${f}\n`.repeat(4),
      ]);
  });

  // MUTANTS: the sibling sweep skipped (an old session's folder stays); the
  // sweep run over engine-sessions/ instead of engine-sessions/<agentId>/
  // (another agent's folder goes too); the current session's folder swept.
  it("keeps one session per agent: removes the agent's other session folders, never another agent's", () => {
    const t = tree();
    const oldSession = join(
      t.agentStore,
      "0ld5e551-0000-4000-8000-000000000000",
    );
    const otherAgent = join(t.agentRoot, "engine-sessions", "agent-other", "x");
    put(join(oldSession, "old.jsonl"), "old\n");
    put(join(otherAgent, "x.jsonl"), "other\n");
    engineFiles(t.root);
    keep(t);
    expect(existsSync(oldSession)).toBe(false);
    expect(existsSync(join(otherAgent, "x.jsonl"))).toBe(true);
    expect(existsSync(join(t.store, `${SID}.jsonl`))).toBe(true);
  });

  // The walk stays inside the session's own folder (never a scan of the
  // engine's tree) and keeps regular files only.
  // MUTANT: the walk uses stat in place of lstat (follows the links).
  it("does not follow a symbolic link under the session's folder", () => {
    const t = tree();
    engineFiles(t.root);
    const outside = join(t.base, "outside");
    put(join(outside, "secret.jsonl"), "not the session's\n");
    symlinkSync(outside, join(t.root, SID, "linked-dir"));
    symlinkSync(
      join(outside, "secret.jsonl"),
      join(t.root, SID, "linked-file.jsonl"),
    );
    keep(t);
    expect(existsSync(join(t.store, SID, "linked-dir"))).toBe(false);
    expect(existsSync(join(t.store, SID, "linked-file.jsonl"))).toBe(false);
    expect(existsSync(join(t.store, SID, "subagents", "agent-a.jsonl"))).toBe(
      true,
    );
  });

  for (const mode of ["link", "copy"] as const) {
    const fsFor = () => (mode === "copy" ? crossDevice() : undefined);

    // The store follows the engine's current file, whatever its size.
    // Claude Code 2.1.322 rewrites a transcript of 5 MB or more by rename
    // into a SMALLER one (performCompactTranscript, after a compaction and
    // as a local GC backstop); a store that kept the older file would miss
    // every later turn. A transcript swept under a live process comes back
    // as a fragment, also smaller: what keeps that from happening is the
    // touch before each resume (prepareResume), not keep.
    // MUTANTS: in link mode, a store file whose (dev, ino) differs from the
    // engine file is left as it is; any size guard or hold (the smaller
    // rewrite is not followed).
    it(`follows an engine file the engine replaced, larger or smaller (${mode})`, () => {
      const t = tree();
      engineFiles(t.root);
      const fs = fsFor();
      keep(t, fs);
      const path = `${SID}.jsonl`;
      const grown =
        readFileSync(join(t.root, path), "utf8") + "rewritten tail\n";
      replaceByRename(join(t.root, path), grown);
      expect(keep(t, fs).kept).toBe(1);
      expect(readFileSync(join(t.store, path), "utf8")).toBe(grown);
      if (mode === "link")
        expect(ino(join(t.store, path))).toBe(ino(join(t.root, path)));
      replaceByRename(join(t.root, path), "compacted\n");
      expect(keep(t, fs).kept).toBe(1);
      expect(readFileSync(join(t.store, path), "utf8")).toBe("compacted\n");
      if (mode === "link")
        expect(ino(join(t.store, path))).toBe(ino(join(t.root, path)));
    });
  }

  // Across file systems the store holds copies. MUTANTS: the copy keeps its
  // own mtime (every keep copies again); the change test by inode in copy
  // mode (every keep copies again); no copy after the engine file grew.
  it("copies across file systems, and copies again only a file whose size or mtime changed", () => {
    const t = tree();
    engineFiles(t.root);
    const fs = crossDevice();
    expect(keep(t, fs).kept).toBe(FILES.length);
    expect(fs.copies()).toBe(FILES.length);
    for (const f of FILES) {
      expect([f, readFileSync(join(t.store, f), "utf8")]).toEqual([
        f,
        readFileSync(join(t.root, f), "utf8"),
      ]);
      expect([f, statSync(join(t.store, f)).mtimeMs]).toEqual([
        f,
        statSync(join(t.root, f)).mtimeMs,
      ]);
    }
    expect(keep(t, fs).kept).toBe(0);
    expect(fs.copies()).toBe(FILES.length);
    appendFileSync(join(t.root, `${SID}.jsonl`), "turn 2\n");
    expect(keep(t, fs).kept).toBe(1);
    expect(fs.copies()).toBe(FILES.length + 1);
    expect(readFileSync(join(t.store, `${SID}.jsonl`), "utf8")).toEndWith(
      "turn 2\n",
    );
  });
});

describe("prepareResume", () => {
  // MUTANTS: only the transcript restored (the session's folder stays
  // empty); a copy in place of a link (the store stops seeing the engine's
  // appends); the restored file keeps its old mtime (the engine's sweep
  // takes it again at once).
  it("links back every file the engine lost, with a fresh mtime", () => {
    const t = tree();
    engineFiles(t.root, 40);
    keep(t);
    rmSync(t.root, { recursive: true });
    const result = prepareResume({
      root: t.root,
      entries: ENTRIES,
      store: t.store,
    });
    expect(result.restored).toBe(FILES.length);
    for (const f of FILES) {
      expect([f, ino(join(t.root, f))]).toEqual([f, ino(join(t.store, f))]);
      expect([f, fresh(join(t.root, f))]).toEqual([f, true]);
    }
  });

  // MUTANT: restore writes over an engine file that exists (the engine's
  // current state, or a fragment, is replaced).
  it("never replaces an engine file, and touches it", () => {
    const t = tree();
    engineFiles(t.root);
    keep(t);
    const path = join(t.root, `${SID}.jsonl`);
    replaceByRename(path, "the engine's own state\n");
    const t40 = new Date(Date.now() - 40 * DAY_MS);
    utimesSync(path, t40, t40);
    const result = prepareResume({
      root: t.root,
      entries: ENTRIES,
      store: t.store,
    });
    expect(result.restored).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("the engine's own state\n");
    expect(fresh(path)).toBe(true);
  });

  // A resume with no store (a schedule run) still gets the touch.
  // MUTANTS: the touch skipped when store is null; only the transcript
  // touched (Claude judges the session's folder on its own newest mtime).
  it("touches every file of the session when it has no store", () => {
    const t = tree();
    engineFiles(t.root, 40);
    const result = prepareResume({
      root: t.root,
      entries: ENTRIES,
      store: null,
    });
    expect(result).toEqual({ restored: 0, touched: FILES.length });
    for (const f of FILES)
      expect([f, fresh(join(t.root, f))]).toEqual([f, true]);
  });

  // MUTANT: no EXDEV fallback in restore (nothing is restored).
  it("copies a file back across file systems", () => {
    const t = tree();
    engineFiles(t.root);
    keep(t);
    unlinkSync(join(t.root, `${SID}.jsonl`));
    const result = prepareResume(
      { root: t.root, entries: ENTRIES, store: t.store },
      crossDevice(),
    );
    expect(result.restored).toBe(1);
    expect(readFileSync(join(t.root, `${SID}.jsonl`), "utf8")).toBe(
      readFileSync(join(t.store, `${SID}.jsonl`), "utf8"),
    );
  });

  // The engine gives its own verdict when the step cannot help.
  // MUTANT: an error from the fs escapes prepareResume.
  it("never throws", () => {
    const t = tree();
    engineFiles(t.root);
    keep(t);
    unlinkSync(join(t.root, `${SID}.jsonl`));
    const broken: StoreFs = {
      ...nodeFs,
      utimesSync: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
      linkSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    expect(
      prepareResume({ root: t.root, entries: ENTRIES, store: t.store }, broken)
        .restored,
    ).toBe(0);
    const gone = join(t.base, "no-such-root");
    expect(
      prepareResume({
        root: gone,
        entries: ENTRIES,
        store: join(gone, "store"),
      }),
    ).toEqual({
      restored: 0,
      touched: 0,
    });
  });
});

describe("removeSessionStore", () => {
  // MUTANT: removes engine-sessions/<agentId>/ (the agent's other session
  // folder goes too).
  it("removes one session's folder, and nothing else", () => {
    const t = tree();
    engineFiles(t.root);
    keep(t);
    const sibling = join(
      t.agentStore,
      "51b11n90-0000-4000-8000-000000000000",
      "s.jsonl",
    );
    put(sibling, "s\n");
    removeSessionStore(t.agentRoot, AGENT, SID);
    expect(existsSync(t.store)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    // The engine's own files are not touched.
    expect(existsSync(join(t.root, `${SID}.jsonl`))).toBe(true);
  });
});
