// The Production phase, as ONE process, because the secret cannot outlive it.
//
//   bun control-plane/deploy/production-phase.ts
//
// A `sensitive` value cannot be read back from Vercel - that is the point of it
// - so the only process that can ever mint a session cookie for this deployment
// is the one that generated the secret. Writing the environment, deploying,
// waiting for the certificate and probing therefore cannot be separate runs.
// The coordinator stays alive across all of it.
//
// THE ORDER IS RULED, NOT CHOSEN. R-2026-08-11-2-AMENDED moved the TLS
// confirmation INSIDE this phase: environment and deploy FIRST, then a bounded
// wait for certificate issuance, then the full suite over HTTPS. The domain was
// attached in the earlier phase and DNS is live; until a certificate exists the
// hostname serves nothing over TLS, so deploying first does not widen exposure.
//
// PRODUCTION CARRIES NO USER DATA, BEFORE OR AFTER. Preview proved its
// authenticated pages by seeding a fixture account; that is forbidden here, so
// the probes mint a cookie for an account that DOES NOT EXIST. Auth.js is
// JWT-backed with no adapter, so nothing is written to prove it. Row counts are
// asserted zero three times: before the writes, after READY, and after probing.
//
// WHAT IT PRINTS: booleans, counts, statuses and fixed names. No value, no id,
// no URL, no build log, and no child byte that did not match a fixed shape.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FORBIDDEN_ENV_NAMES,
  FORBIDDEN_PROJECT_NAMES,
  PROJECT_NAME,
  vercelApi,
} from "./vercel-api.ts";
import { inspectTokenFile, tokenFileUsable } from "./vercel-capability.ts";
import {
  CLI_SPEC,
  buildEvidenceAllHold,
  deploymentIsOurs,
  judgeBuild,
  judgeSettings,
  settingsHoldWithInstallCommand,
  spawnIn,
} from "./vercel-preview.ts";
import { vercelApiText } from "./vercel-api.ts";
import {
  INSTALL_COMMAND,
  repositoryDigests,
  repositoryUnchanged,
  transformArtifact,
  transformIsExact,
} from "./artifact.ts";
import {
  archiveAllHold,
  judgeArchive,
  removable,
} from "./vercel-archive-deploy.ts";
import { createEnv, inventory } from "./vercel-env.ts";
import type { EnvFact, EnvTarget, EnvType, EnvWrite } from "./vercel-env.ts";
import {
  TARGET_DOMAIN,
  attachHeld,
  detach,
  detachHeld,
  domainConfig,
  domainsOf,
  judgeDomains,
  projectDomain,
} from "./vercel-domain.ts";
import {
  PRODUCTION_BRANCH,
  branchNamed,
  branches,
  project as neonProject,
  targetFor,
} from "../exercises/neon-api.ts";
import { Store } from "../store.ts";

/**
 * Things to drop when the coordinator finishes, however it finishes.
 *
 * The secret's lifetime is bounded by the PROCESS, which is the real guarantee;
 * this is the promised best effort on top of it, so a long-lived failure path
 * does not sit on an open pool and a live credential while somebody reads the
 * transcript. Each entry runs once, in a `finally`, and a thrower cannot stop
 * the next one.
 */
const CLEANUP: (() => void | Promise<void>)[] = [];

/** Every line the child may contribute, and nothing else reaches a report. */
const CHILD_LINE = /^[a-z_]+: (true|false|-?\d+)$/;

/** The tables a customer's rows would land in. Production must show zero. */
export const USER_TABLES = [
  "accounts",
  "name_reservations",
  "instances",
  "operations",
] as const;

import {
  classifyAgainstHead,
  headPathsFrom,
  parsePorcelain,
} from "./tree-state.ts";

/** The paths whose staleness would matter to the artifact. */
const GUARDED_PATHS = ["control-plane/web", "control-plane"];

const SHA = /^[0-9a-f]{40}$/;
const TERMINAL = ["READY", "ERROR", "CANCELED"] as const;
const STATE_SHAPE = /^[A-Z_]+$/;

export const PUBLIC_ORIGIN = `https://${TARGET_DOMAIN}`;
export const PROVISIONER_ORIGIN = "https://isomux-provisioner.fly.dev";

/** The exact target the attach phase derived and handed to Nil on 2026-08-11.
 * The hostname must still resolve to THIS and nothing else. */
export const EXPECTED_CNAME_TARGET = "7f093b64d7196cf5.vercel-dns-017.com";

// ------------------------------------------------------------- the mode

/**
 * FIRST DEPLOY or REDEPLOY, and the difference is what may be written.
 *
 * A redeploy exists because the application changed, not the environment. The
 * seven Production values are already there, `AUTH_SECRET` among them is
 * write-only by design, and the process that generated it is gone - so a
 * redeploy cannot read it, cannot mint a session cookie, and must not try to
 * rewrite the environment to get one back. It therefore writes NOTHING and
 * proves less, and says so rather than implying it proved the same.
 */
export type PhaseMode = "first" | "redeploy";

/**
 * The mode, or NOTHING.
 *
 * CLOSED, not permissive. `--redeply` is a typo that used to select the
 * first-deploy path silently - the one that WRITES the environment - so an
 * unrecognised argument now refuses the run rather than choosing the more
 * destructive default. `argv` here is the full process argv; the first two
 * entries are the runtime and the script.
 */
export function modeFrom(argv: readonly string[]): PhaseMode | null {
  const args = argv.slice(2);
  if (args.length === 0) return "first";
  if (args.length === 1 && args[0] === "--redeploy") return "redeploy";
  return null;
}

/**
 * The environment writes a mode may perform. EMPTY for a redeploy, which is how
 * "no create, no PATCH, no delete" is enforced: the loop that issues writes has
 * nothing to iterate, so no mutating call is reachable at all.
 */
export function envWritesFor(mode: PhaseMode): readonly EnvShape[] {
  return mode === "redeploy" ? [] : PRODUCTION_SHAPES;
}

/** What Production must ALREADY carry when the phase starts. */
export function expectedProductionBefore(mode: PhaseMode): readonly EnvShape[] {
  return mode === "redeploy" ? PRODUCTION_SHAPES : [];
}

/** What a FIRST deploy demands of the database it is pointed at. */
export const EMPTY_ROWS: Record<string, number> = {
  accounts: 0,
  name_reservations: 0,
  instances: 0,
  operations: 0,
};

