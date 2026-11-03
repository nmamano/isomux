// The Bun path to write into anything that outlives this process (app unit
// PATH, the codex wrapper).
//
// process.execPath resolves a symlink, so a service started through a symlink
// into a versioned directory (Linuxbrew's bin/bun, a hand-made `ln -s`) would
// write that versioned directory, which goes at the next Bun upgrade. The
// path the process was started by survives it. process.argv0 keeps that path
// unresolved; it is used only when it resolves to the running binary, else
// execPath.

import { realpathSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";

export interface StableBunPathInput {
  argv0: string;
  execPath: string;
  envPath: string | undefined;
  cwd: string;
  // The resolved path, or null when it cannot be resolved.
  realpath: (path: string) => string | null;
}

// `bun run <script>` puts a temp directory of its own (bun-node-<hash>, with
// bun and node links to itself) first on the child's PATH when there is no
// node. It goes at reboot, so it is never the path to write.
const RUN_SCRIPT_SHIM_PREFIX = "bun-node-";

function compute(input: StableBunPathInput): string {
  const { argv0, execPath, envPath, cwd, realpath } = input;
  const running = realpath(execPath);
  if (!argv0 || running === null) return execPath;
  const runsThis = (path: string) => realpath(path) === running;

  if (argv0.includes("/")) {
    const candidate = resolve(cwd, argv0);
    return runsThis(candidate) ? candidate : execPath;
  }
  for (const dir of (envPath ?? "").split(":")) {
    if (!isAbsolute(dir)) continue;
    if (basename(dir).startsWith(RUN_SCRIPT_SHIM_PREFIX)) continue;
    const candidate = join(dir, argv0);
    if (runsThis(candidate)) return candidate;
  }
  return execPath;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

let memo: string | undefined;

// Without input: this process's value, computed once, so a relative argv0 is
// read against the start directory.
export function stableBunPath(input?: StableBunPathInput): string {
  if (input) return compute(input);
  memo ??= compute({
    argv0: process.argv0,
    execPath: process.execPath,
    envPath: process.env.PATH,
    cwd: process.cwd(),
    realpath: realpathOrNull,
  });
  return memo;
}
