// The app registry - the leaf module behind /api/apps. Names, ports,
// tombstones, per-app data directories, and the two JSON files that hold them.
// See internal-docs/agent-apps-design.md.
//
// Nothing here starts a process. Registration allocates a port and reserves a
// name; running the app is the supervisor's job, and the registry deliberately
// persists no runtime state (see AppState in shared/contract-shapes.ts).
//
// THE PERMANENT-TOMBSTONE INVARIANT is what shapes the rest of this module. A
// name is bound to one app for good and a port is never recycled, because both
// outlive the app in places isomux cannot reach: a bookmark on someone's phone,
// a service worker and localStorage under a retired origin. Handing either one
// to a NEW app is the failure this registry exists to prevent. Two consequences
// that read as over-caution until you connect them to that invariant:
//
//   1. CORRUPTION FAILS LOUD, NEVER EMPTY. Every public operation - reads
//      included - starts from a validated snapshot of BOTH files, so a
//      malformed apps.json or app-history.json raises `registry_corrupt` and
//      nothing proceeds. Reading one file per operation would be the subtle
//      version of the same bug: a list() answered off a valid apps.json while
//      the history was unreadable is a worldview the registry cannot vouch for.
//      The tempting alternative - the load-time catch-and-return-[] used for
//      cronjobs and tasks - is actively unsafe here: an empty worldview would
//      re-issue a retired name, duplicate a live registration, and then persist
//      the truncated view over the file that still held the truth. Cronjobs can
//      afford it (a lost row is a job that stops firing); this cannot.
//      Validation is per-record AND cross-record (unique live names and ports,
//      unique retired ports, no live app on a retired port), because a set of
//      individually well-formed records can still be an impossible one.
//   2. PERSISTENCE FAILURES PROPAGATE. saveCronjobs-style catch-and-log would
//      report a registration that was never written, or a delete whose
//      tombstone never landed. Every write here throws `persist_failed` and the
//      caller answers 500 rather than pretending.
//
// Write ORDER carries the same reasoning. Registration creates the data
// directory and then writes the record: a crash between them leaves an orphan
// directory, which is recoverable. Deletion writes the TOMBSTONE first and then
// removes the live record: a crash between them leaves an app both live and
// tombstoned, which is a visible, fixable inconsistency - whereas
// record-removal-first would free the name and port permanently if the
// tombstone write failed, which is exactly the unrecoverable case.
//
// CONCURRENCY: every operation is fully synchronous, including the bind probe
// (Bun.listen throws synchronously on EADDRINUSE). A register() therefore runs
// read -> allocate -> write without yielding, so two concurrent POSTs cannot
// interleave and hand out the same port. Should any operation here ever become
// async, it needs a mutex - that is the assumption this note exists to flag.
//
// Pure helpers plus an INJECTABLE store (createAppRegistry) so unit tests can
// point at a temp dir and script the port probe, while production uses the
// default singleton over STATE_ROOT/apps - the shape memory-store.ts uses.

import { existsSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import type { AppRecord, RetiredApp } from "../shared/types.ts";
import type { AppErrorCode } from "../shared/contract-shapes.ts";

// --- constants --------------------------------------------------------------

// The allocation window. Chosen to dodge three separate hazards rather than for
// aesthetics:
//   - ABOVE 10080, the highest entry in the WHATWG fetch spec's "bad port" list
//     (which browsers refuse to connect to outright). The whole list is out of
//     range by construction, so there is no filter to forget.
//   - BELOW 32768, where Linux's ephemeral port range starts. An app allocated
//     inside it would lose its port to an outbound connection at random.
//   - Clear of the defaults agents and tooling actually reach for: 3000, 5173,
//     8000, 8080, 9000, and isomux's own 4000.
export const APP_PORT_MIN = 21000;
export const APP_PORT_MAX = 21999;

// Sanity ceiling, not a product limit (Nil's ruling: no app cap beyond a sanity
// check). A plain constant - nothing about it differs per deployment.
export const MAX_REGISTERED_APPS = 100;

// One DNS label. The name becomes a hostname later, so the limit is RFC 1035's,
// not a taste call.
export const MAX_APP_NAME_LENGTH = 63;
export const MAX_APP_COMMAND_LENGTH = 4096;
export const MAX_APP_DESCRIPTION_LENGTH = 200;

// A hostname label: lowercase alphanumerics and inner hyphens only.
const APP_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Names an app may not take, because something else already answers to them or
// will. Cheap to extend now and impossible later - every addition is a name
// somebody might already be using.
export const RESERVED_APP_NAMES: ReadonlySet<string> = new Set([
  "www",
  "api",
  "apps",
  "office",
  "isomux",
  "admin",
  "mail",
  "smtp",
  "ns1",
  "ns2",
  "localhost",
  "auth",
  "login",
  "static",
  "assets",
  "files",
  "health",
  "status",
  "ws",
  "docs",
  "cdn",
]);

// --- errors -----------------------------------------------------------------

// Every refusal and every failure the registry can raise, carrying the wire
// `error.code` the caller will see. The handler maps code -> HTTP status; the
// registry decides nothing about transport.
export class AppRegistryError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppRegistryError";
  }
}

