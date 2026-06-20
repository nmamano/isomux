// Test-only guard against catastrophic deletes.
//
// The config-root seam (server/config.ts) lets tests point ISOMUX_HOME at a
// temp dir. This guard ensures the matching cleanup can only ever remove a dir
// that realpath-resolves strictly UNDER the OS temp dir, and can never remove
// the real ~/.isomux. A misconfigured test (ISOMUX_HOME unset, or pointed at a
// real directory) therefore fails loudly instead of wiping user state.
//
// Not imported by any production path.

import { homedir, tmpdir } from "os";
import { existsSync, realpathSync, rmSync } from "fs";
import { dirname, join, resolve, sep } from "path";

// Canonicalize a path that may not exist yet: realpath the nearest existing
// ancestor (resolving symlinks), then re-append the missing tail lexically.
// This makes the guard symlink-safe — a temp path that is itself a symlink into
// ~/.isomux resolves to its real target and is rejected — without requiring the
// target to exist (deleting an already-absent path is a no-op but must still
// validate, so `/tmpx/missing` cannot masquerade as being under `/tmp`).
export function canonicalize(target: string): string {
  const abs = resolve(target);
  let anc = abs;
  while (!existsSync(anc)) {
    const parent = dirname(anc);
    if (parent === anc) break; // reached the filesystem root
    anc = parent;
  }
  const realAnc = existsSync(anc) ? realpathSync(anc) : anc;
  const tail = abs.slice(anc.length); // "" when the whole path already existed
  return tail ? realAnc + tail : realAnc;
}

// Throw unless `target` is safe to recursively delete: it must realpath-resolve
// strictly under the OS temp dir AND must not be (or be under) the real
// ~/.isomux. The temp check is path-boundary aware (separator-delimited) so a
// sibling like `/tmpx` is never mistaken for being under `/tmp`.
export function assertSafeToDelete(target: string): void {
  const canonical = canonicalize(target);

  const realHomeIsomux = canonicalize(join(homedir(), ".isomux"));
  if (
    canonical === realHomeIsomux ||
    canonical.startsWith(realHomeIsomux + sep)
  ) {
    throw new Error(
      `Refusing to delete ${target}: it resolves to the real isomux state root (${realHomeIsomux}).`,
    );
  }

  const realTmp = canonicalize(tmpdir());
  if (!canonical.startsWith(realTmp + sep)) {
    throw new Error(
      `Refusing to delete ${target}: ${canonical} is not strictly under the OS temp dir (${realTmp}).`,
    );
  }
}

// Guarded recursive delete. No-op if the path is already gone.
export function removeStateDir(target: string): void {
  assertSafeToDelete(target);
  rmSync(target, { recursive: true, force: true });
}