/**
 * Whether the reading taken BEFORE the phase lets it proceed.
 *
 * The first deploy demands an empty database, and that number is fixed forever:
 * a first deploy against a database that already holds product rows is pointed
 * at the wrong one.
 *
 * A redeploy has no fixed numbers, and the version that had them was a bug
 * (task f5ed4b60, fixed 2026-08-12). `{accounts: 1, ...zeros}` was true only
 * while Nil's sign-in was the whole of production; the first customer office
 * makes it false, and a deploy tool that refuses after the product is used is a
 * tool nobody can use in the situation it was built for. What is still checked
 * is what a wrong target would fail: every count READABLE, and at least the one
 * account that a production database has carried since 2026-08-11. An empty
 * database under a redeploy is not production.
 */
export function beforeRowsAcceptable(
  mode: PhaseMode,
  counts: Record<string, number>,
): boolean {
  if (mode !== "redeploy") return rowsMatch(counts, EMPTY_ROWS);
  // EVERY NAMED TABLE, not every key the reading happens to carry. Iterating
  // the value set accepted a PARTIAL reading - `{accounts: 1}` alone satisfied
  // it - which would have let a live redeploy proceed on evidence that never
  // established what three of the four tables held (reviewer finding,
  // 2026-08-12). `rowCounts` builds all four today; the predicate must not
  // depend on that staying true.
  const readable = (n: unknown): boolean =>
    typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (!USER_TABLES.every((table) => readable(counts[table]))) return false;
  return counts.accounts >= 1;
}

/**
 * What every reading AFTER the deploy must equal: the reading this run started
 * with.
 *
 * Both modes make the same claim - a deploy changes no user data - and stating
 * it as a comparison rather than as constants is what makes it survive the
 * product being used. The first deploy's `before` is the empty database it
 * demanded, so the comparison is exactly as strict as the constants were.
 *
 * It says nothing about WHO changed a row: a customer signing up while the
 * deploy runs would trip it too. That is accepted rather than worked around -
 * this phase is an operator action, run deliberately, not a background job.
 */
export function afterRowsExpected(
  before: Record<string, number>,
): Record<string, number> {
  return { ...before };
}

export function rowsMatch(
  counts: Record<string, number>,
  expected: Record<string, number>,
): boolean {
  const keys = [...new Set([...Object.keys(counts), ...Object.keys(expected)])];
  return keys.every((k) => counts[k] === expected[k]);
}

// ------------------------------------------------------- the environment

/** What a name must BE, without its value. Used for both the writes and the
 * read-back, so the intent and the assertion cannot drift. */
export interface EnvShape {
  key: string;
  type: EnvType;
  target: EnvTarget;
}

/** The seven, and the absences are as much of the contract as the entries.
 * `encrypted` is used only for values that are public by construction: the
 * site's own address, the provisioner's hostname, and the OAuth client id,
 * which is sent to every browser on every sign-in. */
export const PRODUCTION_SHAPES: readonly EnvShape[] = [
  { key: "CONTROL_PLANE_DB", type: "sensitive", target: "production" },
  { key: "AUTH_SECRET", type: "sensitive", target: "production" },
  { key: "CONTROL_PLANE_MINT_TOKEN", type: "sensitive", target: "production" },
  { key: "AUTH_GOOGLE_SECRET", type: "sensitive", target: "production" },
  { key: "AUTH_URL", type: "encrypted", target: "production" },
  { key: "CONTROL_PLANE_MINT_URL", type: "encrypted", target: "production" },
  { key: "AUTH_GOOGLE_ID", type: "encrypted", target: "production" },
] as const;

/** What Preview already carries, and must still carry untouched. */
export const PREVIEW_SHAPES: readonly EnvShape[] = [
  { key: "CONTROL_PLANE_DB", type: "sensitive", target: "preview" },
  { key: "AUTH_SECRET", type: "sensitive", target: "preview" },
] as const;

export interface TargetVerdict {
  /** Every entry names exactly ONE known target. A multi-target entry would be
   * counted twice by any per-target judgement, so it refuses instead. */
  everySingleTarget: boolean;
  /** The same key twice on the same target: an ambiguity a key-map hides. */
  duplicates: string[];
  totalFacts: number;
  totalExpected: boolean;
  previewExact: boolean;
  productionExact: boolean;
  previewProblems: string[];
  productionProblems: string[];
  forbiddenPresent: string[];
  exact: boolean;
}

/**
 * Is the project carrying exactly what was intended, ON EACH TARGET?
 *
 * DELIBERATELY NOT `judgeInventory`. That one maps facts by key, which is right
 * when every name appears once - and wrong here, because `CONTROL_PLANE_DB` and
 * `AUTH_SECRET` exist on BOTH targets with different values. A key map would
 * silently let the Production entry stand in for the Preview one, so a missing
 * Preview entry would read as exact. The shared function is already proved for
 * its own case and is left alone; this partitions first and judges each side.
 */
export function judgeByTarget(
  facts: EnvFact[],
  previewExpected: readonly EnvShape[],
  productionExpected: readonly EnvShape[],
  forbidden: readonly string[],
): TargetVerdict {
  const known: EnvTarget[] = ["preview", "production"];
  const everySingleTarget = facts.every(
    (f) => f.target.length === 1 && known.includes(f.target[0] as EnvTarget),
  );
  const seen = new Map<string, number>();
  for (const fact of facts) {
    const id = `${fact.key}|${fact.target.join("+")}`;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();

  const judgeSide = (
    side: EnvTarget,
    expected: readonly EnvShape[],
  ): string[] => {
    const problems: string[] = [];
    const mine = facts.filter(
      (f) => f.target.length === 1 && f.target[0] === side,
    );
    for (const want of expected) {
      const got = mine.find((f) => f.key === want.key);
      if (!got) {
        problems.push(`missing:${side}:${want.key}`);
        continue;
      }
      if (got.type !== want.type) problems.push(`type:${side}:${want.key}`);
    }
    const intended = new Set(expected.map((e) => e.key));
    for (const got of mine) {
      if (!intended.has(got.key))
        problems.push(`unexpected:${side}:${got.key}`);
    }
    return problems;
  };

  const previewProblems = judgeSide("preview", previewExpected);
  const productionProblems = judgeSide("production", productionExpected);
  const totalFacts = facts.length;
  const totalExpected =
    totalFacts === previewExpected.length + productionExpected.length;
  const forbiddenPresent = facts
    .map((f) => f.key)
    .filter((k) => forbidden.includes(k))
    .sort();
  return {
    everySingleTarget,
    duplicates,
    totalFacts,
    totalExpected,
    previewExact: previewProblems.length === 0,
    productionExact: productionProblems.length === 0,
    previewProblems,
    productionProblems,
    forbiddenPresent,
    exact:
      everySingleTarget &&
      duplicates.length === 0 &&
      totalExpected &&
      previewProblems.length === 0 &&
      productionProblems.length === 0 &&
      forbiddenPresent.length === 0,
  };
}

// ------------------------------------------------------- the secret files

/**
 * What each credential must LOOK like, checked before it can be written.
 *
 * A shape check is not decoration here. These values are written `sensitive`,
 * so once they are in Vercel nobody can read them back to see what went in - if
 * the wrong file, a truncated line or a stray quote reached a POST, the first
 * symptom would be a broken sign-in on a public hostname. Each pattern was
 * measured against the live file on 2026-08-11 by boolean check, never printed.
 */
export const SECRET_SHAPES: Readonly<Record<string, RegExp>> = {
  CONTROL_PLANE_MINT_TOKEN: /^[0-9a-f]{40}$/,
  GOOGLE_CLIENT_ID: /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
  GOOGLE_CLIENT_SECRET: /^GOCSPX-[A-Za-z0-9_-]{10,}$/,
};

/**
 * Parse an env file's TEXT, or refuse it. Separated from the file handling so
 * the contract can be tested without a real credential on disk.
 *
 * A REPEATED KEY IS A REFUSAL, even when both lines agree. A Map would keep the
 * last one silently, and "which of these two lines is the credential" is not a
 * question a program should answer on its own.
 */
export function parseSecretText(
  text: string,
  expected: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^([A-Z_]+)='([^']*)'$/.exec(line);
    if (!match) throw new Error("refusing: a line is not KEY='value'");
    if (found.has(match[1])) {
      throw new Error("refusing: a name appears twice in the secret file");
    }
    found.set(match[1], match[2]);
  }
  const names = [...found.keys()].sort().join(",");
  if (names !== [...expected].sort().join(",")) {
    throw new Error(
      "refusing: the secret file does not carry exactly the expected names",
    );
  }
  for (const [key, value] of found) {
    if (value.length === 0) throw new Error("refusing: an empty value");
    const shape = SECRET_SHAPES[key];
    // The NAME is in the message and the value never is.
    if (shape && !shape.test(value)) {
      throw new Error(`refusing: ${key} is not the expected shape`);
    }
  }
  return found;
}

