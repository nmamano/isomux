// Talking to flyctl without letting a credential out.
//
// Every rule here exists because of the two incidents behind the loop's secrets
// ruling:
//
//   NOTHING IS EXPANDED BY A SHELL. The API token is read inside this process
//   and handed to the child as an environment variable. It never appears in
//   argv - which the process table shows to every user on the box - and never
//   in a command line somebody might paste into a report.
//
//   THE CHILD'S OUTPUT IS CAPTURED, AND CAPTURED IS NOT PRINTED. flyctl's own
//   stdout and stderr are held in memory for scanning and are never forwarded.
//   That is a stronger rule than "scan and forward if clean", and deliberately
//   so: an exact-value scan cannot see a fragment, a re-encoding or a
//   truncation, so safety comes from not emitting the bytes at all rather than
//   from a scanner being complete.
//
// What callers may print is in `Outcome`: fixed names, booleans and an exit
// code. Diagnosing a flyctl failure means re-running it with a PUBLIC canary
// value, never with a real one.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The app this slice is allowed to touch. Every call carries it. */
export const APP = "isomux-provisioner";

export const FLYCTL = path.join(os.homedir(), ".fly", "bin", "flyctl");

const SECRETS_DIR = path.join(os.homedir(), "nil", "secrets");
export const FLY_TOKEN_FILE = path.join(SECRETS_DIR, "fly.token");
export const MINT_ENV_FILE = path.join(SECRETS_DIR, "control-plane-mint.env");

export interface SpawnResult {
  code: number;
  /** Held for scanning. NEVER printed, and never put in an error message. */
  stdout: string;
  stderr: string;
}

export type Spawn = (
  argv: string[],
  env: Record<string, string>,
  stdin: string,
) => Promise<SpawnResult>;

export const realSpawn: Spawn = async (argv, env, stdin) => {
  const child = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
};

/**
 * A secret file's contents, read here and returned to a caller that must not
 * print it.
 *
 * A missing file is a refusal with a fixed sentence: the path is ours and
 * naming it helps, but nothing derived from the contents is ever quoted.
 */
export function readSecretFile(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`missing or unreadable: ${file}`);
  }
  const value = raw.trim();
  if (value.length === 0) throw new Error(`empty: ${file}`);
  return value;
}

/**
 * The seam credential's file, checked against the shape it was promised to
 * have, by the process that is about to use it.
 *
 * "Somebody ran grep on it once" is not enforcement: the file can change, and
 * the consumer is the only place where the check happens at the moment it
 * matters. So every property is re-established here, and every one of them is
 * a REFUSAL rather than a warning:
 *
 *   regularFile  the file is OPENED ONCE with O_NOFOLLOW, and the checks and
 *                the read all go through that one descriptor. A symlink cannot
 *                be opened at all; more importantly, a path that is swapped
 *                between the check and the read cannot be reached, because
 *                after the open there is no path left to swap - only a file.
 *   mode600      the exact mode, not "no group or world bits". 0400 would pass
 *                a bitmask test and has to fail, so the permission is compared
 *                rather than sampled. Read from the DESCRIPTOR, not the path.
 *   shapeOk      the file's bytes are EXACTLY
 *                CONTROL_PLANE_MINT_TOKEN='<40 lowercase hex>' with at most the
 *                usual final newline. Not "one line after trimming": a leading
 *                space, a trailing space or a blank line are bytes nobody ruled
 *                and this is the seam where a promised shape is enforced, so
 *                everything outside the ruled line is refused.
 *
 * The token comes back only when all four hold, and it is EMPTY otherwise, so a
 * caller that ignores the booleans still cannot use a file that failed them.
 * Nothing derived from the contents is ever reported: the answer is booleans.
 */
export interface MintFileChecks {
  present: boolean;
  regularFile: boolean;
  mode600: boolean;
  shapeOk: boolean;
}

export const MINT_TOKEN_NAME = "CONTROL_PLANE_MINT_TOKEN";
/** The whole file, not a line of it. `\n?$` allows the usual final newline. */
const MINT_FILE_EXACTLY = /^CONTROL_PLANE_MINT_TOKEN='([0-9a-f]{40})'\n?$/;

export function inspectMintFile(file: string = MINT_ENV_FILE): {
  checks: MintFileChecks;
  token: string;
} {
  const failed = (checks: Partial<MintFileChecks>) => ({
    checks: {
      present: false,
      regularFile: false,
      mode600: false,
      shapeOk: false,
      ...checks,
    },
    token: "",
  });

  let handle: number;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    // A symlink fails here with ELOOP, which is the refusal. Absent is the only
    // case that is not "something is there and it is not a file we may read".
    const code = (err as NodeJS.ErrnoException).code;
    return failed({ present: code !== "ENOENT" });
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return failed({ present: true });
    const mode600 = (stat.mode & 0o7777) === 0o600;
    const contents = fs.readFileSync(handle, "utf8");
    const match = MINT_FILE_EXACTLY.exec(contents);
    const checks = {
      present: true,
      regularFile: true,
      mode600,
      shapeOk: match !== null,
    };
    if (!mode600 || !match) return { checks, token: "" };
    return { checks, token: match[1] };
  } catch {
    return failed({ present: true, regularFile: true });
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      // Nothing depends on the close succeeding; the answer is already formed.
    }
  }
}

/** True only when every check held. The one thing callers should branch on. */
export function mintFileUsable(checks: MintFileChecks): boolean {
  return (
    checks.present && checks.regularFile && checks.mode600 && checks.shapeOk
  );
}
