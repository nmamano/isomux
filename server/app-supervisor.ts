// The app supervisor - the ONE place isomux touches systemd. Unit generation,
// start/stop/enable, state reads, and journald logs for the apps the registry
// holds. See internal-docs/agent-apps-design.md section 2.
//
// The registry (server/app-registry.ts) owns names, ports and persistence and
// runs nothing; this module runs things and persists nothing. The only state it
// keeps is a short-lived cache of what systemd last said.
//
// THE ISOLATION RAIL is what shapes this module. systemd is MACHINE-GLOBAL:
// there is one user manager per box, and a unit name is a global identifier
// shared by every process that speaks to it. So an office running against a
// throwaway state root - a test, an isolated instance - could stop, restart or
// delete the units of the REAL office running on the same box. Two mechanisms
// keep that from being possible rather than merely unlikely:
//
//   1. ONE SEAM. Every systemctl invocation, every journalctl invocation and
//      every unit-file write or removal goes through `SupervisorHost`. Nothing
//      else in the tree shells out to systemd. A test injects a fake host and
//      is then structurally incapable of reaching the machine, rather than
//      being trusted not to.
//   2. THE UNIT NAMESPACE FOLLOWS THE STATE ROOT. `isomux-app-<name>.service`
//      is the production namespace and belongs to the office on the default
//      state root. Any other state root gets its own prefix (see
//      unitPrefixFor). That is not a testing affordance bolted on: two offices
//      on one box with different ISOMUX_HOMEs hold two different apps.json,
//      and sharing a unit namespace between them means one office's delete
//      stops the other office's app. The isolated-instance demo can therefore
//      boot the REAL server and still be unable to name a production unit.
//
// WHY THE COMMAND NEVER APPEARS IN ExecStart. An app's start command is stored
// verbatim as a free-form shell string ("bun run dev", "npm start && tail -f
// x"), because that is what an agent types. systemd does its OWN unquoting of
// ExecStart - C-style escapes, quote removal, and `%` specifier expansion - so
// interpolating that string would mean escaping it correctly through systemd's
// parser, and any mistake silently mangles the command instead of failing. So
// isomux writes the command, byte for byte, into a launcher script it owns, and
// ExecStart names only that script. There is no escaping to get wrong.
//
// The launcher lives beside the registry state, NOT in the app's own data
// directory: the app can write to its data directory, and a program that can
// rewrite its own launcher is a program that can change what isomux starts as
// it on the next boot. The app's token environment file sits beside it for the
// same reason (server/app-tokens.ts owns the token itself).
//
// THREE GENERATED FILES PER APP, and they are regenerated on different
// schedules, which is the detail to hold onto:
//   - the launcher and the unit are rewritten whenever the record changes,
//     because they are derived from it;
//   - the token file is written ONCE, at registration, and never regenerated,
//     because isomux keeps only the token's hash and could not reproduce its
//     contents. That is exactly why an update preserves an app's token instead
//     of rotating it on every edit.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { IS_DEFAULT_STATE_ROOT, STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import { appHostDomain, appPublicUrl } from "./app-domain.ts";
import type { AppRecord } from "../shared/types.ts";
import type { AppErrorCode, AppState } from "../shared/contract-shapes.ts";

// --- constants --------------------------------------------------------------

// Resource limits. Plain named constants, not per-deployment configuration:
// the point is a ceiling low enough that one runaway app cannot take the box
// (and with it the office) down, which is the failure mode the design doc names
// for hosted. An app that exceeds MemoryMax is killed and restarted by systemd,
// so hitting it reads as a restart count climbing rather than as silence.
// 512M rather than a rounder 1G: on a 2G VPS - the common hosted size - a 1G
// ceiling lets a single broken app take half the box before its cgroup limit
// does anything, which is the failure the limit exists to prevent.
export const APP_MEMORY_MAX = "512M";
// The launcher holds agent-authored code, so it is not world-readable.
export const APP_LAUNCHER_MODE = 0o600;
// The environment file holds the app's token in plaintext (see the token
// section below), so it gets the same treatment.
export const APP_TOKEN_ENV_MODE = 0o600;
// Created for the directory that holds those two, when isomux creates it.
export const APP_PRIVATE_DIR_MODE = 0o700;
// The variable an app reads its own isomux token out of.
export const APP_TOKEN_ENV_VAR = "ISOMUX_APP_TOKEN";
// The variable an app reads its own public address out of. Injected ONLY when
// the office has one, so `if (process.env.ISOMUX_APP_URL)` is a truthful test
// of "am I reachable at a hostname" - an empty value would answer that
// question wrongly on every dev box.
export const APP_URL_ENV_VAR = "ISOMUX_APP_URL";
export const APP_HOST_ENV_VAR = "ISOMUX_APP_HOST";
export const APP_LOOPBACK_HOST = "127.0.0.1";
const VITE_ALLOWED_HOST_ENV_VAR = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";
export const APP_CPU_QUOTA = "100%";
// Only AUTOMATIC restarts wait; an explicit restart through the API does not.
export const APP_RESTART_SEC = 2;
export const APP_STOP_TIMEOUT_SEC = 10;

// When to stop trying. An app whose command is simply broken must come to REST
// in `failed`, where its state says so and the restart verb can pick it back
// up - not spin forever burning CPU and filling the journal.
//
// These are set explicitly rather than left to systemd's defaults, and that is
// a correction rather than a preference: the defaults (5 starts per 10 seconds)
// are borderline against RestartSec=2, so a permanently broken app was measured
// still looping past 15 restarts instead of giving up. Five attempts in a
// minute is unambiguous, while a healthy app that crashes once in a while never
// approaches it.
export const APP_START_LIMIT_INTERVAL_SEC = 60;
export const APP_START_LIMIT_BURST = 5;

// How long a systemd state read stays good. Reads are per-request and the Apps
// tab will poll, so the alternative is a subprocess per app per render. Short
// enough that a state change is visible on the next refresh, long enough that a
// burst of reads costs one `systemctl show`.
export const APP_STATE_CACHE_MS = 1500;

export const APP_LOG_LINES_DEFAULT = 100;
export const APP_LOG_LINES_MAX = 1000;

// systemd user units inherit a minimal environment, so PATH is built rather
// than borrowed. This is the tail of it - the bit every Linux box has.
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin";

// --- errors -----------------------------------------------------------------

