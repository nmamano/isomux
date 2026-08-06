// Apps resource handlers - the agent-facing app registry (opIds
// apps.{list,get,register,update,delete,logs,start,stop,restart}). See
// internal-docs/agent-apps-design.md.
//
// The verb is REGISTER, not create: the agent already built the app: isomux is
// being handed something that exists, and answers with the port it allocated
// and the data directory it created.
//
// TWO COLLABORATORS, AND THE ORDER BETWEEN THEM IS THE INTERESTING PART. The
// registry owns the name, the port and the record; the supervisor owns the unit
// that runs it. Registration goes registry-then-supervisor and deletion goes
// supervisor-then-registry, and neither order is arbitrary:
//
//   - REGISTER commits to the registry FIRST because a registration cannot be
//     rolled back. Undoing one means calling remove(), which TOMBSTONES the
//     name permanently - so "install failed, let me undo the record" would burn
//     the agent's chosen name over a transient systemd error. The record is the
//     commit point; if the unit does not install, the app exists and reads as
//     not running, which is recoverable.
//   - DELETE tears the unit down FIRST because the tombstone is the point of no
//     return in the other direction. Tombstoning and then failing to stop the
//     app leaves a live process holding a port under a name the registry has
//     forgotten, which nothing in isomux can clean up afterwards.
//
// [ownership] userId/username/createdBy come from the TOKEN identity, never the
// body - the app belongs to the registering agent's MANAGER, so that it
// survives the agent (design doc section 3). A body-supplied owner would let
// any caller register an app onto someone else.
//
// [addressing] The path parameter is a NAME, not an id. Names are unique across
// live and retired apps forever, so they are already a permanent key. The name
// reaches the filesystem (the data directory now, a unit name later), so it is
// validated at registration and a lookup is an exact match against the
// registry: an unregistered `../x` matches nothing and 404s like any other
// unknown name.
//
// LEAF over the executor + shared types + the registry's error type. No
// manager/auth imports - only the injected AppsDeps surface.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import { AppRegistryError } from "../../app-registry.ts";
import {
  APP_LOG_LINES_DEFAULT,
  AppSupervisorError,
  UNKNOWN_RUNTIME,
  type AppRuntime,
} from "../../app-supervisor.ts";
import type { Identity } from "../../identity/index.ts";
import type { AppRecord } from "../../../shared/types.ts";
import type {
  AppErrorCode,
  AppLogsRes,
  AppRegisterReq,
  AppWire,
} from "../../../shared/contract-shapes.ts";

export interface AppsDeps {
  list(): AppRecord[];
  get(name: string): AppRecord | null;
  register(input: {
    name: string;
    command: string;
    cwd: string;
    description?: string;
    userId: string | null;
    username: string | null;
    createdBy: string;
    createdByAgentId?: string;
  }): AppRecord;
  remove(name: string): AppRecord | null;
  // Apply a patch to a registered app. Returns the updated record, or null when
  // the app is gone.
  update(
    name: string,
    patch: { command?: string; cwd?: string; description?: string | null },
  ): AppRecord | null;
  // Token-derived attribution, shared with the task board: createdBy is the
  // caller's display identity (agent name, or the human's name), username the
  // token's owning user.
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  // Resolve + verify a working directory (the same check the spawn path runs).
  // Returns the resolved absolute path, or an error string.
  validateCwd(
    cwd: string,
  ): { ok: true; resolved: string } | { ok: false; error: string };
  // Is this caller an office owner? Owners see every app; everyone else sees
  // the apps their user owns. Mirrors the cronjob rule.
  isOfficeOwner(identity: Identity): boolean;

