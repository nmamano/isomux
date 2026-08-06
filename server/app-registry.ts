// The app registry - the leaf module behind /api/apps. Names, ports, per-app
// data directories, and the JSON file that holds them. See
// internal-docs/agent-apps-design.md.
//
// Nothing here starts a process. Registration allocates a port and reserves a
// name; running the app is the supervisor's job, and the registry deliberately
// persists no runtime state (see AppState in shared/contract-shapes.ts).
//
// THE INVARIANT IS WHOLE-LIFE, NOT FOREVER. A name and a port are bound to one
// app for as long as that app exists, and there is no verb that rewrites either
// - both outlive isomux's reach the moment somebody bookmarks the address, so
// moving a live app's address is the failure this registry exists to prevent.
// Deleting an app frees both for reuse (Nil's ruling, 2026-08-06); safe reuse of
// an ORIGIN is the transport's problem, and the hostname carries a generation
// label so a reused name never lands on the previous app's storage (design doc
// section 4). Two consequences that read as over-caution until you connect them
// to the invariant:
//
//   1. CORRUPTION FAILS LOUD, NEVER EMPTY. Every public operation - reads
//      included - starts from a validated snapshot, so a malformed apps.json
//      raises `registry_corrupt` and nothing proceeds. The tempting
//      alternative - the load-time catch-and-return-[] used for cronjobs and
//      tasks - is actively unsafe here: an empty worldview would duplicate a
//      live registration, hand a second app a port that is already serving, and
//      then persist the truncated view over the file that still held the truth.
//      Cronjobs can afford it (a lost row is a job that stops firing); this
//      cannot. Validation is per-record AND cross-record (unique names, unique
//      ports), because a set of individually well-formed records can still be
//      an impossible one.
//   2. PERSISTENCE FAILURES PROPAGATE. saveCronjobs-style catch-and-log would
//      report a registration that was never written, or a delete that did not
//      happen. Every write here throws `persist_failed` and the caller answers
//      500 rather than pretending.
//
// Write ORDER carries the same reasoning. Registration creates the data
// directory and then writes the record: a crash between them leaves an orphan
// directory, which is recoverable. Deletion is one write, and the caller
// sequences the rest: the route tears the unit down and revokes the token
// BEFORE calling remove(), so a name is only freed once the app is provably
// down (see routes/handlers/apps.ts).
//
// A NOTE FOR OLD OFFICES: deletes used to write tombstones to app-history.json,
// which no longer exists as a concept. A leftover file is IGNORED - never read,
// never written, never deleted. Reading it would resurrect the retirement it
// records; deleting it would put a write on a read path (and fail on a
// read-only state dir) to clean up a file that costs nothing.
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

import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import type { AppRecord } from "../shared/types.ts";
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
// reads as a fresh registry, so moving apps.json aside would hand out names and
// ports that live apps are still serving on. The error must not recommend the
// one action that destroys the invariant it is explaining.
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

// Lowest free port in the window: not held by a live app, and actually
// bindable. A deleted app's port goes straight back in the pool, so the gap it
// left is the next one handed out.
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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Read + parse a state file. A MISSING file is legitimately empty (a fresh
// office); anything present but unparseable is corrupt. An empty or truncated
// file is deliberately NOT special-cased as missing - JSON.parse rejects it and
// that is the correct answer, since a truncated write is exactly the case where
// treating the file as empty would hand a live app's name and port to a second
// one.
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
// function of the registry directory and the app's name, which never changes
// while the app exists, so storing it would be denormalization whose only
// possible contribution is disagreeing with the truth. It is derived on load instead, which means a hand-edited
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

// Cross-record invariants. Each record can be individually well-formed while
// the set of them is impossible, and an impossible set is exactly the state in
// which two LIVE apps end up sharing a name or a port.
function assertConsistent(apps: AppRecord[], where: string): void {
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
    // Never swallowed: a registration or a removal that was not written did not
    // happen, and the caller must hear about it.
    console.error(`[app-registry] failed to write ${file}:`, err);
    // Deliberately does NOT promise that nothing changed: a delete sets the
    // data directory aside before it removes the record, so this failing means
    // something DID change. The file and the underlying error are in the server
    // log; the caller gets the honest version.
    throw new AppRegistryError(
      "persist_failed",
      "the app registry could not complete the write; inspect server logs and retry",
    );
  }
}

