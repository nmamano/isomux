// Talking to Vercel without letting a credential out, and without ever
// touching the project this repository already has.
//
// TWO PROJECTS SHARE THIS REPOSITORY, and that is the hazard this file exists
// for. The repository root is ALREADY linked to `isomux` - the landing page -
// through a gitignored `.vercel/project.json`, and the root `vercel.json` is
// that project's build configuration. So the Vercel CLI's default target in
// this tree is somebody else's production site. D2's rule was "every flyctl
// call names -a isomux-provisioner"; here the same rule is stricter, because
// the wrong target is the DEFAULT rather than a possibility:
//
//   - the project name is a CONSTANT, and the landing page's name is on a
//     refusal list that every entry point checks;
//   - the CLI is never run in the repository root. It runs in
//     `control-plane/web`, which carries its own link file, and that file is
//     asserted to name OUR project before anything is deployed;
//   - the root link is never read, parsed or relied on. Not even to compare
//     against: reading it is how a program starts depending on it.
//
// SECRETS. The API token is read inside this process and travels in an
// Authorization header - never in argv, which the process table shows to
// everyone on the box, and never through a shell. Environment VALUES travel in
// a JSON request body for the same reason. The one child process this
// deployment needs is the CLI, and it gets the token in its ENVIRONMENT with
// its output captured and dropped, exactly as `fly-cli.ts` does.
//
// WHAT MAY BE PRINTED: fixed names, booleans, counts, and HTTP status codes. A
// Vercel error body quotes back what was asked for, so no response body reaches
// an error message on any path.

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { readSecretFile } from "./fly-cli.ts";

/** The only project this slice may create or touch. */
export const PROJECT_NAME = "isomux-control-plane";

/**
 * Projects that must never be addressed from here, by name.
 *
 * `isomux` is the landing page, in this same repository, already linked at the
 * root. It is listed rather than assumed: a typo in a constant is not supposed
 * to be able to reach a live marketing site.
 */
export const FORBIDDEN_PROJECT_NAMES = ["isomux"] as const;

/** Where the CLI may be run, relative to the repository root. Never ".". */
export const CLI_WORKING_DIR = "control-plane/web";

const SECRETS_DIR = path.join(os.homedir(), "nil", "secrets");
export const VERCEL_TOKEN_FILE = path.join(SECRETS_DIR, "vercel.token");

const API = "https://api.vercel.com";

/** Does the token file exist? A BOOLEAN - the pickup's Nil-side dependency is
 * checked, never read, until something actually needs it. */
export function tokenFilePresent(file: string = VERCEL_TOKEN_FILE): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function readToken(file: string = VERCEL_TOKEN_FILE): string {
  return readSecretFile(file);
}

/**
 * The environment names this deployment may carry, and nothing else.
 *
 * An allowlist rather than a filter: the failure this prevents is a value
 * carrying a name nobody ruled, and a program that can set any name is one
 * mistake away from setting `CONTROL_PLANE_DEV_AUTH` on a production build.
 *
 * What is deliberately ABSENT is as much of the contract as what is present.
 * No provider credential, no Neon API key, no fly token, no key material, no
 * dev-auth flag, and no Stripe value: with no price configured, `signUpOffice`
 * refuses before it reserves a name, so the deployment cannot write a
 * reservation row or reach Stripe at all.
 */
export const DEPLOYMENT_ENV_NAMES = [
  "CONTROL_PLANE_DB",
  "AUTH_SECRET",
  "AUTH_URL",
  "CONTROL_PLANE_MINT_URL",
  "CONTROL_PLANE_MINT_TOKEN",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
] as const;

/**
 * Names that must never be set on this deployment, checked by name.
 *
 * Two classes, and both are stated rather than left to the allowlist: the
 * credentials that belong to the PROVISIONER and never to a public web app,
 * and the flags that would put a test surface on a production build.
 */
export const FORBIDDEN_ENV_NAMES = [
  "CONTABO_CLIENT_ID",
  "CONTABO_CLIENT_SECRET",
  "CONTABO_API_USER",
  "CONTABO_API_PASSWORD",
  "NEON_API_KEY",
  "FLY_API_TOKEN",
  "CONTROL_PLANE_DB_BRANCH",
  "CONTROL_PLANE_DEV_AUTH",
  "NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH",
  "STRIPE_TEST_SECRET_KEY",
  "CONTROL_PLANE_PRICE_ID",
  "CONTROL_PLANE_COUPON_ID",
] as const;

/** Vercel's own grammar for an environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Vercel's documented ceiling on the total size of a deployment's environment,
 * names and values together, for the Node.js runtime (docs read 2026-08-11).
 * Checked here so the refusal happens before a child or a request exists.
 */
export const ENV_TOTAL_BYTES_LIMIT = 64 * 1024;

export interface EnvPair {
  name: string;
  value: string;
}

/**
 * Everything that must hold before a value may leave this process.
 *
 * This is deliberately NOT `secrets.ts`'s validator. That one guards a stdin
 * LINE PROTOCOL, where a newline in a value ends one assignment and begins
 * another; these values travel in a JSON body, where a newline is merely
 * encoded. What they share is the reason: a value is checked before anything
 * that could carry it exists. What differs is the threat, so the rules differ -
 * Vercel's name grammar and its size ceiling are checked here, and control
 * characters are refused because a value that renders as something else in a
 * dashboard is a value somebody will mis-read later.
 */