/**
 * Read an env file STRICTLY, or refuse it.
 *
 * `O_NOFOLLOW` so a symlink cannot redirect the read somewhere else, an exact
 * `0600` so a file the box can read is not treated as a credential, and an
 * exact key set so a file that grew an extra name is a refusal rather than a
 * surprise. Values are single-quoted per ruling 8 and are never logged.
 */
export function readEnvFileStrict(
  file: string,
  expected: readonly string[],
): Map<string, string> {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error("refusing: the secret file could not be opened directly");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("refusing: not a regular file");
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error("refusing: the secret file is not exactly 0600");
    }
    return parseSecretText(fs.readFileSync(fd, "utf8"), expected);
  } finally {
    fs.closeSync(fd);
  }
}

// --------------------------------------------------------- the TLS wait

/** ABSOLUTE offsets from the moment the deployment reached READY. Absolute, not
 * cumulative: sleeping 60+180+360+600+900 would wait 35 minutes for a 15-minute
 * budget. The last check is the deadline. */
export const TLS_OFFSETS_MS = [
  60_000, 180_000, 360_000, 600_000, 900_000,
] as const;

export interface TlsWaitResult {
  reads: number;
  verified: boolean;
  elapsedMs: number;
}

/**
 * Wait for a certificate, bounded, with the clock injected so a test can prove
 * the bound without waiting fifteen real minutes.
 *
 * The FIRST success ends the wait. A check that throws counts as "not yet"
 * rather than as a failure: a TLS handshake reset is exactly what absence looks
 * like, and it is the thing we are waiting to stop happening.
 */
export async function awaitTls(deps: {
  offsets: readonly number[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  check: () => Promise<boolean>;
  startedAtMs: number;
}): Promise<TlsWaitResult> {
  let reads = 0;
  for (const offset of deps.offsets) {
    const due = deps.startedAtMs + offset;
    const wait = due - deps.now();
    if (wait > 0) await deps.sleep(wait);
    reads += 1;
    let ok = false;
    try {
      ok = await deps.check();
    } catch {
      ok = false;
    }
    if (ok) {
      return {
        reads,
        verified: true,
        elapsedMs: deps.now() - deps.startedAtMs,
      };
    }
  }
  return {
    reads,
    verified: false,
    elapsedMs: deps.now() - deps.startedAtMs,
  };
}

// ------------------------------------------------------ the probe verdict

/** Every probe line the child must produce, and the value each must carry. */
export const PROBE_EXPECTATIONS: Readonly<Record<string, boolean | number>> = {
  providers_status: 200,
  providers_count: 1,
  providers_only_google: true,
  providers_has_dev: false,
  signin_status: 200,
  signin_has_dev_form: false,
  signin_has_google: true,
  office_signed_out_redirects_to_signin: true,
  office_signed_out_to_vercel: false,
  home_status: 200,
  home_shows_identity: true,
  home_shows_no_office: true,
  office_fake_account_status: 404,
  ops_fake_account_status: 404,
  reveal_status: 200,
  reveal_is_forbidden: true,
  reveal_is_failed: false,
  reveal_has_url: false,
  reveal_no_store: true,
  no_auth_secret_reflected: true,
  no_dsn_reflected: true,
  no_mint_token_reflected: true,
  no_oauth_secret_reflected: true,
  no_bypass_reflected: true,
};

/**
 * What a REDEPLOY may claim, which is less.
 *
 * No readable `AUTH_SECRET` means no minted cookie, so every authenticated
 * check is absent rather than passing: the store proof, the fake-account pages
 * and the deployed-web bearer round trip are NOT repeated. The reflection
 * claim shrinks honestly too - without the secret values in hand, this can
 * prove the bypass marker and the forbidden credential NAMES do not appear in
 * any body or header, but it cannot prove the absence of an unknown value by
 * equality, and it does not pretend to.
 */
export const UNAUTH_PROBE_EXPECTATIONS: Readonly<
  Record<string, boolean | number>
> = {
  providers_status: 200,
  providers_count: 1,
  providers_only_google: true,
  providers_has_dev: false,
  signin_status: 200,
  signin_has_dev_form: false,
  signin_has_google: true,
  office_signed_out_redirects_to_signin: true,
  office_signed_out_to_vercel: false,
  no_bypass_reflected: true,
  no_credential_names_reflected: true,
};

export function probeExpectationsFor(
  mode: PhaseMode,
): Readonly<Record<string, boolean | number>> {
  return mode === "redeploy" ? UNAUTH_PROBE_EXPECTATIONS : PROBE_EXPECTATIONS;
}

/** The one key judged as a CLASS rather than against a constant, and so the
 * only shaped name allowed outside the table above. */
const CLASS_KEY = "office_signed_out_status";

/** THE CLOSED SET. A shaped line whose name is not in here is a widening of the
 * child's output rather than extra information, and the parent refuses it. */
export function probeKeysFor(
  expectations: Readonly<Record<string, boolean | number>>,
): readonly string[] {
  return [...Object.keys(expectations), CLASS_KEY];
}

export const PROBE_KEYS: readonly string[] = probeKeysFor(PROBE_EXPECTATIONS);

export interface ProbeVerdict {
  parsed: Record<string, boolean | number>;
  missing: string[];
  mismatched: string[];
  /** Shaped lines carrying a name nobody asked for. */
  unexpected: string[];
  /** A name printed twice: the second could silently replace the first. */
  duplicated: string[];
  /** The signed-out refusal is a class rather than one status. */
  signedOutRefused: boolean;
  /** A child may not print a green transcript and then fail. */
  exitedZero: boolean;
  ok: boolean;
}

/**
 * Turn the child's lines into a verdict.
 *
 * THREE WAYS A CHILD COULD MISLEAD, all closed here. It could print a name
 * nobody asked for and have the parent repeat it (`unexpected`). It could print
 * a result twice and have the later line quietly replace the earlier one
 * (`duplicated`), which is how a failing check becomes a passing one. And it
 * could print a perfect transcript and then exit non-zero (`exitedZero`),
 * having died after the last line it managed to emit.
 */
export function judgeProbe(
  stdout: string,
  exitCode: number,
  expectations: Readonly<Record<string, boolean | number>> = PROBE_EXPECTATIONS,
): ProbeVerdict {
  const allowed = probeKeysFor(expectations);
  const parsed: Record<string, boolean | number> = {};
  const unexpected: string[] = [];
  const duplicated: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!CHILD_LINE.test(trimmed)) continue;
    const [name, raw] = trimmed.split(": ");
    if (!allowed.includes(name)) {
      if (!unexpected.includes(name)) unexpected.push(name);
      continue;
    }
    if (name in parsed) {
      if (!duplicated.includes(name)) duplicated.push(name);
      continue;
    }
    parsed[name] =
      raw === "true" ? true : raw === "false" ? false : Number(raw);
  }
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [name, want] of Object.entries(expectations)) {
    if (!(name in parsed)) {
      missing.push(name);
      continue;
    }
    if (parsed[name] !== want) mismatched.push(name);
  }
  // The application may refuse a signed-out request by redirect or by status;
  // what it may never do is answer 200, or hand the caller to Vercel.
  const status = parsed[CLASS_KEY];
  const signedOutRefused =
    typeof status === "number" &&
    status !== 200 &&
    parsed.office_signed_out_to_vercel === false;
  if (!(CLASS_KEY in parsed)) missing.push(CLASS_KEY);
  return {
    parsed,
    missing,
    mismatched,
    unexpected,
    duplicated,
    signedOutRefused,
    exitedZero: exitCode === 0,
    ok:
      missing.length === 0 &&
      mismatched.length === 0 &&
      unexpected.length === 0 &&
      duplicated.length === 0 &&
      signedOutRefused &&
      exitCode === 0,
  };
}

