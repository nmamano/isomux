// The app's revision for the widget's reload after a change (task d7ac4f73).
// The widget reloads its frame when the revision moved across the target
// agent's turn and the app serves again. A change is either a file in the
// app's folder or a restart through the office; a restart from outside the
// office with no file change does not move it.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppRecord } from "../shared/types.ts";

// Dependencies and VCS data are not the app's own files. Dot entries are
// skipped as well (caches, editor state).
const SKIPPED = new Set(["node_modules"]);
// A cap hit still returns a stamp, of the entries seen: a change past the cap
// does not move it.
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 8;
const PROBE_TIMEOUT_MS = 300;

// In memory: an office restart clears it, and the widget then reads a new
// revision once, which is harmless.
const restartSeq = new Map<string, number>();

// Called by the office's own start and restart paths.
export function bumpAppRestartSeq(name: string): void {
  restartSeq.set(name, (restartSeq.get(name) ?? 0) + 1);
}

// Reload requests for open app widgets: the reload route, and every office
// verb that runs a new process. A time, not a counter, so the null after an
// office restart reads as "no request" and never as a new one.
const reloadRequests = new Map<string, number>();

export function requestAppReload(name: string): void {
  reloadRequests.set(
    name,
    Math.max(Date.now(), (reloadRequests.get(name) ?? 0) + 1),
  );
}

export function appReloadRequestedAt(name: string): number | null {
  return reloadRequests.get(name) ?? null;
}

// A stamp of the restart sequence and the app's files: the count of entries,
// and the latest mtime of the files and folders. A new or deleted file changes
// the count or its folder's mtime; an edit changes the file's mtime. null when
// the folder could not be read.
export async function appFilesRevision(app: AppRecord): Promise<string | null> {
  let count = 0;
  let latest = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= MAX_ENTRIES) return;
      if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
      // Dirent never follows a symlink, so a link is neither walked nor
      // stamped: what it points at is not the app's own folder.
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (path === app.dataDir) continue;
      if (!entry.isFile() && !entry.isDirectory()) continue;
      count++;
      try {
        latest = Math.max(latest, (await lstat(path)).mtimeMs);
      } catch {
        // Removed during the walk: the next read sees the change.
        continue;
      }
      if (entry.isDirectory() && depth < MAX_DEPTH) {
        try {
          await walk(path, depth + 1);
        } catch {
          // An unreadable subfolder: stamp what can be read.
        }
      }
    }
  };
  try {
    latest = (await lstat(app.cwd)).mtimeMs;
    await walk(app.cwd, 1);
  } catch {
    return null;
  }
  return `${restartSeq.get(app.name) ?? 0}:${count}:${latest}`;
}

// The app runs and 127.0.0.1:<port> accepts a connection. The proxy connects
// there for every supervisor, so this is the answer the frame will get.
export async function appServing(
  app: AppRecord,
  running: boolean,
): Promise<boolean> {
  if (!running) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
    Bun.connect({
      hostname: "127.0.0.1",
      port: app.port,
      socket: {
        open(socket) {
          socket.end();
          settle(true);
        },
        data() {},
        connectError() {
          settle(false);
        },
        error() {
          settle(false);
        },
      },
    }).catch(() => settle(false));
  });
}