// The recovery advice matters as much as the diagnosis. "Move it aside" is the
// reflex for a corrupt state file and it is exactly wrong here: a MISSING file
// reads as a fresh registry, so moving app-history.json aside would free every
// retired name and port at once, and moving apps.json aside would let live
// registrations be duplicated. The error must not recommend the one action that
// destroys the invariant it is explaining.
const corrupt = (file: string, why: string): AppRegistryError =>
  new AppRegistryError(
    "registry_corrupt",
    `${file} is unreadable (${why}). The app registry refuses to operate on a ` +
      `partial view of itself: a name or port it cannot see is one it could ` +
      `hand out twice. Restore or repair the file from a known-good copy, then ` +
      `retry. Do not delete it or move it aside - missing state is treated as a ` +
      `fresh registry.`,
  );

// --- pure validation --------------------------------------------------------

// Validate a proposed app name against the grammar and the reserved list.
// Returns the error to raise, or null when the name is acceptable. REJECTS
// rather than sanitizes: an agent chose this string and is about to put it in a
// URL it hands its boss, so silently registering `my_app` as `my-app` produces
// a working app at an address nobody was told about.
export function checkAppName(name: string): AppRegistryError | null {
  if (name.length === 0) {
    return new AppRegistryError("invalid_name", "name is required");
  }
  if (name.length > MAX_APP_NAME_LENGTH) {
    return new AppRegistryError(
      "invalid_name",
      `name must be at most ${MAX_APP_NAME_LENGTH} characters (one hostname label)`,
    );
  }
  if (!APP_NAME_PATTERN.test(name)) {
    return new AppRegistryError(
      "invalid_name",
      "name must be lowercase letters, digits and inner hyphens only, " +
        "starting and ending with a letter or digit (it becomes a hostname)",
    );
  }
  if (RESERVED_APP_NAMES.has(name)) {
    return new AppRegistryError(
      "reserved_name",
      `"${name}" is reserved by isomux and cannot be used as an app name`,
    );
  }
  return null;
}

// The three mutable fields, checked identically by register and update - shared
// rather than duplicated because a rule that held at registration and not at
// update is a rule that can be walked around: PATCH would become the way to put
// a blank command or a relative cwd into a record that could never have been
// registered with one.

export function assertCommand(command: string): void {
  // The command is stored VERBATIM (locked in the pickup). Trimming is used only
  // to decide whether it is blank; the length limit applies to what was actually
  // submitted, and what is persisted is the caller's exact string - whitespace
  // can be load-bearing inside a shell command.
  if (command.trim().length === 0) {
    throw new AppRegistryError("invalid_command", "command is required");
  }
  if (command.length > MAX_APP_COMMAND_LENGTH) {
    throw new AppRegistryError(
      "invalid_command",
      `command must be at most ${MAX_APP_COMMAND_LENGTH} characters`,
    );
  }
}

export function assertCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw new AppRegistryError("invalid_cwd", "cwd must be an absolute path");
  }
}

export function assertDescription(description: string): void {
  if (description.length > MAX_APP_DESCRIPTION_LENGTH) {
    throw new AppRegistryError(
      "invalid_description",
      `description must be at most ${MAX_APP_DESCRIPTION_LENGTH} characters`,
    );
  }
}