/**
 * Drop every secret-bearing holder, best effort.
 *
 * Separate and exported so the cleanup is a thing that can be TESTED rather
 * than a closure nobody ever runs. A string cannot be wiped from memory in a
 * managed runtime - the process boundary is the real guarantee - but dropping
 * the last reference is what makes that boundary the only place it lives.
 */
export function dropHolders(
  maps: Map<string, string>[],
  boxes: { authSecret: string }[],
): void {
  for (const map of maps) map.clear();
  for (const box of boxes) box.authSecret = "";
}

// ------------------------------------------------- the secret holders

export interface SecretHolders {
  authSecret: string;
  values: Map<string, string>;
  oauth: Map<string, string>;
  mint: Map<string, string>;
}

/**
 * Every credential this phase will hold, or NOTHING.
 *
 * Null for a redeploy, and the readers are CALLBACKS so that "it did not read
 * the files" is a testable fact rather than a claim about control flow. A
 * redeploy writes no environment, so opening a credential file or generating an
 * AUTH_SECRET would be handling secrets it has no use for - and a non-empty
 * secret would send the probe child into its authenticated branch, whose lines
 * the parent would then refuse as unexpected and detach on.
 */
export function buildHolders(
  mode: PhaseMode,
  deps: {
    readOauth: () => Map<string, string>;
    readMint: () => Map<string, string>;
    generate: () => string;
    dsn: string;
  },
): SecretHolders | null {
  if (mode === "redeploy") return null;
  const oauth = deps.readOauth();
  const mint = deps.readMint();
  const authSecret = deps.generate();
  return {
    authSecret,
    oauth,
    mint,
    values: new Map<string, string>([
      ["CONTROL_PLANE_DB", deps.dsn],
      ["AUTH_SECRET", authSecret],
      ["CONTROL_PLANE_MINT_TOKEN", mint.get("CONTROL_PLANE_MINT_TOKEN") ?? ""],
      ["AUTH_GOOGLE_SECRET", oauth.get("GOOGLE_CLIENT_SECRET") ?? ""],
      ["AUTH_URL", PUBLIC_ORIGIN],
      ["CONTROL_PLANE_MINT_URL", PROVISIONER_ORIGIN],
      ["AUTH_GOOGLE_ID", oauth.get("GOOGLE_CLIENT_ID") ?? ""],
    ]),
  };
}

export interface ProbeInput {
  baseUrl: string;
  secret: string;
  secrets: string[];
  accountId: string;
  email: string;
  instanceId: string;
  operationId: string;
}

/**
 * What the probe child is told. An EMPTY secret is the switch that keeps a
 * redeploy on the anonymous path, so it is derived here from the holders rather
 * than from a flag the caller could forget.
 */
export function probeInputFor(
  mode: PhaseMode,
  holders: SecretHolders | null,
  ids: {
    accountId: string;
    email: string;
    instanceId: string;
    operationId: string;
  },
): ProbeInput {
  const authenticated = mode === "first" && holders !== null;
  return {
    baseUrl: PUBLIC_ORIGIN,
    secret: authenticated ? holders.authSecret : "",
    secrets: authenticated
      ? [
          holders.authSecret,
          holders.values.get("CONTROL_PLANE_DB") ?? "",
          holders.mint.get("CONTROL_PLANE_MINT_TOKEN") ?? "",
          holders.oauth.get("GOOGLE_CLIENT_SECRET") ?? "",
        ]
      : [],
    ...ids,
  };
}

// --------------------------------------------- the post-invocation guard

export type PostInvocationOutcome =
  | { kind: "held" }
  | { kind: "rolled-back"; because: string }
  | { kind: "parked-no-tls" };

