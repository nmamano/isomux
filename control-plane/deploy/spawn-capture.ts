// Running a child without letting a credential out, and reading a secret file
// without printing it. Shared by the Vercel programs.
//
//   NOTHING IS EXPANDED BY A SHELL. A credential is read inside this process
//   and handed to the child as an environment variable or on stdin. It never
//   appears in argv - which the process table shows to every user on the box -
//   and never in a command line somebody might paste into a report.
//
//   THE CHILD'S OUTPUT IS CAPTURED, AND CAPTURED IS NOT PRINTED. The child's
//   stdout and stderr are held in memory for scanning and are never forwarded.
//   That is a stronger rule than "scan and forward if clean", and deliberately
//   so: an exact-value scan cannot see a fragment, a re-encoding or a
//   truncation, so safety comes from not emitting the bytes at all rather than
//   from a scanner being complete.

import * as fs from "node:fs";

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