// --- port allocation --------------------------------------------------------

// Whether a port can actually be bound right now. Skips the two "somebody else
// has it" outcomes and PROPAGATES anything else, so a programmer or system
// error surfaces instead of quietly reading as "port busy" a thousand times
// over and reporting the range exhausted.
export function bindProbe(port: number): boolean {
  try {
    const server = Bun.listen({
      hostname: "0.0.0.0",
      port,
      socket: { data() {} },
    });
    server.stop(true);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EADDRINUSE" || code === "EACCES") return false;
    throw err;
  }
}

// Lowest free port in the window: not held by a live app, not tombstoned, and
// actually bindable.
//
// TOCTOU: the probe closes its socket immediately and the app binds the port
// much later (when a supervisor starts it), so something else can take the port
// in between. The probe narrows that window, it does not close it - it exists
// to skip ports already occupied by processes isomux never registered. The real
// backstop is the app failing to start, which is visible.
export function allocatePort(
  used: ReadonlySet<number>,
  probe: (port: number) => boolean = bindProbe,
): number {
  for (let port = APP_PORT_MIN; port <= APP_PORT_MAX; port++) {
    if (used.has(port)) continue;
    if (!probe(port)) continue;
    return port;
  }
  throw new AppRegistryError(
    "no_port_available",
    `no free port in ${APP_PORT_MIN}-${APP_PORT_MAX}`,
  );
}

// --- persistence ------------------------------------------------------------