export interface PostInvocationSteps {
  /** Did tidying the throwaway artifact succeed? It runs BEFORE the guard is
   * entered, so its outcome is carried in rather than thrown out. */
  artifactCleanupHeld: () => Promise<boolean>;
  correlateAndAwaitReady: () => Promise<boolean>;
  rowsZeroAfterDeploy: () => Promise<boolean>;
  /** false means the certificate never arrived: the ONE ruled no-detach exit. */
  awaitCertificate: () => Promise<boolean>;
  probe: () => Promise<boolean>;
  finalStateHolds: () => Promise<boolean>;
  rollback: (because: string) => Promise<void>;
}

/**
 * EVERYTHING AFTER `deploy --prod` IS INVOKED, under one failure boundary.
 *
 * The reason this is a function rather than the tail of `main` is the CATCH. A
 * structured `false` from a step is easy to route to the rollback; a THROW is
 * not - and from the moment the deploy is invoked there is a production
 * deployment behind a public hostname. An API read that raises, a child that
 * cannot be spawned, a socket that resets: each would otherwise exit the
 * coordinator with the domain still attached to a deployment nobody proved. So
 * every exception lands here and detaches BEFORE anything is reported.
 *
 * The single exception is the ruled one: a certificate that never arrived parks
 * with the domain attached, because Production never began serving.
 */
export async function afterInvocation(
  steps: PostInvocationSteps,
): Promise<PostInvocationOutcome> {
  const rollTo = async (because: string): Promise<PostInvocationOutcome> => {
    // The rollback reports its own failure (DOMAIN ROLLBACK FAILED) and must
    // not be able to throw the guard open: a detach that could not complete is
    // the loudest thing in the transcript, not a reason to lose the outcome.
    try {
      await steps.rollback(because);
    } catch {
      // Already reported by the rollback itself.
    }
    return { kind: "rolled-back", because };
  };
  try {
    if (!(await steps.artifactCleanupHeld())) {
      return await rollTo("the artifact could not be tidied after the deploy");
    }
    if (!(await steps.correlateAndAwaitReady())) {
      return await rollTo("the production deployment did not hold");
    }
    if (!(await steps.rowsZeroAfterDeploy())) {
      return await rollTo("production data appeared during the deploy");
    }
    if (!(await steps.awaitCertificate())) return { kind: "parked-no-tls" };
    if (!(await steps.probe())) {
      return await rollTo("a probe failed its acceptance predicate");
    }
    if (!(await steps.finalStateHolds())) {
      return await rollTo("a row count or the attachment did not hold");
    }
    return { kind: "held" };
  } catch {
    // Fixed prose. An error's own text can carry a URL, a host or a quoted
    // request body, and none of that belongs in a transcript.
    return await rollTo("an error was thrown after the deploy was invoked");
  }
}

/**
 * The guard, and WHEN its diagnostics may be printed.
 *
 * This exists because of an ordering defect worth naming: the artifact-cleanup
 * boolean used to be printed the moment it was known, which is BEFORE the guard
 * runs. That made a diagnostic the next external action after a failure, ahead
 * of the detach, which is precisely the order detach-before-diagnosis forbids.
 * Nothing about the detach changed - only when we are allowed to talk about it.
 *
 * `report` is injected so a test can watch the ordering rather than trust it.
 */
export async function guardedRun(
  steps: PostInvocationSteps,
  report: (line: string) => void,
  notes: readonly string[],
  cleanupThrew: boolean,
): Promise<PostInvocationOutcome> {
  const outcome = await afterInvocation(steps);
  // EVERY diagnostic waits here. Condition 3(b) is detach first, diagnose
  // after - and a probe transcript printed as the probe fails is diagnosis
  // arriving before the domain has come down. The rollback's own announcement
  // is exempt: that is the ACTION, not an account of it.
  for (const line of notes) report(line);
  report(`artifact_cleanup_failed: ${cleanupThrew}`);
  return outcome;
}

export function shapedState(value: unknown): string {
  return typeof value === "string" && STATE_SHAPE.test(value)
    ? value
    : "unexpected";
}

/**
 * The local probe is part of the deployment harness, not a production
 * predicate. Its real entry point must start and emit only this closed
 * readiness transcript before any remote operation can begin.
 */
export function probeRuntimeReady(stdout: string, exitCode: number): boolean {
  return exitCode === 0 && stdout.trim() === "probe_runtime_ready: true";
}

// ------------------------------------------------------------------ main

