// POSIX ACLs for the split-mode trusted checks (server/split/trusted-checks.ts).
// Linux stores an ACL in the xattr system.posix_acl_access (and, on a
// directory, system.posix_acl_default): a u32 version (2), then 8-byte entries
// of u16 tag, u16 permission bits and u32 id, all little-endian.

import { dlopen, ptr, read } from "bun:ffi";

export const ACL_USER_OBJ = 0x01;
export const ACL_USER = 0x02;
export const ACL_GROUP_OBJ = 0x04;
export const ACL_GROUP = 0x08;
export const ACL_MASK = 0x10;
export const ACL_OTHER = 0x20;

export interface AclEntry {
  tag: number;
  perm: number;
  id: number;
}

const ACL_VERSION = 2;
const ENOTSUP = 95;

// Throws on anything that is not a well-formed version-2 ACL, so a caller
// fails closed.
export function parseAclXattr(data: Uint8Array): AclEntry[] {
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (view.length < 4 || (view.length - 4) % 8 !== 0)
    throw new Error("malformed ACL");
  if (view.readUInt32LE(0) !== ACL_VERSION)
    throw new Error("unknown ACL version");
  const entries: AclEntry[] = [];
  for (let at = 4; at < view.length; at += 8) {
    entries.push({
      tag: view.readUInt16LE(at),
      perm: view.readUInt16LE(at + 2) & 7,
      id: view.readUInt32LE(at + 4),
    });
  }
  return entries;
}

const SYMBOLS = {
  lgetxattr: { args: ["ptr", "ptr", "ptr", "u64"], returns: "i64" },
  llistxattr: { args: ["ptr", "ptr", "u64"], returns: "i64" },
  __errno_location: { args: [], returns: "ptr" },
} as const;

let libc: ReturnType<typeof dlopen<typeof SYMBOLS>> | null | undefined;

function loadLibc() {
  if (libc !== undefined) return libc;
  try {
    libc = dlopen("libc.so.6", SYMBOLS);
  } catch {
    libc = null;
  }
  return libc;
}

function cString(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf8");
}

// The ACL on path itself (a symlink is not followed), or null when it has
// none. Throws when the ACL cannot be read.
//
// The xattr names are listed first, so the common "no ACL" answer needs no
// errno: the runtime can change errno between two FFI calls. errno is read
// only when the list itself fails, to accept a file system without xattrs.
export function readAcl(
  path: string,
  kind: "access" | "default",
): AclEntry[] | null {
  const loaded = loadLibc();
  if (!loaded) throw new Error("cannot load libc to read ACLs");
  const nameText = `system.posix_acl_${kind}`;
  const file = cString(path);
  const names = new Uint8Array(64 * 1024);
  const listed = Number(
    loaded.symbols.llistxattr(ptr(file), ptr(names), names.byteLength),
  );
  if (listed < 0) {
    const errnoPtr = loaded.symbols.__errno_location();
    const errno = errnoPtr ? read.i32(errnoPtr, 0) : -1;
    if (errno === ENOTSUP) return null;
    throw new Error(`cannot list the xattrs of ${path} (errno ${errno})`);
  }
  const present = Buffer.from(names.subarray(0, listed))
    .toString("utf8")
    .split("\0")
    .includes(nameText);
  if (!present) return null;
  const buffer = new Uint8Array(4 + 8 * 1024);
  const size = Number(
    loaded.symbols.lgetxattr(
      ptr(file),
      ptr(cString(nameText)),
      ptr(buffer),
      buffer.byteLength,
    ),
  );
  if (size < 0) throw new Error(`cannot read the ACL of ${path}`);
  return parseAclXattr(buffer.subarray(0, size));
}