type AppHistory = Record<string, { port: number; retiredAt: number }>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Read + parse a state file. A MISSING file is legitimately empty (a fresh
// office); anything present but unparseable is corrupt. An empty or truncated
// file is deliberately NOT special-cased as missing - JSON.parse rejects it and
// that is the correct answer, since a truncated write is exactly the case where
// treating the file as empty would burn a retired name.
// Returns `undefined` for a missing file (never a valid JSON value, so it is an
// unambiguous "absent" signal).
function readStateFile(file: string): unknown {
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    throw corrupt(file, `cannot be read: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw corrupt(file, "not valid JSON");
  }
}

// What actually goes in apps.json. `dataDir` is NOT persisted: it is a pure
// function of the registry directory and the app's (permanent) name, so storing
// it would be denormalization whose only possible contribution is disagreeing
// with the truth. It is derived on load instead, which means a hand-edited
// `"dataDir": "/etc"` cannot exist - there is no such field to edit - and the
// path survives the state root moving (a restore, an ISOMUX_HOME override)
// instead of turning every record into corruption.
type PersistedApp = Omit<AppRecord, "dataDir">;

const isOptionalString = (v: unknown, max: number): boolean =>
  v === undefined || (typeof v === "string" && v.length <= max);
const isNullableString = (v: unknown): boolean =>
  v === null || typeof v === "string";
const isFiniteNumber = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v);

// Full validation of one persisted record. Everything the registry or S2 will
// treat as authoritative is checked; UNKNOWN fields are ignored, so a record
// written by a later version still loads.
//
// The port window is enforced here deliberately, and it has a consequence worth
// stating: moving APP_PORT_MIN/MAX later is a BREAKING change that needs a
// migration, because existing records would fall outside it. That is the right
// trade - the alternative is a hand-edited or damaged record pointing an app at
// port 22, which S2 would faithfully turn into a unit.
function isPersistedApp(value: unknown): value is PersistedApp {
  if (!isPlainObject(value)) return false;
  const {
    name,
    port,
    command,
    cwd,
    description,
    userId,
    username,
    createdBy,
    createdByAgentId,
    createdAt,
  } = value;
  return (
    // The name is the key AND a path component, so it is re-checked against the
    // grammar: a hand-edited `../x` must never reach a path join.
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_APP_NAME_LENGTH &&
    APP_NAME_PATTERN.test(name) &&
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= APP_PORT_MIN &&
    port <= APP_PORT_MAX &&
    typeof command === "string" &&
    command.trim().length > 0 &&
    command.length <= MAX_APP_COMMAND_LENGTH &&
    // Stored resolved at registration; a relative cwd on disk would resolve
    // against whatever directory the server happens to run from.
    typeof cwd === "string" &&
    isAbsolute(cwd) &&
    isOptionalString(description, MAX_APP_DESCRIPTION_LENGTH) &&
    // Ownership and attribution: absent is not the same as null, so these are
    // required keys even when their value is null.
    isNullableString(userId) &&
    isNullableString(username) &&
    typeof createdBy === "string" &&
    isOptionalString(createdByAgentId, 200) &&
    isFiniteNumber(createdAt)
  );
}

function isPersistedTombstone(
  value: unknown,
): value is { port: number; retiredAt: number } {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= APP_PORT_MIN &&
    value.port <= APP_PORT_MAX &&
    isFiniteNumber(value.retiredAt)
  );
}

function loadApps(file: string, dataRoot: string): AppRecord[] {
  const parsed = readStateFile(file);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw corrupt(file, "not a JSON array");
  for (const record of parsed) {
    if (!isPersistedApp(record)) {
      throw corrupt(file, "contains an entry that is not a valid app record");
    }
  }
  // Hydrate the derived path. This is the ONLY place an app's data directory
  // comes from, so it is always the registry's own.
  return (parsed as PersistedApp[]).map((app) => ({
    ...app,
    dataDir: join(dataRoot, app.name),
  }));
}

function loadHistory(file: string): AppHistory {
  const parsed = readStateFile(file);
  if (parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw corrupt(file, "not a JSON object");
  for (const [name, tombstone] of Object.entries(parsed)) {
    if (
      !APP_NAME_PATTERN.test(name) ||
      name.length > MAX_APP_NAME_LENGTH ||
      !isPersistedTombstone(tombstone)
    ) {
      throw corrupt(file, `contains an invalid tombstone for "${name}"`);
    }
  }
  return parsed as AppHistory;
}

// Cross-record invariants, checked over BOTH files together. Each record can be
// individually well-formed while the set of them is impossible, and an
// impossible set is exactly the state in which a name or port gets handed out
// twice.
//
// The one overlap that is NOT corruption: the same name holding the same port
// in both files. That is the deliberate fail-closed outcome of a delete whose
// tombstone landed and whose record removal did not, and it must stay loadable
// so a retried delete can finish the job.
function assertConsistent(
  apps: AppRecord[],
  history: AppHistory,
  where: string,
): void {
  const bad = (why: string) => {
    throw corrupt(where, why);
  };
  const liveNames = new Set<string>();
  const liveByPort = new Map<number, string>();
  for (const app of apps) {
    if (liveNames.has(app.name)) bad(`two live apps named "${app.name}"`);
    liveNames.add(app.name);
    const clash = liveByPort.get(app.port);
    if (clash !== undefined) {
      bad(`"${clash}" and "${app.name}" both claim port ${app.port}`);
    }
    liveByPort.set(app.port, app.name);
  }
  const retiredByPort = new Map<number, string>();
  for (const [name, tombstone] of Object.entries(history)) {
    const clash = retiredByPort.get(tombstone.port);
    if (clash !== undefined) {
      bad(
        `retired names "${clash}" and "${name}" both hold port ${tombstone.port}`,
      );
    }
    retiredByPort.set(tombstone.port, name);
    const live = apps.find((a) => a.name === name);
    if (live && live.port !== tombstone.port) {
      bad(
        `"${name}" is live on port ${live.port} but retired on port ${tombstone.port}`,
      );
    }
  }
  for (const [port, liveName] of liveByPort) {
    const retiredName = retiredByPort.get(port);
    // Same name, same port = the partial-delete state (allowed). Anything else
    // means a live app is sitting on a permanently retired port.
    if (retiredName !== undefined && retiredName !== liveName) {
      bad(
        `live app "${liveName}" holds port ${port}, retired by "${retiredName}"`,
      );
    }
  }
}

// Drop the derived field on the way back to disk, so apps.json never carries a
// dataDir for a later load to have to trust.
function strip(app: AppRecord): PersistedApp {
  const { dataDir: _derived, ...persisted } = app;
  return persisted;
}

function writeStateFile(file: string, value: unknown): void {
  try {
    atomicWriteFileSync(file, JSON.stringify(value, null, 2));
  } catch (err) {
    // Never swallowed: a registration or a tombstone that was not written did
    // not happen, and the caller must hear about it.
    console.error(`[app-registry] failed to write ${file}:`, err);
    // Deliberately does NOT promise that nothing changed: a delete writes the
    // tombstone before it removes the record, so the second write failing means
    // something DID change. The file and the underlying error are in the server
    // log; the caller gets the honest version.
    throw new AppRegistryError(
      "persist_failed",
      "the app registry could not complete the write; inspect server logs and retry",
    );
  }
}

// --- the registry -----------------------------------------------------------

export interface RegisterAppInput {
  name: string;
  command: string;
  // Absolute and already verified to exist by the caller (the route handler
  // runs the same validateCwd the spawn path uses). Re-asserted here so a
  // future caller cannot skip it.
  cwd: string;
  description?: string;
  userId: string | null;
  username: string | null;
  createdBy: string;
  createdByAgentId?: string;
}

// A patch over the three fields an app may change. An absent key leaves the
// field alone; `description: null` removes it (see AppUpdateReq for why absence
// and the empty string are different answers).
export interface UpdateAppInput {
  command?: string;
  cwd?: string;
  description?: string | null;
}

export interface AppRegistry {
  // Every live app, registration order.
  list(): AppRecord[];
  get(name: string): AppRecord | null;
  // Reserve a name + port, create the data dir, persist the record. Throws
  // AppRegistryError on any refusal or failure.
  register(input: RegisterAppInput): AppRecord;
  // Change command, cwd and/or description on a registered app. Returns the
  // updated record, or null when no live app has that name. Throws
  // AppRegistryError on any refusal or failure.
  update(name: string, patch: UpdateAppInput): AppRecord | null;
  // Retire an app: tombstone its name and port, then drop the record. Returns
  // the removed record, or null when no app has that name.
  remove(name: string): AppRecord | null;
  // The tombstones, for tests and (later) the Apps tab.
  retired(): RetiredApp[];
}

export interface AppRegistryOptions {
  // Registry root; defaults to STATE_ROOT/apps. Resolved to an absolute path so
  // the dataDir handed to an app is absolute no matter how this was passed.
  dir?: string;
  now?: () => number;
  probePort?: (port: number) => boolean;
}

export function createAppRegistry(
  options: AppRegistryOptions = {},
): AppRegistry {
  const dir = resolve(options.dir ?? join(STATE_ROOT, "apps"));
  const appsFile = join(dir, "apps.json");
  const historyFile = join(dir, "app-history.json");
  const dataRoot = join(dir, "data");
  const now = options.now ?? (() => Date.now());
  const probePort = options.probePort ?? bindProbe;

  // The ONE way any operation reads state: both files, each validated, then
  // checked against each other. Every public method starts here - including the
  // reads. A list() that answered from a valid apps.json while app-history.json
  // was unreadable would be reporting a worldview it cannot vouch for, and the
  // module's whole claim is that it never does that.
  const snapshot = (): { apps: AppRecord[]; history: AppHistory } => {
    const apps = loadApps(appsFile, dataRoot);
    const history = loadHistory(historyFile);
    assertConsistent(apps, history, `${appsFile} + ${historyFile}`);
    return { apps, history };
  };

  return {
    list: () => snapshot().apps,

    get(name) {
      return snapshot().apps.find((a) => a.name === name) ?? null;
    },

    register(input) {
      const nameError = checkAppName(input.name);
      if (nameError) throw nameError;

      assertCommand(input.command);
      assertCwd(input.cwd);
      if (input.description !== undefined) assertDescription(input.description);

      // The whole registry is read and validated BEFORE anything is written, so
      // a corrupt registry refuses the registration instead of half-applying it.
      const { apps, history } = snapshot();

      if (apps.length >= MAX_REGISTERED_APPS) {
        throw new AppRegistryError(
          "app_limit_reached",
          `this office already has ${MAX_REGISTERED_APPS} registered apps; delete one to register another`,
        );
      }
      if (apps.some((a) => a.name === input.name)) {
        throw new AppRegistryError(
          "name_taken",
          `an app named "${input.name}" is already registered`,
        );
      }
      if (history[input.name]) {
        throw new AppRegistryError(
          "name_retired",
          `the name "${input.name}" belonged to a deleted app and cannot be reused; pick another`,
        );
      }

      // Live ports AND retired ports are both off limits.
      const used = new Set<number>([
        ...apps.map((a) => a.port),
        ...Object.values(history).map((h) => h.port),
      ]);
      const port = allocatePort(used, probePort);

      // Data dir first, record second: an orphan directory after a failed
      // record write is recoverable, a record pointing at a directory that was
      // never created is not.
      const dataDir = join(dataRoot, input.name);
      try {
        mkdirSync(dataDir, { recursive: true });
      } catch (err) {
        console.error(`[app-registry] failed to create ${dataDir}:`, err);
        throw new AppRegistryError(
          "persist_failed",
          "the app's data directory could not be created; nothing was registered",
        );
      }

      const persisted: PersistedApp = {
        name: input.name,
        port,
        command: input.command,
        cwd: input.cwd,
        // `!== undefined`, not truthiness: an empty description is a value the
        // caller sent, and normalizing it away would make the response disagree
        // with the request.
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        userId: input.userId,
        username: input.username,
        createdBy: input.createdBy,
        ...(input.createdByAgentId
          ? { createdByAgentId: input.createdByAgentId }
          : {}),
        createdAt: now(),
      };
      writeStateFile(appsFile, [...apps.map(strip), persisted]);
      return { ...persisted, dataDir };
    },

    // The cure for a typo that would otherwise cost a name. Everything that
    // makes the app THE app - name, port, data directory, ownership, creation
    // attribution - is untouched by construction: only the three patchable
    // fields are ever copied over, and the record keeps its position in the
    // file so registration order still reads as registration order.
    update(name, patch) {
      // Validated BEFORE the snapshot, exactly as register does: a bad patch
      // must be refused the same way whether or not the registry is readable,
      // and a rejected patch must not have read anything to reject.
      if (patch.command !== undefined) assertCommand(patch.command);
      if (patch.cwd !== undefined) assertCwd(patch.cwd);
      if (patch.description !== undefined && patch.description !== null) {
        assertDescription(patch.description);
      }

      const { apps } = snapshot();
      const index = apps.findIndex((a) => a.name === name);
      if (index < 0) return null;

      const updated: AppRecord = {
        ...apps[index],
        ...(patch.command !== undefined ? { command: patch.command } : {}),
        ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      };
      // Three-way: absent leaves it, a string sets it, null removes the key
      // entirely. `delete` rather than assigning undefined, so what is written
      // is a record with no description at all rather than one carrying an
      // explicit `"description": undefined` that JSON.stringify would drop but
      // every intermediate comparison would see.
      if (patch.description === null) delete updated.description;
      else if (patch.description !== undefined) {
        updated.description = patch.description;
      }

      writeStateFile(
        appsFile,
        apps.map((a, i) => strip(i === index ? updated : a)),
      );
      return updated;
    },

    remove(name) {
      const { apps, history } = snapshot();
      const record = apps.find((a) => a.name === name);
      if (!record) return null;

      // Tombstone FIRST, from the STORED record's own name and port - never
      // from the caller's string. The worst outcome of a failure between these
      // two writes is an app that is both live and tombstoned, which is
      // visible and fixable; the reverse order can free a name and port
      // forever, which is not.
      writeStateFile(historyFile, {
        ...history,
        [record.name]: { port: record.port, retiredAt: now() },
      });
      writeStateFile(
        appsFile,
        apps.filter((a) => a.name !== record.name).map(strip),
      );
      // The data directory is deliberately left on disk. A delete that silently
      // destroys whatever the app wrote is unrecoverable, and since the name is
      // never reused nothing can ever land on top of it.
      return record;
    },

    retired() {
      return Object.entries(snapshot().history).map(([name, t]) => ({
        name,
        port: t.port,
        retiredAt: t.retiredAt,
      }));
    },
  };
}

// Production singleton over STATE_ROOT/apps. Constructing it touches no disk;
// the directory is created on the first write.
export const appRegistry: AppRegistry = createAppRegistry();