  // --- the supervisor seam (server/app-supervisor.ts) ---
  // Write the unit and start the app. Throws only when the unit could not be
  // INSTALLED; an app that installs and then fails to run is a state, not an
  // error (see the register handler).
  install(record: AppRecord): void;
  // Regenerate the app's unit from a changed record, preserving whether it was
  // running. Throws when the machine could not be brought in line.
  reinstall(record: AppRecord): void;
  // Stop the app and remove everything isomux generated for it. Throws if the
  // app survived, which is what keeps a failed teardown from tombstoning.
  teardown(name: string): void;
  start(name: string): void;
  stop(name: string): void;
  restart(name: string): void;
  // Runtime state for a SET of apps: one lookup for a whole list, never one per
  // app. A name the supervisor cannot speak for is simply absent.
  states(names: readonly string[]): Map<string, AppRuntime>;
  logs(name: string, lines: number): string[];
}

// The ONE place a record becomes wire. `state` and `restartCount` are derived
// from the supervisor at read time and never stored - a persisted "running"
// would be a lie the moment the box reboots.
function toWire(record: AppRecord, runtime: AppRuntime | undefined): AppWire {
  const { state, restartCount, startError } = runtime ?? UNKNOWN_RUNTIME;
  return {
    ...record,
    state,
    restartCount,
    ...(startError ? { startError } : {}),
  };
}

// Registry refusals -> HTTP. A 400 is "your request is wrong", a 409 is "the
// world says no", a 500 is "we failed". Kept as one exhaustive table so a new
// code cannot quietly default to 500.
const STATUS_BY_CODE: Record<AppErrorCode, HandlerErrorStatus> = {
  invalid_name: 400,
  reserved_name: 400,
  invalid_command: 400,
  invalid_cwd: 400,
  invalid_description: 400,
  name_taken: 409,
  name_retired: 409,
  app_limit_reached: 409,
  no_port_available: 409,
  registry_corrupt: 500,
  persist_failed: 500,
  supervisor_failed: 500,
};