async function rowCounts(store: Store): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of USER_TABLES) {
    const row = await store.sqlGet<{ n: number }>(
      `select count(*)::int as n from ${table}`,
    );
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

async function main(): Promise<void> {
  const workspace = process.cwd();
  const mode = modeFrom(process.argv);
  console.log(`mode: ${mode ?? "unrecognised"}`);
  if (mode === null) {
    // BEFORE the token file is opened, before any API call, before Neon: an
    // argument we do not recognise must not fall through to the mode that
    // writes the environment.
    console.log("refusing: use no arguments, or exactly --redeploy");
    process.exitCode = 2;
    return;
  }
  let probeReady = false;
  try {
    const preflight = await spawnIn(
      path.join(workspace, "control-plane", "web"),
      ["bun", "e2e/production-probe.ts", "--preflight"],
      {},
    );
    probeReady = probeRuntimeReady(preflight.stdout, preflight.code);
  } catch {
    probeReady = false;
  }
  console.log(`probe_runtime_ready: ${probeReady}`);
  if (!probeReady) {
    console.log("refusing: local production probe runtime is not ready");
    console.log(
      "hint: run (cd control-plane/web && bun install) and run from the repository root",
    );
    process.exitCode = 2;
    return;
  }
  const { checks, token } = inspectTokenFile();
  if (!tokenFileUsable(checks)) {
    console.log("refusing: the token file is not in the expected shape");
    process.exitCode = 2;
    return;
  }

  // ---------------------------------------------- 1. identity and source
  const head = new TextDecoder()
    .decode(Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout)
    .trim();
  console.log(`source_commit: ${SHA.test(head) ? head : "unreadable"}`);
  if (!SHA.test(head)) {
    process.exitCode = 2;
    return;
  }
  // Classified against what HEAD CARRIES, not against the status prefix: the
  // archive is `git archive HEAD`, so a path HEAD does not carry cannot make it
  // stale however the index is staged. See deploy/tree-state.ts.
  const status = new TextDecoder().decode(
    Bun.spawnSync(["git", "status", "--porcelain", "--", ...GUARDED_PATHS])
      .stdout,
  );
  const tracked = new TextDecoder().decode(
    Bun.spawnSync([
      "git",
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "--",
      ...GUARDED_PATHS,
    ]).stdout,
  );
  const verdict = classifyAgainstHead(
    parsePorcelain(status),
    headPathsFrom(tracked),
  );
  const runtimeDirty = verdict.runtimeDirty;
  console.log(`runtime_paths_uncommitted_changes: ${runtimeDirty.length}`);
  console.log(`doc_only_uncommitted_changes: ${verdict.docOnly.length}`);
  console.log(`paths_not_in_head: ${verdict.notInHead.length}`);
  if (runtimeDirty.length > 0) {
    console.log("stopping: a runtime path has uncommitted changes");
    process.exitCode = 1;
    return;
  }
  const digests = repositoryDigests(workspace);

  const listed = await vercelApi<{
    projects?: { id?: unknown; name?: unknown; accountId?: unknown }[];
  }>("/v9/projects?limit=100", token);
  const rows = listed.projects ?? [];
  const project = rows.find((p) => p.name === PROJECT_NAME);
  const landing = rows.find((p) => p.name === FORBIDDEN_PROJECT_NAMES[0]);
  if (
    !project ||
    typeof project.id !== "string" ||
    typeof project.accountId !== "string" ||
    !landing ||
    typeof landing.accountId !== "string"
  ) {
    console.log("refusing: the project or its scope could not be read");
    process.exitCode = 2;
    return;
  }
  const projectId = project.id;
  const accountId = project.accountId;
  const settled = await vercelApi<Record<string, unknown>>(
    `/v9/projects/${projectId}`,
    token,
  );
  const settings = judgeSettings(settled);
  console.log(`project_is_the_proved_one: ${project.name === PROJECT_NAME}`);
  console.log(`scope_equal_to_landing: ${accountId === landing.accountId}`);
  console.log(
    `install_command_exact: ${settled.installCommand === INSTALL_COMMAND}`,
  );
  console.log(
    `settings_hold_with_install_command: ${settingsHoldWithInstallCommand(settings)}`,
  );

  // ------------------------------------------- 2. the attachment, re-proved
  const domains = judgeDomains(await domainsOf(projectId, token));
  const record = await projectDomain(projectId, token).catch(() => null);
  const config = await domainConfig(token).catch(() => null);
  console.log(`attach_held: ${attachHeld(domains)}`);
  console.log(`ownership_verified: ${record?.verified === true}`);
  console.log(`returned_name_exact: ${record?.name === TARGET_DOMAIN}`);
  console.log(`misconfigured: ${config?.misconfigured === true}`);
  console.log(
    `config_conflicts: ${Array.isArray(config?.conflicts) ? config.conflicts.length : -1}`,
  );
  // The live CNAME must still be the exact target that was handed to Nil. A
  // hostname that resolves somewhere else is not our deployment, however
  // healthy every other field looks.
  const observed = Array.isArray(config?.cnames)
    ? config.cnames.filter((c): c is string => typeof c === "string")
    : [];
  const liveTargetExact =
    observed.length === 1 &&
    observed[0].replace(/\.$/, "") === EXPECTED_CNAME_TARGET;
  console.log(`live_cname_target_exact: ${liveTargetExact}`);
  // OUTSTANDING challenges, from `verification[]` on the project record.
  // `acceptedChallenges` answers a different question - what has already been
  // satisfied - and must not stand in for this one.
  const outstanding = (record as { verification?: unknown } | null)
    ?.verification;
  const challengeCount = Array.isArray(outstanding) ? outstanding.length : 0;
  console.log(`outstanding_verification_challenges: ${challengeCount}`);
  const attachmentOk =
    attachHeld(domains) &&
    record?.verified === true &&
    record?.name === TARGET_DOMAIN &&
    config?.misconfigured === false &&
    Array.isArray(config?.conflicts) &&
    config.conflicts.length === 0 &&
    liveTargetExact &&
    challengeCount === 0;
  if (
    accountId !== landing.accountId ||
    settled.installCommand !== INSTALL_COMMAND ||
    !settingsHoldWithInstallCommand(settings) ||
    !attachmentOk
  ) {
    console.log("stopping: the project or the attachment is not as approved");
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------ 3. production, before writes
  const { id: neonProjectId } = await neonProject();
  const productionBranch = await branchNamed(neonProjectId, PRODUCTION_BRANCH);
  // A branch NAMED production is not the same claim as THE production branch.
  // The D1/D2 proof: exactly one default branch in the project, with no parent,
  // and it is the one this name resolved to.
  const all = await branches(neonProjectId);
  const defaults = all.filter((b) => b.isDefault && !b.hasParent);
  const isTheOneDefault =
    defaults.length === 1 &&
    defaults[0].name === PRODUCTION_BRANCH &&
    defaults[0].id === productionBranch.id;
  console.log(`production_is_the_one_default: ${isTheOneDefault}`);
  console.log(`production_has_no_parent: ${!productionBranch.hasParent}`);
  const target = await targetFor(PRODUCTION_BRANCH);
  console.log(`production_host_from_api: ${target.hostFromApi}`);
  console.log(
    `production_branch_id_matches: ${target.branch.id === productionBranch.id}`,
  );
  if (
    !isTheOneDefault ||
    productionBranch.hasParent ||
    target.branch.id !== productionBranch.id
  ) {
    console.log("stopping: that is not provably the production branch");
    process.exitCode = 1;
    return;
  }
  const store = await Store.open(target.dsn);
  CLEANUP.push(() => store.close());
  console.log(`production_bounds_governed: true`);
  const before = await rowCounts(store);
  for (const [table, n] of Object.entries(before)) {
    console.log(`  production_before_${table}: ${n}`);
  }
  // The before reading is judged by the mode's own rule, and then BECOMES the
  // expectation for every later reading: what this phase promises is that the
  // deploy changes no user data, not that user data has some fixed shape.
  const beforeOk = beforeRowsAcceptable(mode, before);
  console.log(`production_rows_as_expected: ${beforeOk}`);
  if (!beforeOk) {
    console.log("stopping: production does not hold the expected rows");
    process.exitCode = 1;
    return;
  }
  const wantRows = afterRowsExpected(before);

  const inventoryBefore = await inventory(projectId, token);
  console.log(`env_count_before: ${inventoryBefore.length}`);
  const beforeVerdict = judgeByTarget(
    inventoryBefore,
    PREVIEW_SHAPES,
    expectedProductionBefore(mode),
    FORBIDDEN_ENV_NAMES,
  );
  console.log(`env_before_exact: ${beforeVerdict.exact}`);
  if (!beforeVerdict.exact) {
    console.log("stopping: the environment is not the approved starting state");
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------ 4. the seven writes
  //
  // A REDEPLOY READS NO CREDENTIAL AND GENERATES NONE. It writes nothing, so
  // opening the secret files or minting an AUTH_SECRET would be handling
  // credentials for no reason - and a non-empty secret would send the probe
  // child down its authenticated branch, whose extra lines the parent would
  // then refuse. `buildHolders` returns null for a redeploy and touches
  // neither reader.
  const holders = buildHolders(mode, {
    readOauth: () =>
      readEnvFileStrict(
        path.join(os.homedir(), "nil", "secrets", "control-plane-oauth.env"),
        ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      ),
    readMint: () =>
      readEnvFileStrict(
        path.join(os.homedir(), "nil", "secrets", "control-plane-mint.env"),
        ["CONTROL_PLANE_MINT_TOKEN"],
      ),
    generate: () => crypto.randomBytes(32).toString("base64"),
    dsn: target.dsn,
  });
  console.log(`credentials_read: ${holders !== null}`);
  if (holders) {
    console.log(`secret_files_strict: true`);
    console.log(`auth_secret_bytes: 32`);
    CLEANUP.push(() =>
      dropHolders([holders.oauth, holders.mint, holders.values], [holders]),
    );
  }

  let written = 0;
  // EMPTY in redeploy mode, so no mutating env call is reachable at all.
  for (const shape of envWritesFor(mode)) {
    const write: EnvWrite = {
      key: shape.key,
      value: holders?.values.get(shape.key) ?? "",
      type: shape.type,
      target: [shape.target],
    };
    if (write.value.length === 0) {
      console.log(`stopping: no value for ${shape.key}`);
      console.log(`env_written_count: ${written}`);
      process.exitCode = 1;
      return;
    }
    let fact: EnvFact;
    try {
      fact = await createEnv(projectId, token, write);
    } catch {
      // PARTIAL WRITE. Reported, never repaired: no delete, no PATCH, no retry.
      console.log(`stopping: a write failed at ${shape.key}`);
      console.log(`env_written_count: ${written}`);
      console.log(
        "PARTIAL PRODUCTION ENVIRONMENT - no reconciliation attempted",
      );
      process.exitCode = 1;
      return;
    }
    const exact =
      fact.key === shape.key &&
      fact.type === shape.type &&
      fact.target.join(",") === shape.target;
    console.log(`  wrote_${shape.key}: ${exact}`);
    if (!exact) {
      console.log(`stopping: ${shape.key} did not come back as asked`);
      console.log(`env_written_count: ${written + 1}`);
      process.exitCode = 1;
      return;
    }
    written += 1;
  }
  console.log(`env_written_count: ${written}`);

  const inventoryAfter = await inventory(projectId, token);
  const envVerdict = judgeByTarget(
    inventoryAfter,
    PREVIEW_SHAPES,
    PRODUCTION_SHAPES,
    FORBIDDEN_ENV_NAMES,
  );
  console.log(`env_total: ${envVerdict.totalFacts}`);
  console.log(`env_every_single_target: ${envVerdict.everySingleTarget}`);
  console.log(`env_duplicates: ${envVerdict.duplicates.length}`);
  console.log(`env_preview_exact: ${envVerdict.previewExact}`);
  console.log(`env_production_exact: ${envVerdict.productionExact}`);
  console.log(`env_forbidden_present: ${envVerdict.forbiddenPresent.length}`);
  console.log(`env_exact: ${envVerdict.exact}`);
  if (!envVerdict.exact) {
    console.log("stopping: the environment is not exactly what was approved");
    process.exitCode = 1;
    return;
  }

  // --------------------------------------------- 5. the one production deploy
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "d3-production-"));
  const tarball = path.join(os.tmpdir(), `${path.basename(created)}.tar`);
  let cliExit = -1;
  let startedAtMs = 0;
  let cleanupThrew = false;
  /** Has `deploy --prod` been invoked? Everything after this becomes true is
   * covered by the rollback guard; everything before it stops without a
   * detach, because nothing public has changed yet. */
  let invoked = false;
  try {
    const archived = Bun.spawnSync(["git", "archive", "-o", tarball, head]);
    const extracted = Bun.spawnSync(["tar", "-xf", tarball, "-C", created]);
    fs.rmSync(tarball, { force: true });
    if (archived.exitCode !== 0 || extracted.exitCode !== 0) {
      console.log("stopping: the archive could not be made");
      process.exitCode = 1;
      return;
    }
    const transform = transformArtifact(created, workspace);
    console.log(`transform_is_exact: ${transformIsExact(transform)}`);
    const archive = judgeArchive(created);
    console.log(`archive_holds: ${archiveAllHold(archive)}`);
    console.log(
      `repository_unchanged: ${repositoryUnchanged(workspace, digests)}`,
    );
    if (
      !transformIsExact(transform) ||
      !archiveAllHold(archive) ||
      !repositoryUnchanged(workspace, digests)
    ) {
      console.log("stopping: the artifact is not the proved one");
      process.exitCode = 1;
      return;
    }

    startedAtMs = Date.now();
    // FROM HERE ON THE DOMAIN IS AT RISK. Everything after this assignment is
    // covered by `afterInvocation`, including a spawn that throws.
    invoked = true;
    try {
      const spawned = await spawnIn(
        created,
        ["bun", "x", CLI_SPEC, "deploy", "--prod", "--yes"],
        {
          VERCEL_TOKEN: token,
          VERCEL_ORG_ID: accountId,
          VERCEL_PROJECT_ID: projectId,
        },
      );
      cliExit = spawned.code;
    } catch {
      // A child that could not run is a failed deployment attempt, not an
      // excuse to leave the guard.
      cliExit = -1;
    }
    console.log(`deploy_spawned: ${invoked}`);
    console.log(`cli_exit: ${cliExit}`);
  } finally {
    // NON-ESCAPING. This runs before the guard is entered, so a throw here
    // would leave a public production deployment with the domain attached and
    // nobody detaching it - the exact class the guard exists to close.
    try {
      if (removable(created, created, workspace)) {
        fs.rmSync(created, { recursive: true, force: true });
      }
    } catch {
      cleanupThrew = true;
    }
  }
  if (!invoked) {
    // Nothing public changed yet, so a cleanup failure stops without a detach,
    // and it may be reported straight away.
    console.log(`artifact_cleanup_failed: ${cleanupThrew}`);
    if (cleanupThrew) process.exitCode = 1;
    return;
  }

  // From here NOTHING is printed directly. Every callback below writes its
  // fixed lines into `notes`, and `guardedRun` flushes them only once the
  // outcome - including a detach - is known.
  const notes: string[] = [];
  const say = (line: string): void => {
    notes.push(line);
  };
  const outcome = await guardedRun(
    {
      rollback: (because) => rollback(projectId, token, because),

      artifactCleanupHeld: async () => !cleanupThrew,

      correlateAndAwaitReady: async () => {
        // The CLI's own exit code is part of the conjunction: a correlated READY
        // record is not permission to ignore a child that reported failure.
        if (cliExit !== 0) {
          say("stopping: the deploy child did not exit cleanly");
          return false;
        }
        const deployments = await vercelApi<{
          deployments?: {
            uid?: unknown;
            projectId?: unknown;
            createdAt?: unknown;
            target?: unknown;
          }[];
        }>(`/v6/deployments?projectId=${projectId}&limit=1`, token);
        const row = deployments.deployments?.[0];
        const ours = row
          ? deploymentIsOurs(row, projectId, startedAtMs)
          : false;
        say(`deployment_found: ${row !== undefined}`);
        say(`deployment_is_this_run: ${ours}`);
        say(`deployment_is_production: ${row?.target === "production"}`);
        if (
          !row ||
          !ours ||
          typeof row.uid !== "string" ||
          row.target !== "production"
        ) {
          return false;
        }
        const uid = row.uid;
        let state = "unexpected";
        for (let i = 0; i < 240; i++) {
          const detail = await vercelApi<{ readyState?: unknown }>(
            `/v13/deployments/${uid}`,
            token,
          );
          state = shapedState(detail.readyState);
          if ((TERMINAL as readonly string[]).includes(state)) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        say(`deployment_state: ${state}`);

        const log = await vercelApiText(
          `/v2/deployments/${uid}/events?builds=1&limit=1000`,
          token,
        ).catch(() => "");
        const build = judgeBuild(log);
        const held = buildEvidenceAllHold(build);
        for (const [key, value] of Object.entries(build)) {
          say(`  build_${key}: ${value}`);
        }
        say(`build_evidence_all_hold: ${held}`);
        return state === "READY" && held;
      },

      rowsZeroAfterDeploy: async () => {
        const counts = await rowCounts(store);
        const asExpected = rowsMatch(counts, wantRows);
        say(`production_rows_as_expected_after_deploy: ${asExpected}`);
        return asExpected;
      },

      awaitCertificate: async () => {
        const wait = await awaitTls({
          offsets: TLS_OFFSETS_MS,
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          startedAtMs: Date.now(),
          check: async () => {
            // Certificate verification is ON. There is no insecure path here.
            const res = await fetch(`${PUBLIC_ORIGIN}/`, {
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            });
            return res.status > 0;
          },
        });
        say(`tls_reads: ${wait.reads}`);
        say(`tls_verified: ${wait.verified}`);
        say(`tls_within_deadline: ${wait.elapsedMs <= 900_000 + 30_000}`);
        return wait.verified;
      },

      probe: async () => {
        const probe = await spawnIn(
          path.join(workspace, "control-plane", "web"),
          ["bun", "e2e/production-probe.ts"],
          {},
          // Every secret this coordinator holds goes down the same stdin-only
          // channel, so the child can scan for ALL of them rather than only the
          // one it needed. The OAuth CLIENT ID is deliberately absent: it is
          // public and appears in the sign-in page by design.
          `${JSON.stringify(
            probeInputFor(mode, holders, {
              accountId: crypto.randomUUID(),
              email: `absent-${crypto.randomUUID()}@example.invalid`,
              instanceId: crypto.randomUUID(),
              operationId: crypto.randomUUID(),
            }),
          )}\n`,
        );
        const expectations = probeExpectationsFor(mode);
        const verdict = judgeProbe(probe.stdout, probe.code, expectations);
        // ONLY the closed set is printed, so an unexpected name cannot reach a
        // transcript even as evidence of itself - its COUNT does.
        for (const name of probeKeysFor(expectations)) {
          if (name in verdict.parsed) {
            say(`  probe_${name}: ${verdict.parsed[name]}`);
          }
        }
        say(`probe_exit: ${probe.code}`);
        say(`probe_missing: ${verdict.missing.length}`);
        say(`probe_mismatched: ${verdict.mismatched.length}`);
        say(`probe_unexpected: ${verdict.unexpected.length}`);
        say(`probe_duplicated: ${verdict.duplicated.length}`);
        for (const name of verdict.mismatched) say(`  mismatched: ${name}`);
        for (const name of verdict.missing) say(`  missing: ${name}`);
        say(`probe_signed_out_refused: ${verdict.signedOutRefused}`);
        say(`probes_ok: ${verdict.ok}`);
        return verdict.ok;
      },

      finalStateHolds: async () => {
        const after = await rowCounts(store);
        for (const [table, n] of Object.entries(after)) {
          say(`  production_after_${table}: ${n}`);
        }
        const dataHeld = rowsMatch(after, wantRows);
        say(`production_rows_as_expected_after_probes: ${dataHeld}`);
        const stillAttached = attachHeld(
          judgeDomains(await domainsOf(projectId, token)),
        );
        say(`attachment_still_held: ${stillAttached}`);
        // (3) THE ENVIRONMENT, RE-PROVED AFTER THE DEPLOYMENT. A redeploy that
        // altered it would be exactly what this mode promises not to do, and
        // the first deploy never checked afterwards at all.
        const finalEnv = judgeByTarget(
          await inventory(projectId, token),
          PREVIEW_SHAPES,
          PRODUCTION_SHAPES,
          FORBIDDEN_ENV_NAMES,
        );
        say(`env_total_after_deploy: ${finalEnv.totalFacts}`);
        say(`env_exact_after_deploy: ${finalEnv.exact}`);
        return dataHeld && stillAttached && finalEnv.exact;
      },
    },
    console.log,
    notes,
    cleanupThrew,
  );

  if (outcome.kind === "parked-no-tls") {
    // The manager-ruled exception: a certificate that never arrived is a
    // finding, not a failed acceptance predicate. The domain stays attached.
    console.log("parking: no certificate inside the bounded window");
    console.log("no detach, no retry, no certificate issuance");
    process.exitCode = 3;
    return;
  }
  if (outcome.kind === "rolled-back") {
    console.log("production_phase_held: false");
    process.exitCode = 1;
    return;
  }
  console.log("production_phase_held: true");
  console.log("parked: for Nil's interactive Google sign-in");
}

/**
 * The rollback lever, wired to the one constant hostname on the proved project.
 *
 * Detach FIRST, then diagnosis - the ruling is explicit that a failing state is
 * never left public while somebody works out why. A rollback that does not hold
 * is escalated before anything else happens.
 */
async function rollback(
  projectId: string,
  token: string,
  because: string,
): Promise<void> {
  console.log(`rolling back: ${because}`);
  let held = false;
  try {
    await detach(projectId, projectId, token);
    held = detachHeld(judgeDomains(await domainsOf(projectId, token)));
  } catch {
    held = false;
  }
  console.log(`detach_held: ${held}`);
  if (!held) console.log("DOMAIN ROLLBACK FAILED - escalate before diagnosis");
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    for (const drop of CLEANUP.splice(0)) {
      try {
        await drop();
      } catch {
        // Best effort by definition: a pool that will not close must not
        // replace the report of what actually happened.
      }
    }
  }
}
