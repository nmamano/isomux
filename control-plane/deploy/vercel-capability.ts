// What the account and the LIVE API actually support, before anything is
// created.
//
//   bun control-plane/deploy/vercel-capability.ts
//
// EVERY REQUEST THIS PROGRAM MAKES IS A GET. It creates nothing, sets nothing
// and deploys nothing - which is the whole reason it exists as its own file
// rather than as the first half of a program that also mutates. A measurement
// step that shares a process with a mutation step is one flag away from being
// the mutation step.
//
// It answers the questions a deployment plan cannot answer by reasoning:
//
//   - is the credential file the shape it was promised to be, checked HERE by
//     the process about to use it;
//   - which CLI version would run;
//   - which project settings the live API actually carries, by NAME - the
//     monorepo posture depends on `rootDirectory` and
//     `sourceFilesOutsideRootDirectory` existing, and a plan that assumes them
//     is a plan resting on documentation;
//   - is our project name free, and is the landing page's name still taken by
//     something that is not us;
//   - how big an upload would be, against Vercel's Hobby caps.
//
// WHAT IT PRINTS: booleans, counts, field NAMES, and a version string matched
// against a fixed shape. No project names other than the two constants this
// repository already publishes, no ids, no tokens, no response bodies.

import * as fs from "node:fs";
import {
  FORBIDDEN_PROJECT_NAMES,
  PROJECT_NAME,
  VERCEL_TOKEN_FILE,
  vercelApi,
} from "./vercel-api.ts";
import { realSpawn } from "./fly-cli.ts";

/** Vercel's Hobby ceilings on a CLI source upload (docs read 2026-08-11). */
export const HOBBY_UPLOAD_BYTES = 100 * 1024 * 1024;
export const HOBBY_UPLOAD_FILES = 15_000;

/** The settings the monorepo posture depends on. Named here so the output is a
 * fixed list rather than whatever the API happened to return. */
export const SETTINGS_OF_INTEREST = [
  "rootDirectory",
  "sourceFilesOutsideRootDirectory",
  "framework",
  "installCommand",
  "buildCommand",
  "outputDirectory",
  "nodeVersion",
] as const;

export interface TokenFileChecks {
  present: boolean;
  regularFile: boolean;
  mode600: boolean;
  singleLine: boolean;
}

/**
 * The credential file, re-established by the consumer.
 *
 * Same discipline as `inspectMintFile`: opened ONCE with O_NOFOLLOW and read
 * through that descriptor, so a symlink cannot be opened and a path swapped
 * between the check and the read cannot be reached. The shape is looser than
 * the mint file's because a Vercel token is opaque - what can be required is
 * that it is one line with no whitespace in it, which is what a pasted
 * credential looks like and what a stray "export X=" line does not.
 */
export function inspectTokenFile(file: string = VERCEL_TOKEN_FILE): {
  checks: TokenFileChecks;
  token: string;
} {
  const failed = (checks: Partial<TokenFileChecks>) => ({
    checks: {
      present: false,
      regularFile: false,
      mode600: false,
      singleLine: false,
      ...checks,
    },
    token: "",
  });
  let handle: number;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return failed({ present: code !== "ENOENT" });
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return failed({ present: true });
    const mode600 = (stat.mode & 0o7777) === 0o600;
    const contents = fs.readFileSync(handle, "utf8");
    const match = /^(\S+)\n?$/.exec(contents);
    const checks = {
      present: true,
      regularFile: true,
      mode600,
      singleLine: match !== null,
    };
    if (!mode600 || !match) return { checks, token: "" };
    return { checks, token: match[1] };
  } catch {
    return failed({ present: true, regularFile: true });
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      // The answer is already formed.
    }
  }
}

export function tokenFileUsable(checks: TokenFileChecks): boolean {
  return (
    checks.present && checks.regularFile && checks.mode600 && checks.singleLine
  );
}

/** A semantic version out of a child's output, or nothing. The child's bytes
 * are never forwarded - only a match of this exact shape is. */
export function versionFrom(output: string): string {
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(output);
  return match ? match[1] : "unreadable";
}

async function cliVersion(): Promise<string> {
  try {
    const result = await realSpawn(
      ["bun", "x", "vercel@latest", "--version"],
      {},
      "",
    );
    return versionFrom(`${result.stdout}\n${result.stderr}`);
  } catch {
    return "unavailable";
  }
}

/**
 * What an upload would carry, measured as the repository's TRACKED files.
 *
 * A PROXY, and labelled as one: the CLI applies its own ignore rules, which
 * this does not reimplement. It is the right proxy for the question being
 * asked, because the caps are about order of magnitude - the repository holds
 * 1.2 GB of node_modules at the root and 492 MB more under the web package, so
 * what matters is whether the real set is thousands of source files or
 * hundreds of thousands of dependency files.
 */
function trackedUpload(): { files: number; bytes: number } {
  const listing = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: process.cwd(),
  });
  const names = new TextDecoder()
    .decode(listing.stdout)
    .split("\0")
    .filter((n) => n.length > 0);
  let bytes = 0;
  for (const name of names) {
    try {
      bytes += fs.statSync(name).size;
    } catch {
      // A tracked path that is not readable right now is not worth a message.
    }
  }
  return { files: names.length, bytes };
}

interface ProjectRow {
  name?: unknown;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const { checks, token } = inspectTokenFile();
  console.log(`token_file_present: ${checks.present}`);
  console.log(`token_file_regular: ${checks.regularFile}`);
  console.log(`token_file_mode_600: ${checks.mode600}`);
  console.log(`token_file_single_line: ${checks.singleLine}`);
  if (!tokenFileUsable(checks)) {
    console.log("refusing: the token file is not in the expected shape");
    process.exitCode = 2;
    return;
  }

  console.log(`cli_version: ${await cliVersion()}`);

  // GET only, from here down.
  const teams = await vercelApi<{ teams?: unknown[] }>("/v2/teams", token);
  console.log(`api_reachable: true`);
  console.log(`teams_visible: ${teams.teams?.length ?? 0}`);

  const listed = await vercelApi<{ projects?: ProjectRow[] }>(
    "/v9/projects?limit=100",
    token,
  );
  const projects = listed.projects ?? [];
  console.log(`projects_visible: ${projects.length}`);

  const names = projects.map((p) => (typeof p.name === "string" ? p.name : ""));
  console.log(`project_name_free: ${!names.includes(PROJECT_NAME)}`);
  for (const forbidden of FORBIDDEN_PROJECT_NAMES) {
    console.log(`forbidden_name_exists: ${names.includes(forbidden)}`);
  }

  // The live API's own field set, by NAME. This is the evidence the monorepo
  // posture rests on: a setting that is not in this union does not exist, and
  // a plan that names it is a plan resting on documentation.
  const keys = new Set<string>();
  for (const row of projects) for (const key of Object.keys(row)) keys.add(key);
  console.log(`project_field_names_seen: ${keys.size}`);
  for (const setting of SETTINGS_OF_INTEREST) {
    console.log(`  setting_present: ${setting} ${keys.has(setting)}`);
  }

  const upload = trackedUpload();
  console.log(`tracked_files: ${upload.files}`);
  console.log(`tracked_megabytes: ${(upload.bytes / 1024 / 1024).toFixed(1)}`);
  console.log(`under_hobby_file_cap: ${upload.files < HOBBY_UPLOAD_FILES}`);
  console.log(`under_hobby_byte_cap: ${upload.bytes < HOBBY_UPLOAD_BYTES}`);
}

if (import.meta.main) {
  await main();
}