// Set a deleted app's data directory aside, so the next app to take the name
// starts with an empty one.
//
// The data is KEPT, not destroyed: a delete that silently burns whatever the
// app wrote is unrecoverable. But `dataDir` is derived from the name, so
// leaving it in place would hand the previous app's files to the next
// registration - and since names are claimable by anyone, that next
// registration can belong to a different user. Moving it is what keeps "the
// data survives" and "the next app starts clean" from being in tension.
//
// `.retired` cannot collide with an app's own directory: a name must start with
// a letter or digit, so no app is ever called `.retired`.
function archiveDataDir(dataRoot: string, name: string, at: number): void {
  const from = join(dataRoot, name);
  // Never created, or already moved by a delete that got this far and then
  // failed on the record write. Both mean there is nothing to set aside, and a
  // retried delete has to be able to get past this line.
  if (!existsSync(from)) return;
  const retiredRoot = join(dataRoot, ".retired");
  mkdirSync(retiredRoot, { recursive: true });
  // The timestamp alone is not unique: register/delete twice inside one
  // millisecond - or under an injected clock that does not move - and the
  // second rename would land on the first archive. Renaming a directory onto an
  // existing one either throws (non-empty) or silently replaces it (empty), and
  // silently replacing kept data is the worse of the two, so the suffix walks
  // until the path is free.
  let to = join(retiredRoot, `${name}-${at}`);
  for (let n = 2; existsSync(to); n++) {
    to = join(retiredRoot, `${name}-${at}-${n}`);
  }
  renameSync(from, to);
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
  // Delete an app: set its data directory aside, then drop the record, freeing
  // its name and port for reuse. Returns the removed record, or null when no
  // app has that name.
  remove(name: string): AppRecord | null;
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
  const dataRoot = join(dir, "data");
  const now = options.now ?? (() => Date.now());
  const probePort = options.probePort ?? bindProbe;

  // The ONE way any operation reads state: the file, validated per-record and
  // then as a set. Every public method starts here - including the reads,
  // because a read answered off a file the registry cannot vouch for is the
  // most convincing wrong answer it can give.
  const snapshot = (): AppRecord[] => {
    const apps = loadApps(appsFile, dataRoot);
    assertConsistent(apps, appsFile);
    return apps;
  };

  return {
    list: () => snapshot(),

    get(name) {
      return snapshot().find((a) => a.name === name) ?? null;
    },

    register(input) {
      const nameError = checkAppName(input.name);
      if (nameError) throw nameError;

      assertCommand(input.command);
      assertCwd(input.cwd);
      if (input.description !== undefined) assertDescription(input.description);

      // The whole registry is read and validated BEFORE anything is written, so
      // a corrupt registry refuses the registration instead of half-applying it.
      const apps = snapshot();

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
      // Only LIVE ports are off limits. A deleted app's port is free the moment
      // its record goes, so the lowest gap is the next port handed out.
      const port = allocatePort(new Set(apps.map((a) => a.port)), probePort);

      // Data dir first, record second: an orphan directory after a failed
      // record write is recoverable, a record pointing at a directory that was
      // never created is not. It is empty even when the name has been used
      // before, because delete sets the old one aside (see archiveDataDir).
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

    // The cure for a typo that would otherwise cost the app its address.
    // Everything that makes the app THE app - name, port, data directory,
    // ownership, creation attribution - is untouched by construction: only the
    // three patchable fields are ever copied over, and the record keeps its
    // position in the file so registration order still reads as registration
    // order.
    update(name, patch) {
      // Validated BEFORE the snapshot, exactly as register does: a bad patch
      // must be refused the same way whether or not the registry is readable,
      // and a rejected patch must not have read anything to reject.
      if (patch.command !== undefined) assertCommand(patch.command);
      if (patch.cwd !== undefined) assertCwd(patch.cwd);
      if (patch.description !== undefined && patch.description !== null) {
        assertDescription(patch.description);
      }

      const apps = snapshot();
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
      const apps = snapshot();
      const record = apps.find((a) => a.name === name);
      if (!record) return null;

      // The data directory is set aside BEFORE the record goes, and always from
      // the STORED record's own name - never from the caller's string. Order
      // matters the same way it did when this wrote a tombstone: everything
      // that can fail happens while the app is still registered, so any failure
      // leaves a delete that is incomplete and RETRYABLE rather than one that
      // committed and lost track of the data it was supposed to keep. (By this
      // point the route has already torn the unit down, so the app in that
      // window is stopped and unstartable - the retry is the only path out of
      // it, and it converges: the archive step is a no-op once the directory
      // has moved.)
      try {
        archiveDataDir(dataRoot, record.name, now());
      } catch (err) {
        console.error(
          `[app-registry] failed to set aside the data directory for "${record.name}":`,
          err,
        );
        throw new AppRegistryError(
          "persist_failed",
          `the app's data directory could not be set aside, so "${record.name}" was not deleted; inspect server logs and retry`,
        );
      }
      writeStateFile(
        appsFile,
        apps.filter((a) => a.name !== record.name).map(strip),
      );
      return record;
    },
  };
}

// Production singleton over STATE_ROOT/apps. Constructing it touches no disk;
// the directory is created on the first write.
export const appRegistry: AppRegistry = createAppRegistry();