export function validateEnvPairs(
  pairs: EnvPair[],
  allowed: readonly string[] = DEPLOYMENT_ENV_NAMES,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const pair of pairs) {
    if ((FORBIDDEN_ENV_NAMES as readonly string[]).includes(pair.name)) {
      problems.push(`refused outright: ${pair.name}`);
      continue;
    }
    if (!allowed.includes(pair.name)) {
      problems.push(`not an allowed name: ${pair.name}`);
      continue;
    }
    if (!ENV_NAME.test(pair.name)) {
      problems.push(`not a legal name: ${pair.name}`);
    }
    if (seen.has(pair.name)) problems.push(`named twice: ${pair.name}`);
    seen.add(pair.name);
    if (pair.value.length === 0) problems.push(`empty value: ${pair.name}`);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(pair.value)) {
      problems.push(`value carries a control character: ${pair.name}`);
    }
    total += Buffer.byteLength(pair.name) + Buffer.byteLength(pair.value);
  }
  if (total > ENV_TOTAL_BYTES_LIMIT) {
    // A COUNT, not the contents: how far over is a number, and the values that
    // made it are not this message's business.
    problems.push(
      `the environment is over Vercel's size ceiling by ${total - ENV_TOTAL_BYTES_LIMIT} bytes`,
    );
  }
  return problems;
}

/** A project name this program is allowed to address. */
export function projectNameUsable(name: string): boolean {
  return (
    name === PROJECT_NAME &&
    !(FORBIDDEN_PROJECT_NAMES as readonly string[]).includes(name)
  );
}

export interface LinkVerdict {
  present: boolean;
  /** The link names OUR project, by id, scope AND name - all three. */
  matches: boolean;
  /** The link names a project this program must never address, by either id
   * or name. The id is checked too because a name can be changed. */
  forbidden: boolean;
}

export interface LinkExpectation {
  projectId: string;
  /** The scope the project lives in. The CLI calls it `orgId`; the API calls
   * the same value `accountId` on a project record. */
  orgId: string;
}

/**
 * Does the CLI's working directory link to the project we created?
 *
 * BOTH the id and the name are required to match. The id is the thing the CLI
 * acts on and the name is the thing a human reads, and a link where those two
 * disagree is not a link anybody should deploy through. The repository ROOT's
 * link is never opened by this function - the directory is a parameter with a
 * default of the nested one, and a caller that passes the root gets the
 * `forbidden` verdict from the name it finds there.
 */
export function inspectLink(
  dir: string,
  expected: LinkExpectation,
  forbiddenProjectId = "",
): LinkVerdict {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, ".vercel", "project.json"), "utf8");
  } catch {
    return { present: false, matches: false, forbidden: false };
  }
  let parsed: { projectId?: unknown; projectName?: unknown; orgId?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // A link file we cannot read is not a link we may act through.
    return { present: true, matches: false, forbidden: false };
  }
  const name = typeof parsed.projectName === "string" ? parsed.projectName : "";
  const id = typeof parsed.projectId === "string" ? parsed.projectId : "";
  const org = typeof parsed.orgId === "string" ? parsed.orgId : "";
  return {
    present: true,
    matches:
      id === expected.projectId &&
      org === expected.orgId &&
      name === PROJECT_NAME &&
      id.length > 0 &&
      org.length > 0,
    forbidden:
      (FORBIDDEN_PROJECT_NAMES as readonly string[]).includes(name) ||
      (forbiddenProjectId.length > 0 && id === forbiddenProjectId),
  };
}

export interface ApiFailure {
  status: number;
}

/**
 * One request to the Vercel API.
 *
 * A failure carries the STATUS and nothing else. Vercel's error bodies quote
 * back what was asked for - a project name, an environment variable name, at
 * times a value - and this is the seam where that would enter a transcript.
 * The same rule as `neon-api.ts`, for the same reason.
 */
export async function vercelApi<T>(
  route: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    throw new Error(
      `the Vercel API answered ${res.status} to a ${init?.method ?? "GET"}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * The same request, when the answer is a log stream rather than JSON.
 *
 * The text is returned for JUDGING, never for printing: callers turn it into
 * booleans. A failure carries the status, like every other seam here.
 */
export async function vercelApiText(
  route: string,
  token: string,
): Promise<string> {
  const res = await fetch(`${API}${route}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`the Vercel API answered ${res.status} to a GET`);
  }
  return res.text();
}

/**
 * Did any secret survive into bytes a caller could print?
 *
 * Used against a child's captured output before it is DROPPED - the scan is a
 * diagnostic, never the guarantee, because an exact-value scan cannot see a
 * fragment, a re-encoding or a truncation. `deploy/secrets.test.ts` makes that
 * argument for the fly side and it is the same argument here.
 */
export function anyValueAppears(haystack: string, values: string[]): boolean {
  return values.some((v) => v.length > 0 && haystack.includes(v));
}
