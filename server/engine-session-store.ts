// The office's own link to each agent's conversation (task 3a2de351).
// An engine keeps the files an agent resumes from in its own folders and
// deletes them by its own rules (Claude Code: transcripts older than
// cleanupPeriodDays). Isomux keeps a second name of the current session's
// files, a hard link (a copy across file systems), in
//   <agent root>/engine-sessions/<agentId>/<sessionId>/
// with the layout the files have under the engine's root. Before each
// resume, a file the engine lost is linked back and every file of the
// session is touched, so the engine's sweep does not delete it again.
//
// No imports beyond node: the agent runner and the member runtime bundle run
// this file as the agent user or the member (entries engine-session-keep and
// engine-session-prepare, and the runner's spawn handler).

import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";

// The folder under an agent root that holds every agent's store.
export const ENGINE_SESSIONS_DIR = "engine-sessions";

// The files of one engine session: `entries` are relative to `root`; an
// entry that ends in "/" stands for every regular file under that folder.
// A listed file that does not exist is skipped.
export interface SessionFiles {
  root: string;
  entries: string[];
}

// What runs before an engine process resumes a session (prepareResume).
// `store`: this session's store folder, or null when the session has none
// (a schedule run): then only the touch runs.
export interface SessionFilesPrepare extends SessionFiles {
  store: string | null;
}

export interface KeepInput extends SessionFiles {
  // engine-sessions/<agentId>/ of the agent's host.
  agentStore: string;
  sessionId: string;
}

export interface KeepResult {
  // Files linked or copied into the store this time.
  kept: number;
}

export interface PrepareResult {
  // Files linked or copied back to the engine side.
  restored: number;
  // Engine files touched.
  touched: number;
}

// The node fs calls the store uses; tests replace some (a link that fails
// with EXDEV).
export type StoreFs = Pick<
  typeof nodeFs,
  | "linkSync"
  | "copyFileSync"
  | "renameSync"
  | "statSync"
  | "lstatSync"
  | "mkdirSync"
  | "readdirSync"
  | "utimesSync"
  | "rmSync"
  | "unlinkSync"
  | "existsSync"
>;

export function engineSessionsRoot(agentRoot: string): string {
  return join(agentRoot, ENGINE_SESSIONS_DIR);
}

export function agentStoreDir(agentRoot: string, agentId: string): string {
  return join(engineSessionsRoot(agentRoot), agentId);
}

export function sessionStoreDir(
  agentRoot: string,
  agentId: string,
  sessionId: string,
): string {
  return join(agentStoreDir(agentRoot, agentId), sessionId);
}

const errnoOf = (err: unknown): string | undefined =>
  (err as NodeJS.ErrnoException | null)?.code;

// The regular files of the session under `root`, relative to it: each file
// entry that exists, and every regular file under each folder entry. A
// symbolic link is never followed, so the walk stays in the session's own
// folder.
function sessionFileNames(
  root: string,
  entries: string[],
  fs: StoreFs,
): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith("/")) walk(root, entry.slice(0, -1), fs, names);
    else if (isRegularFile(join(root, entry), fs)) names.push(entry);
  }
  return names;
}

function walk(root: string, rel: string, fs: StoreFs, out: string[]): void {
  let children: nodeFs.Dirent[];
  try {
    children = fs.readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    const childRel = join(rel, child.name);
    if (child.isDirectory()) walk(root, childRel, fs, out);
    else if (child.isFile()) out.push(childRel);
  }
}

function isRegularFile(path: string, fs: StoreFs): boolean {
  try {
    return fs.lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function statOrNull(path: string, fs: StoreFs): nodeFs.Stats | null {
  try {
    return fs.lstatSync(path);
  } catch {
    return null;
  }
}

// Put `src` at `dest` under a second name: a hard link, or a copy with the
// source's mtime across file systems. Through a temp name and a rename, so
// a reader of `dest` never finds it missing or half written.
function placeAt(src: string, dest: string, fs: StoreFs): void {
  fs.mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.isomux-tmp-${process.pid}-${Date.now()}`;
  try {
    try {
      fs.linkSync(src, tmp);
    } catch (err) {
      if (errnoOf(err) !== "EXDEV") throw err;
      fs.copyFileSync(src, tmp);
      const st = fs.statSync(src);
      fs.utimesSync(tmp, st.atimeMs / 1000, st.mtimeMs / 1000);
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// Give the store the current files of the session, then remove the agent's
// other session folders (the store keeps one session per agent).
//
// A store file always follows the engine's current file: a new name when
// the engine replaced the file (another inode, or in copy mode another size
// or mtime), also by a smaller one. Claude Code rewrites a transcript of
// 5 MB or more through a temp file and a rename after a compaction, and the
// result is smaller (2.1.322, read 2026-11-21); a store that kept the older
// file would put back a stale conversation. prepareResume never writes over
// an engine file.
export function keepSessionFiles(
  input: KeepInput,
  fs: StoreFs = nodeFs,
): KeepResult {
  const store = join(input.agentStore, input.sessionId);
  const result: KeepResult = { kept: 0 };
  for (const name of sessionFileNames(input.root, input.entries, fs)) {
    const src = join(input.root, name);
    const dest = join(store, name);
    const engine = statOrNull(src, fs);
    if (!engine) continue;
    const kept = statOrNull(dest, fs);
    if (kept) {
      if (kept.dev === engine.dev && kept.ino === engine.ino) continue;
      if (kept.size === engine.size && kept.mtimeMs === engine.mtimeMs)
        continue;
    }
    placeAt(src, dest, fs);
    result.kept++;
  }
  let siblings: string[] = [];
  try {
    siblings = fs.readdirSync(input.agentStore);
  } catch {}
  for (const name of siblings)
    if (name !== input.sessionId)
      fs.rmSync(join(input.agentStore, name), { recursive: true, force: true });
  return result;
}

// Before an engine process resumes the session: link back each store file
// the engine side lacks, then touch every file of the session on the engine
// side (the engine's sweep judges each file, and Claude Code a session's
// folder by its newest file, by mtime). Never overwrites an engine file;
// never throws: the engine then gives its own verdict.
export function prepareResume(
  input: SessionFilesPrepare,
  fs: StoreFs = nodeFs,
): PrepareResult {
  const result: PrepareResult = { restored: 0, touched: 0 };
  if (input.store) {
    for (const name of sessionFileNames(input.store, input.entries, fs)) {
      const dest = join(input.root, name);
      if (statOrNull(dest, fs)) continue;
      try {
        placeAt(join(input.store, name), dest, fs);
        result.restored++;
      } catch (err) {
        console.error(
          `[engine-sessions] could not put back ${dest}: ${(err as Error).message}`,
        );
      }
    }
  }
  const now = Date.now() / 1000;
  for (const name of sessionFileNames(input.root, input.entries, fs)) {
    try {
      fs.utimesSync(join(input.root, name), now, now);
      result.touched++;
    } catch {}
  }
  return result;
}

// Remove one session's store folder (a prune of that session).
export function removeSessionStore(
  agentRoot: string,
  agentId: string,
  sessionId: string,
  fs: StoreFs = nodeFs,
): void {
  fs.rmSync(sessionStoreDir(agentRoot, agentId, sessionId), {
    recursive: true,
    force: true,
  });
}
