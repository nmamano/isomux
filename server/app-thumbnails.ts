// App thumbnails: the picture an agent uploads for its app, shown on the Apps
// page (PUT/GET /api/apps/:name/thumbnail, server/routes/handlers/apps.ts).
//
// Stored under STATE_ROOT/apps/thumbnails, NOT in the app's data directory:
// the app's own process writes there, and an office origin must not serve a
// file the app can replace.
//
// ONE FILE PER (registration, version), never overwritten. The path is
// thumbnails/<name>/<registrationGen>-<version>, where version is the record's
// thumbnailUpdatedAt. So:
//   - the bytes behind an immutable ?v= URL never change: a new upload is a
//     new file, and a failed registry write removes only the new file;
//   - a re-registered name has a new registration generation, so it cannot
//     read, or be served, a file of the app that held the name before.

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { STATE_ROOT } from "./config.ts";

export const MAX_APP_THUMBNAIL_BYTES = 2 * 1024 * 1024;

export type AppThumbnailType = "image/png" | "image/jpeg" | "image/webp";

// The bytes decide the type; a Content-Type header is never consulted.
export function sniffAppThumbnailType(
  bytes: Uint8Array,
): AppThumbnailType | null {
  const at = (offset: number, sig: readonly number[]) =>
    bytes.length >= offset + sig.length &&
    sig.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // "RIFF" <4-byte size> "WEBP"
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  return null;
}

// Read a request body into memory, refusing more than `max` bytes. The stream
// is cancelled at the first byte over the cap, and no more than `max` bytes are
// ever kept, even when one delivered chunk is larger than the cap.
export async function readCappedBody(
  req: Request,
  max: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) {
    await req.body?.cancel().catch(() => {});
    return { ok: false };
  }
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const out = new Uint8Array(max);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true, bytes: out.slice(0, size) };
      if (size + value.byteLength > max) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      out.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

// Read a file named by the JSON path form of the upload, refusing more than
// `max` bytes. The open is nonblocking, so a FIFO cannot stall the server, and
// every check runs on that one descriptor: a non-regular file is refused, and a
// file that grows after the stat still cannot deliver more than `max` bytes.
export function readCappedFile(
  path: string,
  max: number,
): { ok: true; bytes: Uint8Array } | { ok: false } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return { ok: false };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return { ok: false };
    const out = Buffer.alloc(max + 1);
    let size = 0;
    for (;;) {
      const n = readSync(fd, out, size, out.length - size, null);
      if (n === 0) return { ok: true, bytes: out.subarray(0, size) };
      size += n;
      if (size > max) return { ok: false };
    }
  } catch {
    return { ok: false };
  } finally {
    closeSync(fd);
  }
}

export interface AppThumbnailStore {
  write(name: string, gen: number, version: number, bytes: Uint8Array): void;
  read(name: string, gen: number, version: number): Uint8Array | null;
  // Best effort, never throws.
  remove(name: string, gen: number, version: number): void;
  // Every file of one registration. Best effort, never throws.
  removeRegistration(name: string, gen: number): void;
}

// `name` is a registered app name (validated at registration against a grammar
// with no "/" or leading "."), so it is safe as a path component.
export function createAppThumbnailStore(
  dir: string = join(STATE_ROOT, "apps", "thumbnails"),
): AppThumbnailStore {
  const root = resolve(dir);
  const fileOf = (name: string, gen: number, version: number) =>
    join(root, name, `${gen}-${version}`);
  const forget = (path: string) => {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[app-thumbnails] failed to remove ${path}:`, err);
      }
    }
  };
  const pruneDir = (name: string) => {
    try {
      rmdirSync(join(root, name));
    } catch {
      // Not empty, or already gone: both are fine.
    }
  };
  return {
    write(name, gen, version, bytes) {
      const target = fileOf(name, gen, version);
      mkdirSync(join(root, name), { recursive: true });
      const tmp = `${target}.tmp`;
      try {
        writeFileSync(tmp, bytes);
        renameSync(tmp, target);
      } catch (err) {
        forget(tmp);
        throw err;
      }
    },
    read(name, gen, version) {
      try {
        return readFileSync(fileOf(name, gen, version));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    remove(name, gen, version) {
      forget(fileOf(name, gen, version));
      pruneDir(name);
    },
    removeRegistration(name, gen) {
      const dirOf = join(root, name);
      if (!existsSync(dirOf)) return;
      try {
        for (const entry of readdirSync(dirOf)) {
          if (entry.startsWith(`${gen}-`)) forget(join(dirOf, entry));
        }
      } catch (err) {
        console.error(`[app-thumbnails] failed to list ${dirOf}:`, err);
      }
      pruneDir(name);
    },
  };
}

export const appThumbnailStore = createAppThumbnailStore();