export function appsHandlers(deps: AppsDeps): Record<string, RouteHandler> {
  // Every handler wraps its registry access, so a corrupt registry answers with
  // its own code on a READ as well as a write - a list that silently returned
  // [] would read as "you have no apps".
  return {
    "apps.list": (ctx) => {
      try {
        const all = deps.list();
        const visible = deps.isOfficeOwner(ctx.identity)
          ? all
          : all.filter((a) => a.userId && a.userId === ctx.identity.userId);
        // ONE state lookup for the whole list. A per-app lookup would be a
        // subprocess per app per render, and the Apps tab polls.
        const runtimes = deps.states(visible.map((a) => a.name));
        return ok(visible.map((a) => toWire(a, runtimes.get(a.name))));
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    // The owner-or-office-owner guard has already run on :name, so reaching
    // here means the caller may see this app - a miss is a genuine unknown.
    "apps.get": (ctx) => {
      try {
        const record = deps.get(ctx.params.name);
        if (!record) return fail(404, "not_found");
        return ok(toWire(record, deps.states([record.name]).get(record.name)));
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    "apps.register": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<AppRegisterReq>;
      if (typeof body.name !== "string") {
        return fail(400, "invalid_name", "name is required");
      }
      if (typeof body.command !== "string") {
        return fail(400, "invalid_command", "command is required");
      }
      if (typeof body.cwd !== "string" || body.cwd.trim() === "") {
        return fail(400, "invalid_cwd", "cwd is required");
      }
      if (
        body.description !== undefined &&
        typeof body.description !== "string"
      ) {
        return fail(400, "invalid_description", "description must be a string");
      }
      // Resolved here rather than in the registry so `~/` expands the same way
      // it does for an agent's own cwd, and so the stored path is absolute.
      const cwd = deps.validateCwd(body.cwd);
      if (!cwd.ok) return fail(400, "invalid_cwd", cwd.error);

      const { createdBy, username } = deps.attributionFor(ctx.identity);
      try {
        const record = deps.register({
          name: body.name,
          command: body.command,
          cwd: cwd.resolved,
          description: body.description,
          userId: ctx.identity.userId,
          username: username ?? null,
          createdBy,
          ...(ctx.identity.scope === "agent" && ctx.identity.agentId
            ? { createdByAgentId: ctx.identity.agentId }
            : {}),
        });
        // THE RECORD IS COMMITTED, SO THE ANSWER IS 201 - whatever the
        // supervisor then does. A 500 here would describe a resource that
        // really was created, and the natural response to a 500 is a retry,
        // which can only ever be told the name is taken. So a failure to
        // install or start is reported through `state` and `startError`, not
        // through the status code.
        try {
          deps.install(record);
        } catch (err) {
          // EVERY error, not just AppSupervisorError. The supervisor converts
          // its own failures, but making the 201 depend on that conversion
          // would mean one unconverted throw - a raw fs error, a bug - turns a
          // committed registration back into a 500. Past this line the app
          // exists, so nothing that happens can make the answer a failure.
          // Logged as well: the wire field is in-memory, the log is durable.
          console.error(
            `[apps] "${record.name}" registered but not running:`,
            err,
          );
        }
        return created(
          toWire(record, deps.states([record.name]).get(record.name)),
        );
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    // The verb that stops a mistyped command from burning a name forever.
    // Everything about it is shaped by one fact: the registry write is the
    // commit point, and past it the update HAS happened.
    "apps.update": (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      // Inside the try from the first registry touch onward, like every other
      // handler here: a corrupt registry must answer `registry_corrupt`, not an
      // unmapped 500.
      try {
        const before = deps.get(ctx.params.name);
        if (!before) return fail(404, "not_found");

        // The immutable fields. PRESENCE is what triggers the check, not type:
        // testing `typeof body.name === "string"` first would let `{name: 7}`
        // and `{name: null}` slip past as "not a rename" and be silently
        // ignored, which is the same lie as accepting one.
        //
        // Present is then tolerated in exactly one case: the right type AND the
        // value the app already has. Reading an app and PATCHing the object
        // back with one field edited is the obvious way to use this route, and
        // that body carries the app's own name and port; rejecting it would
        // punish the natural pattern for asking for nothing. Anything else is
        // asking for something this route will never do, and answering 200
        // would leave the caller believing its app had been renamed.
        if (Object.hasOwn(body, "name") && body.name !== before.name) {
          return fail(
            400,
            "invalid_request",
            "an app's name cannot be changed: it is the address people " +
              "bookmark, and it is retired forever when the app is deleted",
          );
        }
        if (Object.hasOwn(body, "port") && body.port !== before.port) {
          return fail(
            400,
            "invalid_request",
            "an app's port cannot be changed: isomux allocates it at " +
              "registration and never reissues it",
          );
        }

        if (body.command !== undefined && typeof body.command !== "string") {
          return fail(400, "invalid_command", "command must be a string");
        }
        if (
          body.cwd !== undefined &&
          (typeof body.cwd !== "string" || body.cwd.trim() === "")
        ) {
          return fail(400, "invalid_cwd", "cwd must be a non-empty string");
        }
        if (
          body.description !== undefined &&
          body.description !== null &&
          typeof body.description !== "string"
        ) {
          return fail(
            400,
            "invalid_description",
            "description must be a string, or null to remove it",
          );
        }
        // An empty patch is a caller mistake, not a no-op: answering 200 to a
        // request that asked for nothing hides whatever built it.
        if (
          body.command === undefined &&
          body.cwd === undefined &&
          body.description === undefined
        ) {
          return fail(
            400,
            "invalid_request",
            "nothing to update: send at least one of command, cwd, description",
          );
        }

        let cwd: string | undefined;
        if (body.cwd !== undefined) {
          // Same resolution as register, so `~/` means the same thing on both
          // routes and what is stored is absolute.
          const resolved = deps.validateCwd(body.cwd);
          if (!resolved.ok) return fail(400, "invalid_cwd", resolved.error);
          cwd = resolved.resolved;
        }

        const after = deps.update(before.name, {
          ...(body.command !== undefined ? { command: body.command } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
        });
        // Deleted between the read and the write. Nothing was updated, so this
        // is the same answer an unknown name gets.
        if (!after) return fail(404, "not_found");

        // The machine only hears about changes it can act on. A description
        // edit - or a patch that sets a field to what it already held - leaves
        // systemd alone entirely, so editing an app's blurb never bounces a
        // running process.
        if (after.command !== before.command || after.cwd !== before.cwd) {
          try {
            deps.reinstall(after);
          } catch (err) {
            // 200 EVEN SO, and for the same reason register answers 201 when
            // the supervisor fails: the record has already changed, and a
            // status that says otherwise would describe a resource that really
            // was updated. The failure rides back on the body instead, as the
            // app's truthful state plus `startError`. Every error, not just
            // AppSupervisorError, so one unconverted throw cannot turn a
            // committed update into a 500.
            console.error(
              `[apps] "${after.name}" updated but its unit was not brought in line:`,
              err,
            );
          }
        }
        return ok(toWire(after, deps.states([after.name]).get(after.name)));
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    "apps.delete": (ctx) => {
      try {
        // Existence is checked before anything is torn down, so an unknown name
        // is a plain 404 rather than a systemd error about a unit that was
        // never there.
        const record = deps.get(ctx.params.name);
        if (!record) return fail(404, "not_found");
        // Throws if the app survived; the tombstone below is then never
        // written, and a retried DELETE can finish the job.
        deps.teardown(record.name);
        return deps.remove(record.name) ? noContent() : fail(404, "not_found");
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    // The recovery verbs. Without them the only cure for an app that has come
    // to rest in `failed` is DELETE, which burns its name forever - a steep
    // price for a crash loop or a source file that has since been fixed.
    // (A mistyped start COMMAND is cured by apps.update instead, which
    // rewrites the unit and restarts what was running.)
    "apps.start": actionHandler(deps, (name) => deps.start(name)),
    "apps.stop": actionHandler(deps, (name) => deps.stop(name)),
    "apps.restart": actionHandler(deps, (name) => deps.restart(name)),

    "apps.logs": (ctx) => {
      try {
        const record = deps.get(ctx.params.name);
        if (!record) return fail(404, "not_found");
        // Validated here rather than clamped silently: `lines=banana` and
        // `lines=-5` are caller mistakes, and quietly answering with the
        // default hides the bug in whatever built the URL. A number that is
        // merely too big IS clamped - asking for more than we cap at is a
        // reasonable thing to want, unlike asking for nonsense.
        const raw = ctx.query.get("lines");
        let lines = APP_LOG_LINES_DEFAULT;
        if (raw !== null) {
          // isSafeInteger as well as the digit grammar: a long enough digit
          // string passes the regex and converts to something that is not a
          // usable integer at all. Better to refuse it here than to let the
          // clamp downstream turn nonsense into a plausible answer.
          if (
            !/^\d+$/.test(raw) ||
            !Number.isSafeInteger(Number(raw)) ||
            Number(raw) < 1
          ) {
            return fail(
              400,
              "invalid_request",
              "lines must be a positive whole number",
            );
          }
          lines = Number(raw);
        }
        const body: AppLogsRes = {
          name: record.name,
          // Clamped inside the supervisor, which is also where the ceiling is
          // defined - so a caller cannot ask journald for a million lines.
          lines: deps.logs(record.name, lines),
        };
        return ok(body);
      } catch (err) {
        return renderRegistryError(err);
      }
    },
  };
}

// start / stop / restart differ only in the verb. Each answers with the app's
// FRESH state rather than 204, so the caller learns whether the thing it asked
// for actually happened without a second round trip.
function actionHandler(
  deps: AppsDeps,
  act: (name: string) => void,
): RouteHandler {
  return (ctx) => {
    try {
      const record = deps.get(ctx.params.name);
      if (!record) return fail(404, "not_found");
      act(record.name);
      return ok(toWire(record, deps.states([record.name]).get(record.name)));
    } catch (err) {
      return renderRegistryError(err);
    }
  };
}

// A registry or supervisor error carries the wire code; anything else is a
// genuine surprise and is re-thrown for the executor to log and answer 500.
function renderRegistryError(err: unknown) {
  if (err instanceof AppRegistryError || err instanceof AppSupervisorError) {
    return fail(STATUS_BY_CODE[err.code], err.code, err.message);
  }
  throw err;
}
