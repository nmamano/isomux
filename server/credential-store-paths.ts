// The directories that hold member and office credentials as plain text: the
// secret store, the managed variable files and the MCP server registrations,
// whose URLs can carry a token. Routes that read or write a
// file by path (the editor, read-file, validate.env) and the agents' safety
// hooks refuse them.
//
// This is accident protection, not a boundary: an agent or a terminal that
// reads these files on purpose, as the server's OS user, still can
// (internal-docs/secrets-design.md, section 4).

import { realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";

import { STATE_ROOT } from "./config.ts";

const STORE_DIRS = [
  "secrets",
  "user-env",
  "office-env",
  "mcp-servers",
] as const;

// The error text of a route that refuses such a path.
export const CREDENTIAL_PATH_MESSAGE =
  "This file holds credentials, so Isomux does not open it here.";

// The real path of the deepest part that exists, with the rest appended, so a
// symlink anywhere above a file that does not exist yet is still resolved.
export function realOrNearest(path: string): string {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

// True when an absolute path names one of the credential directories or a
// file below it, before or after symlinks are resolved. A relative path is
// never one: callers resolve it against their own cwd first.
export function isCredentialStorePath(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const literal = resolve(path);
  const real = realOrNearest(literal);
  const stateRoot = resolve(STATE_ROOT);
  const roots = [stateRoot, realOrNearest(stateRoot)];
  return [literal, real].some((candidate) =>
    roots.some((root) =>
      STORE_DIRS.some((dir) => isAtOrBelow(candidate, join(root, dir))),
    ),
  );
}