// A supervisor failure carries the same wire vocabulary as a registry failure,
// so the route handler maps one exhaustive table of codes to statuses. Distinct
// CLASS, though, not a subclass of AppRegistryError: "the registry refused" and
// "the machine refused" are different diagnoses and the handler treats them so.
export class AppSupervisorError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppSupervisorError";
  }
}

const failed = (what: string, detail: string): AppSupervisorError =>
  new AppSupervisorError(
    "supervisor_failed",
    `${what}: ${detail.trim() || "no error output"}`,
  );

// --- the seam ---------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Everything that touches the machine. See the isolation rail in the header:
// this interface is the whole surface, so a fake here is a complete fake.
export interface SupervisorHost {
  // Where systemd reads user units from. Production: ~/.config/systemd/user.
  unitDir: string;
  // Where isomux keeps the generated launcher scripts.
  launcherDir: string;
  // `mode` is honoured where the host has a filesystem; the launcher and the
  // token environment file ask for 0600 because they hold agent-authored code
  // and a live credential.
  writeFile(path: string, contents: string, mode?: number): void;
  // Read a file isomux generated, or null when it is not there. Exists for ONE
  // caller: reading an app's token environment file back, which is how boot
  // reconciliation checks a stored hash against the plaintext the app is
  // actually being given. A missing file is null rather than a throw - an app
  // registered before tokens existed simply has none.
  readFile(path: string): string | null;
  // Idempotent: removing a path that is not there is a success, because
  // teardown must be able to finish a delete that already half-happened.
  removeFile(path: string): void;
  run(argv: string[]): RunResult;
}

export function createSystemdHost(): SupervisorHost {
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return {
    unitDir: join(configHome, "systemd", "user"),
    launcherDir: join(STATE_ROOT, "apps", "units"),
    writeFile(path, contents, mode) {
      // A private file asks for a private directory. The file mode is what
      // actually protects the contents; the directory mode keeps a listing of
      // which apps exist and where their secrets live from being world-
      // readable too. Only applies to a directory isomux CREATES - one that is
      // already there keeps whatever mode it has.
      mkdirSync(dirname(path), {
        recursive: true,
        ...(mode !== undefined ? { mode: APP_PRIVATE_DIR_MODE } : {}),
      });
      // The mode is applied to the temp file BEFORE it is published, so the
      // launcher is never briefly world-readable at the ambient umask.
      atomicWriteFileSync(path, contents, mode);
    },
    readFile(path) {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    removeFile(path) {
      rmSync(path, { force: true });
    },
    run(argv) {
      // NEVER through a shell: every argument here is a unit name or a flag,
      // and a shell would put an app name (agent-chosen) in front of a parser.
      const r = spawnSync(argv[0], argv.slice(1), {
        encoding: "utf-8",
        timeout: 30_000,
      });
      if (r.error) {
        // ENOENT (no systemctl at all) and a timeout land here. Reported as a
        // non-zero run rather than thrown, so one failure shape reaches callers.
        return { code: 127, stdout: "", stderr: r.error.message };
      }
      return {
        code: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
  };
}

// --- the unit namespace -----------------------------------------------------

// The unit-name prefix for an office on `stateRoot`.
//
// The production office (default state root) gets the bare `isomux-app-`
// namespace, which is the locked production naming. Every other state root gets
// a namespace of its own, derived from the root's path, for the reason in the
// header: two offices on one box must not be able to name each other's units.
// The digest is what makes it derived rather than configured - there is no knob
// to set wrong, and an isolated instance cannot opt back into production.
//
// THE DOT IS THE WHOLE ISOLATION ARGUMENT. An app name cannot contain `.` (the
// grammar is `[a-z0-9-]`, because the name has to survive as a DNS label), so
// no production app - however it is named, and whoever names it - can render to
// a unit name in this namespace. Without it the separation would rest on a
// digest being hard to guess, which is not a property anyone should have to
// rely on: the state root is not a secret, so a name that collides is something
// an app author could construct on purpose. A forbidden character makes the two
// namespaces disjoint by construction instead. systemd accepts a `.` inside a
// unit name (verified with systemd-analyze; it splits the type suffix off the
// LAST dot), and the result still matches the `isomux-app-test-*` glob the
// standing rail asks test units to be findable under.
//
// The full digest, not a prefix of it, for the same reason: truncating to eight
// hex characters would squeeze every state root on the box into a 32-bit space
// for no saving that matters.
export function unitPrefixFor(stateRoot: string, isDefault: boolean): string {
  if (isDefault) return "isomux-app-";
  const digest = createHash("sha256").update(stateRoot).digest("hex");
  return `isomux-app-test-.${digest}-`;
}

export const unitNameFor = (prefix: string, appName: string): string =>
  `${prefix}${appName}.service`;

// --- unit + launcher rendering (pure) ---------------------------------------

// Interpolating a value into a unit file, and systemd's rules are NOT uniform
// across directives - which is the sort of thing only a real systemd finds out.
//
// What every directive shares: `%` starts a specifier, so a literal one has to
// be doubled, and a newline ends the directive, so there is no way to express
// one and it is refused rather than silently truncating the unit.
//
// What they do NOT share is quoting. `Environment=` and `ExecStart=` are
// parsed with shell-like quoting, so a value with a space must be quoted.
// `WorkingDirectory=` is not: it takes the rest of the line as a literal path,
// and quoting it makes systemd read the leading `"` as part of the path and
// refuse the whole unit with "path is not absolute". Hence two helpers rather
// than one - the single-helper version passed its golden-file test and was
// rejected by systemd on the first real start.
function unitSafe(raw: string, what: string): string {
  // A newline ends the directive and a NUL truncates the value at the C-string
  // boundary. Neither has an escape that means what the caller wanted, so both
  // are refused rather than silently producing a different unit.
  if (/[\r\n\0]/.test(raw)) {
    throw new AppSupervisorError(
      "supervisor_failed",
      `${what} contains a line break or NUL, which cannot be expressed in a systemd unit file`,
    );
  }
  return raw.replace(/%/g, "%%");
}

// For a directive that is NOT quote-parsed: a bare path, spaces and all.
const unitPathValue = (raw: string, what: string): string =>
  unitSafe(raw, what);

// For a directive that IS quote-parsed (Environment, ExecStart): quoted, so a
// space cannot split the value, with the quote and backslash escaped.
function unitQuoted(raw: string, what: string): string {
  const escaped = unitSafe(raw, what)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// PATH for the app's unit. systemd hands a user unit a minimal environment, so
// `bun run dev` - by far the likeliest command an agent registers - would not
// even resolve `bun` without this.
//
// Two sources, in the order a developer's shell would find them:
//   - every node_modules/.bin from the app's own directory upward, nearest
//     first, which is how `vite` or `next` resolve without a package-manager
//     wrapper (the trick portless landed on for the same problem);
//   - the directory of the runtime running isomux itself, which is where `bun`
//     actually lives on a box that installed it the normal way (~/.bun/bin).
//
// Computed whenever the unit is written - at registration, and again on an
// update that changes the command or the working directory - and baked into the
// unit. So a node_modules that appears later is not picked up until something
// rewrites the unit. Recomputing on every start would need a unit rewrite per
// start; the trade is documented rather than chased.
export function computeAppPath(
  cwd: string,
  runtimeBinDir: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const dirs: string[] = [];
  let dir = cwd;
  for (;;) {
    const bin = join(dir, "node_modules", ".bin");
    if (exists(bin)) dirs.push(bin);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (runtimeBinDir) dirs.push(runtimeBinDir);
  return [...dirs, SYSTEM_PATH].join(":");
}

// The launcher script: isomux's own file, holding the agent's command verbatim.
// No `exec` in front of it - `exec a && b` would change what a compound command
// means, and the shell's own exit status is already the app's.
export function renderLauncher(app: AppRecord): string {
  return [
    "#!/bin/sh",
    `# Generated by isomux for the app "${app.name}". Do not edit: this file is`,
    "# rewritten when the app is registered and removed when it is deleted.",
    "# Below is the start command exactly as it was registered.",
    "",
    app.command,
    "",
  ].join("\n");
}

// The app's token, as systemd's EnvironmentFile format: bare `KEY=value` lines,
// no quoting, no `export`. The value is base64url by construction (asserted at
// mint time), so it needs none of systemd's quoting rules - which is the point,
// since a value systemd unquoted differently from what isomux hashed would be a
// token that silently never works.
export function renderTokenEnv(raw: string): string {
  return `${APP_TOKEN_ENV_VAR}=${raw}\n`;
}

// Read a token back out of that file. Tolerant of what a person might have done
// to it by hand (blank lines, other variables, a trailing newline or not) and
// strict about what it returns: the first well-formed token line, or null -
// never a partial or empty value dressed up as a token.
export function parseTokenEnv(contents: string | null): string | null {
  if (!contents) return null;
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${APP_TOKEN_ENV_VAR}=`)) continue;
    const value = trimmed.slice(APP_TOKEN_ENV_VAR.length + 1);
    return value.length > 0 ? value : null;
  }
  return null;
}

// The one place the token directive's text lives, so the renderer and the check
// that an installed unit carries it cannot drift apart.
export const tokenEnvDirective = (tokenEnvPath: string): string =>
  `EnvironmentFile=-${unitPathValue(tokenEnvPath, "the app's token file path")}`;

// --- the app's public URL in the unit ---------------------------------------

// The one place the URL directive's text lives, for the same reason as the
// token's: the renderer writes it and boot reconciliation compares against it,
// and a second literal would let the two disagree about what "already correct"
// means.
export const appUrlEnvDirective = (url: string): string =>
  `Environment=${unitQuoted(`${APP_URL_ENV_VAR}=${url}`, "the app's public URL")}`;

export const appHostForUrl = (appUrl: string | null): string | null =>
  appUrl === null ? null : APP_LOOPBACK_HOST;

export const appHostEnvDirective = (host: string): string =>
  `Environment=${unitQuoted(`${APP_HOST_ENV_VAR}=${host}`, "the app's bind host")}`;

// What an INSTALLED unit says about one app environment assignment. Three
// answers, kept apart on purpose:
//   - no unit at all             -> { unit: false }
//   - a unit with no assignment  -> { unit: true, assignment: null }
//   - a unit that assigns it     -> { unit: true, assignment: "<the line>" }
//
// The third case returns the LINE, not a parsed value, and the caller compares
// it against the expected directive. That is what keeps "absent" and "present
// but empty" from collapsing into each other: an empty assignment is visible
// to the app, so it can never compare equal to "no assignment" and is rewritten
// like any other wrong value.
//
// LAST assignment wins, which is systemd's own rule for a variable set twice.
// The recognizer is deliberately broader than what this renderer emits - a
// hand-written unquoted or multi-assignment line still counts - because the
// safe direction here is to notice an assignment and rewrite the unit
// canonically, never to miss one and leave a wrong value live.
export type InstalledAppEnvAssignment =
  | { unit: false }
  | { unit: true; assignment: string | null };

function parseUnitEnvAssignment(
  contents: string | null,
  variable: string,
): InstalledAppEnvAssignment {
  if (contents === null) return { unit: false };
  let assignment: string | null = null;
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Environment=")) continue;
    const rest = trimmed.slice("Environment=".length);
    // A bare start, or one after whitespace or an opening quote: the three
    // places systemd can begin an assignment on this line.
    if (!new RegExp(`(^|[\\s"])${variable}=`).test(rest)) continue;
    assignment = trimmed;
  }
  return { unit: true, assignment };
}

export const parseUnitAppUrl = (
  contents: string | null,
): InstalledAppEnvAssignment =>
  parseUnitEnvAssignment(contents, APP_URL_ENV_VAR);

export const parseUnitAppHost = (
  contents: string | null,
): InstalledAppEnvAssignment =>
  parseUnitEnvAssignment(contents, APP_HOST_ENV_VAR);

export interface UnitRenderOpts {
  launcherPath: string;
  path: string;
  unitName: string;
  // Where the app's token env file lives. Referenced by PATH, never by value:
  // a unit file is not private (0664 at the usual umask, measured) and
  // `systemctl show` prints every `Environment=` value straight back, while an
  // EnvironmentFile shows only as its path. So the secret stays in a 0600 file
  // isomux owns, and the unit says where to find it.
  tokenEnvPath: string;
  // The app's public address, or null when this office has no app hostnames.
  // Required rather than optional so no call site can forget it: an app whose
  // unit silently lost its URL would keep serving and stop knowing its own
  // address, which is invisible from the outside.
  appUrl: string | null;
}

export function renderUnit(app: AppRecord, opts: UnitRenderOpts): string {
  const base = opts.unitName.replace(/\.service$/, "");
  // No URL, no line at all - not an empty one. See APP_URL_ENV_VAR.
  const appUrlLine =
    opts.appUrl === null ? "" : `\n${appUrlEnvDirective(opts.appUrl)}`;
  const appHost = appHostForUrl(opts.appUrl);
  const appHostLine =
    appHost === null ? "" : `\n${appHostEnvDirective(appHost)}`;
  // Vite gives this variable one additional allowed-host slot, not a list.
  // Spend it on the public app hostname; comma-joining a tailnet hostname too
  // would silently make one bogus entry. Other servers ignore this variable.
  const viteAllowedHostLine =
    opts.appUrl === null
      ? ""
      : `\nEnvironment=${unitQuoted(
          `${VITE_ALLOWED_HOST_ENV_VAR}=${new URL(opts.appUrl).hostname}`,
          "the app's Vite allowed host",
        )}`;
  return `# Generated by isomux. Do not edit: this file is rewritten when the app
# is registered and removed when it is deleted.
[Unit]
Description=Isomux app ${app.name}
After=network.target
# Give up after ${APP_START_LIMIT_BURST} restarts in ${APP_START_LIMIT_INTERVAL_SEC}s: a broken command should come
# to rest in the failed state, where it says so and the restart verb can pick
# it back up, rather than loop forever. Set explicitly because systemd's
# defaults are borderline against RestartSec=${APP_RESTART_SEC} and were measured NOT tripping.
StartLimitIntervalSec=${APP_START_LIMIT_INTERVAL_SEC}
StartLimitBurst=${APP_START_LIMIT_BURST}

[Service]
Type=simple
WorkingDirectory=${unitPathValue(app.cwd, "the app's working directory")}
Environment=${unitQuoted(`PORT=${app.port}`, "the app's port")}
Environment=${unitQuoted(`ISOMUX_APP_NAME=${app.name}`, "the app's name")}
Environment=${unitQuoted(`ISOMUX_APP_DATA_DIR=${app.dataDir}`, "the app's data directory")}
Environment=${unitQuoted(`PATH=${opts.path}`, "the app's PATH")}${appUrlLine}${appHostLine}${viteAllowedHostLine}
# The app's isomux token, by reference. The leading "-" makes the file optional:
# an app that has no token (one registered before tokens existed, or one whose
# token could not be provisioned) starts normally without ISOMUX_APP_TOKEN set,
# rather than refusing to start over a credential it may never need.
# Unquoted, like WorkingDirectory and NOT like Environment: measured on systemd
# 255, a quoted path here is read with the quotes as part of the filename and -
# because of that same leading "-" - fails SILENTLY, leaving the app running
# with no token and nothing said about it.
${tokenEnvDirective(opts.tokenEnvPath)}
ExecStart=/bin/sh ${unitQuoted(opts.launcherPath, "the app's launcher path")}
Restart=on-failure
RestartSec=${APP_RESTART_SEC}
TimeoutStopSec=${APP_STOP_TIMEOUT_SEC}
MemoryMax=${APP_MEMORY_MAX}
CPUQuota=${APP_CPU_QUOTA}
SyslogIdentifier=${base}

[Install]
WantedBy=default.target
`;
}

// --- reading systemd's answer (pure) ----------------------------------------

export interface AppRuntime {
  state: AppState;
  restartCount: number;
  // Why the last install or start attempt failed, when one did. IN MEMORY ONLY
  // and deliberately so: it is a fact about an attempt this process made, not a
  // property of the app, and a persisted one would outlive its own truth.
  //
  // It exists because `state` alone is not enough for the API's main consumer.
  // An agent cannot read the server log, and an INSTALL failure (a unit that
  // could not be written, a daemon-reload that refused) happens before journald
  // has a single line to show - so without this the reason for a dead app is
  // invisible from the outside. After a restart the field is gone and `state`
  // still reads failed or unknown, which is truthful; the next start attempt
  // regenerates it.
  startError?: string;
}

export const UNKNOWN_RUNTIME: AppRuntime = {
  state: "unknown",
  restartCount: 0,
};

// Parse `systemctl show <unit>... --property=...`. Units come back as blocks
// separated by a blank line, and the properties inside a block arrive in an
// ARBITRARY order (measured: NRestarts before Id), so a block is read into a
// map and identified by its own Id - never by position.
export function parseShowBlocks(
  stdout: string,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const block of stdout.split(/\n\s*\n/)) {
    const props = new Map<string, string>();
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
    }
    const id = props.get("Id");
    if (!id) continue;
    out.set(id, props);
  }
  return out;
}

export function parseSystemctlShow(stdout: string): Map<string, AppRuntime> {
  const out = new Map<string, AppRuntime>();
  for (const [id, props] of parseShowBlocks(stdout)) {
    out.set(id, {
      state: stateFrom(props.get("LoadState"), props.get("ActiveState")),
      restartCount: Number.parseInt(props.get("NRestarts") ?? "", 10) || 0,
    });
  }
  return out;
}

// Is this systemd answer PROOF that nothing is running? Deliberately separate
// from the wire mapping above, and deliberately a whitelist.
//
// The wire mapping is lossy in ways that are fine for a status badge and unsafe
// for a permanent decision: it folds a missing block, an unparseable one and an
// unrecognised state all into `unknown`, and it calls `deactivating` stopped.
// Reading any of those as "nothing is running" is how a delete frees a name and
// port whose process is still alive - `deactivating` in particular means the
// stop is still IN PROGRESS.
//
// So only two answers count, and both require systemd to have said something
// explicit: the unit is not there at all, or it is loaded and definitely at
// rest.
export function isProvablyNotRunning(
  props: Map<string, string> | undefined,
): boolean {
  if (!props) return false; // no block for this unit: not an answer
  const load = props.get("LoadState");
  if (load === "not-found") return true;
  if (load !== "loaded") return false; // missing, masked, error, anything else
  const active = props.get("ActiveState");
  return active === "inactive" || active === "failed";
}

// systemd's vocabulary mapped to the wire's. `not-found` is the load-bearing
// one: a registered app with no unit file is NOT "stopped" - nothing is
// arranged to run it at all - and calling that `unknown` keeps the difference
// visible instead of implying isomux is holding it stopped on purpose.
function stateFrom(
  loadState: string | undefined,
  activeState: string | undefined,
): AppState {
  if (loadState !== "loaded") return "unknown";
  switch (activeState) {
    case "active":
      return "running";
    case "activating":
    case "reloading":
      return "starting";
    case "failed":
      return "failed";
    case "inactive":
    case "deactivating":
      return "stopped";
    default:
      return "unknown";
  }
}

// --- the supervisor ---------------------------------------------------------

export interface AppSupervisor {
  // The unit name an app maps to. Exposed because the logs route and the tests
  // both need to name a unit without rebuilding the prefix rule.
  unitName(appName: string): string;
  // Write the unit + launcher, load them, and start the app. Throws when the
  // unit could not be INSTALLED; an app whose process fails to start is not an
  // error here - it is a state the caller can read.
  install(app: AppRecord): void;
  // Write an app's token into the environment file its unit reads, replacing
  // any earlier one. Called at registration (and by boot reconciliation)
  // immediately after the hash is persisted, so the pair is written together;
  // throws if the file could not be written, which is the caller's signal to
  // revoke the hash rather than leave one behind with no plaintext.
  //
  // A RUNNING app does not see a new token until it restarts - a process's
  // environment is fixed at exec. Nothing here restarts anything.
  provisionToken(appName: string, raw: string): void;
  // The token currently in an app's environment file, or null. The integrity
  // half of reconciliation: a hash means nothing without the plaintext the app
  // is actually being handed.
  readToken(appName: string): string | null;
  // Remove an app's token file. Best effort and idempotent - used when
  // provisioning half-happened, so that what is left behind is an app with no
  // token rather than one holding a plaintext nothing recognises.
  removeToken(appName: string): void;
  // Does the app's INSTALLED unit actually reference its token file? The third
  // fact reconciliation needs, and the one neither the hash nor the plaintext
  // can answer: a unit written before app tokens existed - or one whose write
  // failed after the token was provisioned - injects nothing, and a healthy
  // hash-plus-file pair sitting behind it would otherwise look like a working
  // token forever.
  unitInjectsToken(appName: string): boolean;
  // The app's INSTALLED unit file, verbatim, or null when there is none. Boot
  // URL reconciliation (server/app-url-reconcile.ts) is the only caller: it
  // reads the bytes to decide whether the unit still declares the right
  // address, and keeps them so a restart it could not complete can be undone.
  readUnitFile(appName: string): string | null;
  // Put previously-read bytes back and tell systemd. The rollback half of the
  // same pass, and NOT a general unit writer: the only legal argument is
  // something readUnitFile returned for this same app, because anything else
  // would be a unit isomux cannot regenerate from the record.
  restoreUnitFile(appName: string, contents: string): void;
  // Make systemd re-read its unit files. No activation, no file writes: the
  // one thing an on-disk unit cannot tell you is whether the long-lived user
  // manager ever loaded it, and a unit written by a previous isomux run whose
  // daemon-reload failed is invisible to systemd until somebody asks for one.
  reloadUnits(): void;
  // Converge an app's generated files on its record - launcher, unit,
  // daemon-reload - and DO NOTHING ELSE. No enable, no start, no restart.
  // Reinstall's file half without its activation half, for the one caller that
  // must not change what is running: boot reconciliation, which fixes files
  // under apps that are serving traffic.
  regenerate(app: AppRecord): void;
  // Regenerate an app's launcher and unit from a CHANGED record while
  // preserving prior activation intent: what was running is restarted into the
  // new command, what was at rest stays at rest, and what had no unit at all is
  // installed. Throws when the generated files could not be converged on the
  // record, or when the prior activation intent could not be established - see
  // the implementation for why the second one is not a silent no-op.
  reinstall(app: AppRecord): void;
  // Stop the app and remove everything isomux generated for it. Throws if the
  // app is still running afterwards, so a caller can safely treat a return as
  // "this app is gone".
  teardown(appName: string): void;
  start(appName: string): void;
  stop(appName: string): void;
  restart(appName: string): void;
  // Runtime state for a set of apps, in ONE systemctl call, cached briefly.
  states(appNames: readonly string[]): Map<string, AppRuntime>;
  logs(appName: string, lines: number): string[];
}

export interface AppSupervisorOptions {
  host?: SupervisorHost;
  unitPrefix?: string;
  // Where the runtime running isomux lives, prepended to the app's PATH.
  runtimeBinDir?: string;
  now?: () => number;
  cacheMs?: number;
  // The office's app-host domain, read whenever a unit is written. A function
  // rather than a value because the production supervisor is built at import
  // time and the domain is frozen later, in bootPrelude - and it defaults to
  // the real one, which THROWS before that freeze, rather than to null: a
  // default that answered "no domain" would turn app URLs off silently on a
  // deployment that has them.
  appHostDomain?: () => string | null;
}

export function createAppSupervisor(
  options: AppSupervisorOptions = {},
): AppSupervisor {
  const host = options.host ?? createSystemdHost();
  const prefix =
    options.unitPrefix ?? unitPrefixFor(STATE_ROOT, IS_DEFAULT_STATE_ROOT);
  const runtimeBinDir = options.runtimeBinDir ?? dirname(process.execPath);
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.cacheMs ?? APP_STATE_CACHE_MS;
  const hostDomain = options.appHostDomain ?? appHostDomain;

  const unitName = (appName: string) => unitNameFor(prefix, appName);
  const unitPath = (appName: string) => join(host.unitDir, unitName(appName));
  const launcherPath = (appName: string) =>
    join(host.launcherDir, `${appName}.sh`);
  // Beside the launcher, NOT in the app's own data directory: the data
  // directory is the one place the app itself writes, and a program that can
  // rewrite the file holding its own credential can hand isomux a token of its
  // choosing. (It is also in the backup set, and a live secret in a backup
  // tarball is a different problem.)
  const tokenEnvPath = (appName: string) =>
    join(host.launcherDir, `${appName}.env`);

  const cache = new Map<string, AppRuntime>();
  let cachedAt = 0;
  const invalidate = () => {
    cache.clear();
    cachedAt = 0;
  };

  // Last failed install/start per app. Survives the state cache (which is a
  // 1.5-second read cache) and not a process restart - see AppRuntime.
  const startErrors = new Map<string, string>();
  // Record and rethrow: the caller still gets the error, and a later read can
  // still say why. Every throwing path in install/start/restart goes through
  // this, so there is one place the field is written.
  const remember = <T>(appName: string, act: () => T): T => {
    try {
      const value = act();
      startErrors.delete(appName);
      return value;
    } catch (err) {
      if (err instanceof AppSupervisorError)
        startErrors.set(appName, err.message);
      invalidate();
      throw err;
    }
  };

  // Run one step of an install or teardown, turning ANY failure into an
  // AppSupervisorError tagged with the stage it happened in.
  //
  // This is what keeps the 201-after-commit contract honest. A raw filesystem
  // error - an unwritable unit directory, a full disk - would otherwise escape
  // as a plain Error, be missed by the recorder and by the register handler's
  // catch, and surface as a 500 for an app that HAD already been registered:
  // exactly the retry trap (retry -> name_taken) the contract exists to
  // prevent, and with no startError to explain it either.
  const stage = <T>(what: string, act: () => T): T => {
    try {
      return act();
    } catch (err) {
      if (err instanceof AppSupervisorError) throw err;
      throw failed(what, err instanceof Error ? err.message : String(err));
    }
  };

  // A systemctl call whose failure is the caller's problem.
  const must = (argv: string[], what: string): RunResult => {
    const r = host.run(argv);
    if (r.code !== 0) throw failed(what, r.stderr || r.stdout);
    return r;
  };
  // A systemctl call whose failure is tolerable - teardown's stop/disable on a
  // unit that was never installed, and reset-failed on a unit that never
  // failed. The end-state check at the bottom of teardown is what actually
  // decides whether the delete worked.
  const tolerate = (argv: string[]): RunResult => host.run(argv);

  const systemctl = (...args: string[]) => ["systemctl", "--user", ...args];

  // systemd's way of saying the unit is not there. Matched narrowly and only
  // where absence is genuinely fine (tearing down an install that never got as
  // far as writing a unit); anything else is a real failure.
  const isMissingUnit = (r: RunResult): boolean =>
    /(does not exist|not loaded|no such file|not found)/i.test(
      `${r.stderr} ${r.stdout}`,
    );

  // Clear a spent start-limit before trying to start. WITHOUT THIS THE
  // RECOVERY VERBS DO NOT RECOVER ANYTHING, which is the whole reason they
  // exist: once an app has burned its StartLimitBurst, systemd refuses every
  // subsequent start with "start request repeated too quickly" until the
  // counter is reset - measured, and it is exactly the state a crash-looping
  // app comes to rest in. Tolerated, because a unit that never failed answers
  // non-zero and that is not an error here.
  const clearStartLimit = (appName: string): void => {
    const r = host.run(systemctl("reset-failed", unitName(appName)));
    // NOT must(): measured on systemd 255, reset-failed exits 1 with "not
    // loaded" for a unit that is merely stopped, and a stopped app is exactly
    // what `start` is for - so a strict check here would break the normal path
    // before it ever tried to start anything. Anything OTHER than not-loaded
    // does propagate, because proceeding with the rate-limit counter still set
    // would report a start that systemd is about to refuse.
    if (r.code !== 0 && !isMissingUnit(r)) {
      throw failed(
        "the app's failed state could not be cleared",
        r.stderr || r.stdout,
      );
    }
  };

  // PROVE the app is not running, or throw. The query itself failing is a
  // throw, not an `unknown`: teardown's caller frees the app's name and port on
  // the strength of this, and "systemd did not answer" is not the same fact as
  // "systemd says nothing is running". A SUCCESSFUL not-found is safe - that is
  // what a removed unit looks like.
  const assertNotRunning = (
    appName: string,
    what: string,
    detail: string,
  ): void => {
    const r = host.run(
      systemctl(
        "show",
        unitName(appName),
        "--property=Id,LoadState,ActiveState,SubState,NRestarts",
      ),
    );
    if (r.code !== 0) {
      throw failed(
        `${what}, and systemd could not be asked whether it is still running`,
        r.stderr || r.stdout,
      );
    }
    const props = parseShowBlocks(r.stdout).get(unitName(appName));
    if (!isProvablyNotRunning(props)) {
      // Says what systemd actually answered rather than a mapped state, since
      // the whole point here is that the mapping loses the distinctions.
      const said = props
        ? `LoadState=${props.get("LoadState") ?? "?"} ActiveState=${props.get("ActiveState") ?? "?"}`
        : "no answer for this unit";
      throw failed(what, `systemd said ${said}; ${detail}`);
    }
  };

  // Put the generated files on disk for `app`, in the order install has always
  // used them: the launcher first, because a unit whose ExecStart names a
  // script that does not exist yet would fail on a daemon-reload that raced us.
  // Shared by install and reinstall so the two can never generate differently -
  // an app updated by PATCH gets byte-identical files to one registered with
  // the same values, including a PATH recomputed from its (possibly new) cwd.
  const writeGeneratedFiles = (app: AppRecord): void => {
    const unit = unitName(app.name);
    stage("the app's launcher script could not be written", () =>
      host.writeFile(
        launcherPath(app.name),
        renderLauncher(app),
        APP_LAUNCHER_MODE,
      ),
    );
    stage("the app's unit file could not be written", () =>
      host.writeFile(
        unitPath(app.name),
        renderUnit(app, {
          launcherPath: launcherPath(app.name),
          path: computeAppPath(app.cwd, runtimeBinDir),
          unitName: unit,
          tokenEnvPath: tokenEnvPath(app.name),
          // Read here, at every write, rather than captured once: install,
          // reinstall and regenerate then cannot produce units that disagree
          // about the app's address.
          appUrl: appPublicUrl(app.hostLabel, hostDomain()),
        }),
      ),
    );
  };

  // Write the files and tell systemd about them, without touching activation.
  // Shared by regenerate and reinstall so the two can never diverge on what
  // "the files agree with the record" means.
  const convergeFiles = (app: AppRecord, what: string): void => {
    writeGeneratedFiles(app);
    must(systemctl("daemon-reload"), what);
  };

  // What systemd says about a unit RIGHT NOW, captured rather than thrown.
  //
  // reinstall needs this before it writes anything, and needs it as an answer
  // it can hold onto rather than as control flow: the files must converge on
  // the record whether or not the read succeeded, so the failure cannot be
  // allowed to short-circuit the write. Returns the raw properties, never the
  // mapped AppState - the mapping folds "no unit at all", "unparseable" and
  // "unrecognised" together into `unknown`, and reinstall's whole branch
  // decision turns on telling those apart.
  const readUnitProps = (
    appName: string,
  ): { props: Map<string, string> } | { error: string } => {
    const unit = unitName(appName);
    const r = host.run(
      systemctl(
        "show",
        unit,
        "--property=Id,LoadState,ActiveState,SubState,NRestarts",
      ),
    );
    if (r.code !== 0)
      return { error: r.stderr || r.stdout || "no error output" };
    const props = parseShowBlocks(r.stdout).get(unit);
    // A successful `show` with no block for this exact unit is not an answer
    // about the unit - real systemd always emits one, so this is a systemctl
    // that answered about something else or output we cannot parse. Reading it
    // as "nothing is running" would silently leave a running app on its old
    // command.
    if (!props) return { error: `systemd gave no answer for ${unit}` };
    return { props };
  };

  const readStates = (appNames: readonly string[]): Map<string, AppRuntime> => {
    const result = new Map<string, AppRuntime>();
    if (appNames.length === 0) return result;
    const units = appNames.map(unitName);
    const r = host.run(
      systemctl(
        "show",
        ...units,
        "--property=Id,LoadState,ActiveState,SubState,NRestarts",
      ),
    );
    // A failed read is reported as `unknown`, never as `stopped`: "I could not
    // ask systemd" and "systemd says it is not running" are different facts,
    // and only one of them should look like a deliberate state on the Apps tab.
    const byUnit = r.code === 0 ? parseSystemctlShow(r.stdout) : new Map();
    for (const appName of appNames) {
      const runtime = byUnit.get(unitName(appName)) ?? UNKNOWN_RUNTIME;
      const startError = startErrors.get(appName);
      result.set(appName, startError ? { ...runtime, startError } : runtime);
    }
    return result;
  };

  return {
    unitName,

    provisionToken(appName, raw) {
      // Refused rather than written: a value carrying a line break would put a
      // second variable in the file, and one carrying a `#` or leading space
      // would come back through systemd's parser as something other than what
      // isomux hashed. The mint side already guarantees base64url; this is the
      // check that says so at the point where it matters.
      if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
        throw new AppSupervisorError(
          "supervisor_failed",
          "the app's token contains characters that cannot be written to an environment file",
        );
      }
      stage("the app's token file could not be written", () =>
        host.writeFile(
          tokenEnvPath(appName),
          renderTokenEnv(raw),
          APP_TOKEN_ENV_MODE,
        ),
      );
    },

    readToken(appName) {
      return parseTokenEnv(host.readFile(tokenEnvPath(appName)));
    },

    removeToken(appName) {
      host.removeFile(tokenEnvPath(appName));
    },

    unitInjectsToken(appName) {
      const unit = host.readFile(unitPath(appName));
      if (!unit) return false;
      // Line by line, and EXACT - not `includes`. A substring search says yes
      // to a commented-out `# EnvironmentFile=-...` and to a directive whose
      // path merely starts with this one (`...hello.env.backup`), and both of
      // those are units that inject nothing. Only leading and trailing
      // whitespace is forgiven, which is the one thing systemd itself ignores.
      const wanted = tokenEnvDirective(tokenEnvPath(appName));
      return unit.split("\n").some((line) => line.trim() === wanted);
    },

    readUnitFile(appName) {
      return host.readFile(unitPath(appName));
    },

    restoreUnitFile(appName, contents) {
      stage("the app's previous unit file could not be restored", () =>
        host.writeFile(unitPath(appName), contents),
      );
      must(
        systemctl("daemon-reload"),
        "systemd could not reload the app's restored unit",
      );
      // systemd is holding different bytes than it was a moment ago.
      invalidate();
    },

    reloadUnits() {
      try {
        must(
          systemctl("daemon-reload"),
          "systemd could not reload the app units",
        );
      } finally {
        // systemd's view of every app just changed; a cached read predates it.
        invalidate();
      }
    },

    regenerate(app) {
      try {
        convergeFiles(app, "systemd could not load the app's regenerated unit");
      } finally {
        // The unit changed under a possibly-running app, so any cached read of
        // its state is from before that.
        invalidate();
      }
    },

    install(app) {
      const unit = unitName(app.name);
      remember(app.name, () => {
        writeGeneratedFiles(app);
        invalidate();
        must(systemctl("daemon-reload"), "systemd could not load the new unit");
        // enable, then start - deliberately NOT `enable --now`. Splitting them
        // is diagnostics, not control flow: the route answers 201 either way
        // (the registration has already committed), and this is what lets the
        // recorded reason say WHICH step refused.
        must(
          systemctl("enable", unit),
          "systemd could not enable the app's unit",
        );
        const started = host.run(systemctl("start", unit));
        invalidate();
        if (started.code !== 0) {
          throw failed(
            "the app's unit could not be started",
            started.stderr || started.stdout,
          );
        }
      });
    },

    // The app's record changed; make the machine agree with it again.
    //
    // TWO THINGS HAVE TO BE TRUE AT ONCE, and the order below is what makes
    // them both true:
    //
    //   1. THE GENERATED FILES ALWAYS CONVERGE ON THE RECORD. The registry is
    //      the source of truth, so a unit still holding a command the record no
    //      longer has is the one outcome that must not survive this call - a
    //      later `start` would silently run the OLD command. So the write
    //      happens unconditionally, even when the state read before it failed.
    //   2. ACTIVATION INTENT IS PRESERVED, NEVER INVENTED. What was running is
    //      restarted into the new command; what the user stopped stays stopped;
    //      what has come to rest in `failed` stays there until somebody asks
    //      for it. Silently starting something that was deliberately not
    //      running is the surprising branch, and PATCH is not the verb for it.
    //
    // WHY THE STATE IS READ FIRST. After the unit is written and reloaded, an
    // app that never had a unit at all reads `loaded` + `inactive` - exactly
    // what a deliberately stopped app reads. The distinction is destroyed by
    // the very write this method has to make, so it has to be captured before.
    //
    // AND WHY "I COULD NOT TELL" IS AN ERROR RATHER THAN A NO-OP. Doing
    // nothing is a legitimate outcome here (a stopped app), so an unreadable
    // state falling into that branch would be indistinguishable from success:
    // the caller would be told its running app was updated while the app went
    // on serving the old command. It throws instead, which reaches the API as
    // `startError` on an otherwise truthful 200, and the restart verb is the
    // cure.
    reinstall(app) {
      remember(app.name, () => {
        try {
          const before = readUnitProps(app.name);
          // Convergence first, whatever the read said. The token file is NOT
          // among the regenerated files: isomux holds only its hash, so there
          // is nothing to rewrite it from, and leaving it alone is what makes
          // an update preserve the app's token instead of quietly rotating it.
          convergeFiles(app, "systemd could not load the app's updated unit");
          // Only now the retained read failure: a daemon-reload that refused
          // supersedes it, because then the files did NOT converge and that is
          // the more serious fact.
          if ("error" in before) {
            throw failed(
              "the app's files were updated but systemd could not be asked whether it was running, so it was not restarted; restart it to pick up the change",
              before.error,
            );
          }
          const unit = unitName(app.name);
          const load = before.props.get("LoadState");
          const active = before.props.get("ActiveState");
          if (load === "not-found") {
            // No unit before this call: the app was registered and never
            // installed, which is the case where a bad command left an app
            // stranded. Bringing it up is the whole point of fixing it.
            must(
              systemctl("enable", unit),
              "systemd could not enable the app's unit",
            );
            clearStartLimit(app.name);
            must(
              systemctl("start", unit),
              "the app's updated unit could not be started",
            );
          } else if (
            load === "loaded" &&
            (active === "active" ||
              active === "activating" ||
              active === "reloading")
          ) {
            clearStartLimit(app.name);
            must(
              systemctl("restart", unit),
              "the app could not be restarted into its updated command",
            );
          } else if (
            load === "loaded" &&
            (active === "inactive" ||
              active === "deactivating" ||
              active === "failed")
          ) {
            // At rest on purpose. The new files are in place and the next
            // start - whenever somebody asks for one - uses them.
          } else {
            // Masked, errored, or an answer we do not recognise. Not
            // classifiable as running or at rest, so it is reported rather
            // than guessed at.
            throw failed(
              "the app's files were updated but its previous state could not be established, so it was not restarted; restart it to pick up the change",
              `systemd said LoadState=${load ?? "?"} ActiveState=${active ?? "?"}`,
            );
          }
        } finally {
          // In a finally, and not only on the way out clean: every step above
          // can change systemd and then throw, so a cached state from before
          // the call is stale on the failure paths too - and the failure paths
          // are exactly the ones whose 200 response has to tell the truth.
          invalidate();
        }
      });
    },

    // Returning from here licenses the caller to drop the app's record and free
    // its name and port for the next app, so every step is written to make "I
    // could not tell" an error
    // rather than a pass. The distinction that matters throughout: a query that
    // SUCCEEDS and reports nothing running is proof; a query that FAILS is not
    // evidence of anything, and must never be read as one.
    teardown(appName) {
      const unit = unitName(appName);
      try {
        // 1. Stop. A failure is survivable only if we can then PROVE the app
        //    is not running - after an install that never wrote a unit, stop
        //    legitimately fails and there is nothing to stop.
        const stopped = host.run(systemctl("stop", unit));
        if (stopped.code !== 0) {
          assertNotRunning(
            appName,
            "the app could not be stopped",
            stopped.stderr || stopped.stdout,
          );
        }
        // 2. Disable. Only the narrow "there is no such unit" case is
        //    tolerated. Any other failure leaves an enabled symlink behind, and
        //    deleting the unit file under it gives systemd a dangling wants/
        //    entry to complain about on every reload from then on.
        const disabled = host.run(systemctl("disable", unit));
        if (disabled.code !== 0 && !isMissingUnit(disabled)) {
          throw failed(
            "the app's unit could not be disabled",
            disabled.stderr || disabled.stdout,
          );
        }
        // 3. Only now, with the app known not to be running, remove what
        //    isomux generated.
        stage("the app's generated files could not be removed", () => {
          host.removeFile(unitPath(appName));
          host.removeFile(launcherPath(appName));
          // The token's plaintext goes with them. Its hash is revoked by the
          // delete handler; removing the file here is what makes the pair
          // disappear together even if that revoke is retried.
          host.removeFile(tokenEnvPath(appName));
        });
        must(
          systemctl("daemon-reload"),
          "systemd could not unload the app's unit",
        );
        // A unit that came to rest in `failed` stays listed until its state is
        // reset, so without this the app lingers in `systemctl --user
        // list-units` after its files are gone - the exact thing the delete is
        // supposed to have finished. A unit that never failed answers non-zero
        // here, which is why it is tolerated.
        tolerate(systemctl("reset-failed", unit));
        // 4. The promise, restated after everything: a SUCCESSFUL query saying
        //    not-found or not-running. `unknown` from a failed query does not
        //    reach this - assertNotRunning refuses to read it that way.
        assertNotRunning(
          appName,
          "the app is still running after its unit was removed",
          "the app was NOT deleted",
        );
        // Only on the way out clean: the app is gone, so its remembered
        // failure has nothing left to describe. Clear it before the reusable
        // name can describe a replacement registration.
        startErrors.delete(appName);
      } finally {
        // On every exit, including the throwing ones: systemd may well have
        // changed before the step that failed, so a cached read from before is
        // stale either way.
        invalidate();
      }
    },

    start(appName) {
      remember(appName, () => {
        try {
          clearStartLimit(appName);
          must(
            systemctl("start", unitName(appName)),
            "the app could not be started",
          );
        } finally {
          // In a finally, not after the call: systemctl can change state and
          // still exit non-zero, so a cached read is stale on the failure path
          // exactly as much as on the success path.
          invalidate();
        }
      });
    },

    // NOT wrapped in remember: a stop is something somebody asked for, so it
    // neither produces a start error nor clears one. An app that failed and was
    // then stopped on purpose should still be able to say why it failed.
    stop(appName) {
      try {
        must(
          systemctl("stop", unitName(appName)),
          "the app could not be stopped",
        );
      } finally {
        invalidate();
      }
    },

    restart(appName) {
      remember(appName, () => {
        try {
          clearStartLimit(appName);
          must(
            systemctl("restart", unitName(appName)),
            "the app could not be restarted",
          );
        } finally {
          invalidate();
        }
      });
    },

    states(appNames) {
      const fresh = now() - cachedAt < cacheMs;
      if (fresh && appNames.every((n) => cache.has(n))) {
        const hit = new Map<string, AppRuntime>();
        for (const n of appNames) hit.set(n, cache.get(n)!);
        return hit;
      }
      const read = readStates(appNames);
      // Replaces rather than merges: entries read at different moments are not
      // one snapshot, and the cache is meant to be one.
      cache.clear();
      for (const [n, runtime] of read) cache.set(n, runtime);
      cachedAt = now();
      return read;
    },

    logs(appName, lines) {
      const n = Math.max(1, Math.min(APP_LOG_LINES_MAX, Math.trunc(lines)));
      const r = host.run([
        "journalctl",
        "--user",
        "-u",
        unitName(appName),
        "-n",
        String(n),
        "--no-pager",
        "--output=short-iso",
      ]);
      if (r.code !== 0) {
        throw failed("the app's logs could not be read", r.stderr || r.stdout);
      }
      const out = r.stdout.split("\n");
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
      return out;
    },
  };
}

// Production singleton. Constructing it touches nothing: no directory is
// created and no subprocess runs until an app is actually installed.
export const appSupervisor: AppSupervisor = createAppSupervisor();
