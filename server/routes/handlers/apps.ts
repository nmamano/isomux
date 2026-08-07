// Apps resource handlers - the agent-facing app registry (opIds
// apps.{list,get,register,update,delete,logs,start,stop,restart}) plus the one
// route the APP itself calls (apps.sendMessage). See
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
//   - REGISTER commits to the registry FIRST, and a failed install does NOT
//     undo it. An app whose unit did not install is a registered app that
//     start/ update can still fix, while undoing the record would also throw
//     away its data directory and its token - so 201 plus `startError` is the
//     truthful answer, and a 500 would invite a retry of something that already
//     happened.
//   - DELETE tears the unit down FIRST because removing the record is the point
//     of no return in the other direction: it frees the name and the port, and
//     doing that while the process is still alive leaves it holding a port
//     under a name the registry has forgotten - which nothing in isomux can
//     clean up afterwards, and which the next registration could be handed.
//
// [ownership] userId/username/createdBy come from the TOKEN identity, never the
// body - the app belongs to the registering agent's MANAGER, so that it
// survives the agent (design doc section 3). A body-supplied owner would let
// any caller register an app onto someone else.
//
// [addressing] The path parameter is a NAME, not an id. A name is unique across
// LIVE apps and never changes while one exists, so it is already the key. The
// name reaches the filesystem (the data directory now, a unit name later), so
// it is validated at registration and a lookup is an exact match against the
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
import {
  APP_MESSAGE_MAX_CHARS,
  type AppMessageLimiter,
} from "../../app-message-limits.ts";
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
  // The app's public address, or null when this office has no app hostnames.
  // Derived on every read from the boot-frozen domain and the app's label -
  // the same value its unit injects as ISOMUX_APP_URL.
  publicUrl(app: AppRecord): string | null;

  // --- the wire seam -------------------------------------------------------
  // Tell every socket that may see this app about it. Called with the SAME wire
  // object the response carries, so what the caller is told and what the office
  // is told cannot drift. Only ever called for an outcome that COMMITTED: a
  // validation refusal, a 404, or a verb that threw announces nothing, because
  // nothing changed. A register or update whose supervisor step failed DOES
  // announce - the record really did change, and the fresh runtime in the wire
  // is the truthful result of it.
  //
  // Never called anywhere its throw could change the response: see announced().
  announce(wire: AppWire): void;
  // Tell the same audience the app is gone. Takes the owner id because the
  // record is already removed by the time this runs and visibility cannot be
  // decided without it.
  announceRemoved(app: { name: string; userId: string | null }): void;

  // --- the token seam (server/app-tokens.ts + the supervisor) --------------
  // Provision the app's token: mint it, persist its hash, and write the
  // plaintext into the environment file its unit reads. Returns whether the app
  // ended up with one. NEVER throws - an app that could not be given a token is
  // an app that runs without one, not a failed registration.
  //
  // The two halves are a PAIR: the hash is worthless without the plaintext (an
  // app that can never authenticate and cannot be repaired), so a failure to
  // write the file revokes the hash again rather than leaving one behind.
  provisionToken(app: AppRecord): boolean;
  // Drop an app's token when the app is deleted. Throws if the hash could not
  // be removed, which fails the delete before the name is freed - a credential
  // outliving the thing it names is worth a retry.
  revokeToken(name: string): void;

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

  // --- the messaging seam (apps.sendMessage) --------------------------------
  // Deliver a message from `appName` to `targetAgentId`. The SENDER is built
  // server-side by the wiring, from the app name the token resolved to - so
  // nothing a caller writes can appear as the sender, and no app can speak as
  // another app, an agent, or a boss. Never steers: an app must not be able to
  // interrupt a turn in progress.
  sendAsApp(
    appName: string,
    targetAgentId: string,
    text: string,
  ): // messageId is optional for the same reason it is on the inter-agent send:
    // the manager's dedupe branch acks an EARLIER send whose id this call never
    // learned. Unreachable here (no clientMessageId is ever passed), but the
    // shape follows the manager rather than the current call site.
    | { ok: true; messageId?: string; queued?: boolean }
    | {
        ok: false;
        status: HandlerErrorStatus;
        code: string;
        message: string;
      };
  // Rate limits (server/app-message-limits.ts). Two calls rather than one
  // because the two limits are spent at different moments - see the module
  // header and the handler.
  limiter: AppMessageLimiter;
}

// The ONE place a record becomes wire. `state` and `restartCount` are derived
// from the supervisor at read time and never stored - a persisted "running"
// would be a lie the moment the box reboots. `url` is derived too, from the
// office's origin and the app's label.
function toWire(
  record: AppRecord,
  runtime: AppRuntime | undefined,
  url: string | null,
): AppWire {
  const { state, restartCount, startError } = runtime ?? UNKNOWN_RUNTIME;
  return {
    ...record,
    state,
    restartCount,
    ...(startError ? { startError } : {}),
    // `!== null`, not truthiness: the rule is present-iff-there-is-a-URL, and
    // an empty string would be a URL-shaped answer meaning "none".
    ...(url !== null ? { url } : {}),
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
  origin_retired: 409,
  no_label_available: 409,
  app_limit_reached: 409,
  no_port_available: 409,
  registry_corrupt: 500,
  persist_failed: 500,
  supervisor_failed: 500,
};

export function appsHandlers(deps: AppsDeps): Record<string, RouteHandler> {
  // toWire with this office's address rule applied, so no call site can build
  // a wire object for one app carrying another's URL - or forget the field.
  const wireOf = (
    record: AppRecord,
    runtime: AppRuntime | undefined,
  ): AppWire => toWire(record, runtime, deps.publicUrl(record));

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
        return ok(visible.map((a) => wireOf(a, runtimes.get(a.name))));
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
        return ok(wireOf(record, deps.states([record.name]).get(record.name)));
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
        // The token BEFORE the install, so the unit's first start already has
        // it: a process's environment is fixed at exec, so an app started
        // before its token file exists would run tokenless until something
        // restarted it. Never throws (see AppsDeps.provisionToken) - an app
        // without a token is a working app with one capability missing, and
        // failing the registration over it would be the wrong trade.
        deps.provisionToken(record);
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
        // ONE wire object: announced and returned, so the office and the caller
        // are told the same thing by construction. Built after install, so its
        // state reflects whether the app actually came up.
        const wire = wireOf(
          record,
          deps.states([record.name]).get(record.name),
        );
        announced(record.name, () => deps.announce(wire));
        return created(wire);
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    // The verb that stops a mistyped command from costing an app its address
    // and its data. Everything about it is shaped by one fact: the registry
    // write is the commit point, and past it the update HAS happened.
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
              "bookmark. To use a different name, delete the app and " +
              "register it again",
          );
        }
        if (Object.hasOwn(body, "port") && body.port !== before.port) {
          return fail(
            400,
            "invalid_request",
            "an app's port cannot be changed: isomux allocates it at " +
              "registration and it stays with the app for its whole life",
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
        const wire = wireOf(after, deps.states([after.name]).get(after.name));
        announced(after.name, () => deps.announce(wire));
        return ok(wire);
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
        // Throws if the app survived; the record below is then never removed,
        // its name and port stay spoken for, and a retried DELETE can finish
        // the job.
        deps.teardown(record.name);
        // Between the teardown and the removal: the app is provably not
        // running, so its token has nothing left to authenticate, and the
        // registry still holds the record that would let a retry finish the
        // job if this throws. Revoking after the record was gone would be a
        // credential whose owner nothing can look up.
        deps.revokeToken(record.name);
        if (!deps.remove(record.name)) return fail(404, "not_found");
        // The name is free from this line on, so the message budget attached to
        // it has to go with the old app. Otherwise the next app to take the
        // name - which can belong to a different user - inherits whatever the
        // previous one had already spent, up to a full day's cap. AFTER the
        // removal committed and non-throwing, because forgetting a rate limit
        // is not worth failing a delete that already happened.
        deps.limiter.forget(record.name);
        // AFTER the removal committed, and from the record read before teardown:
        // the registry no longer holds an owner to project the audience from.
        announced(record.name, () =>
          deps.announceRemoved({ name: record.name, userId: record.userId }),
        );
        return noContent();
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    // The recovery verbs. Without them the only cure for an app that has come
    // to rest in `failed` is DELETE, which costs it its port and its data
    // directory - a steep price for a crash loop or a source file that has
    // since been fixed.
    // (A mistyped start COMMAND is cured by apps.update instead, which
    // rewrites the unit and restarts what was running.)
    "apps.start": actionHandler(deps, (name) => deps.start(name)),
    "apps.stop": actionHandler(deps, (name) => deps.stop(name)),
    "apps.restart": actionHandler(deps, (name) => deps.restart(name)),

    // The loop closed: an app messaging the agent that built it. The only route
    // an app token reaches, and the only handler here whose caller is the app
    // rather than its owner.
    //
    // NOTHING ABOUT THE MESSAGE IS THE CALLER'S TO CHOOSE except the text. Which
    // app is speaking comes from the token, who hears it comes from the registry,
    // and how it is labelled comes from the app's registered name. A body field
    // for any of those would be a field to lie in.
    "apps.sendMessage": (ctx) => {
      // appScope proved both the scope and the presence of appName.
      const appName = ctx.identity.appName ?? "";
      const body = (ctx.body ?? {}) as { text?: unknown };
      if (typeof body.text !== "string" || body.text.trim() === "") {
        // trim, not length: a whitespace-only message wakes an agent and burns
        // model tokens on nothing, which is precisely the shape of an unattended
        // caller's bug.
        return fail(400, "invalid_text", "text is required");
      }
      if (body.text.length > APP_MESSAGE_MAX_CHARS) {
        return fail(
          400,
          "text_too_long",
          `text must be at most ${APP_MESSAGE_MAX_CHARS} characters`,
        );
      }

      // THE BURST SLOT IS TAKEN HERE, before this handler's registry read -
      // deliberately earlier than the delivery attempt. (Authentication has
      // already looked the app record up to resolve the token, so this is not
      // the first read of the request; it is the first one the handler can
      // decide not to do.) Everything below this line costs isomux something
      // else, and a caller that hammers a request which always fails would
      // otherwise pay nothing for it. So a syntactically valid request spends a
      // burst slot whatever its outcome, while the DAILY budget - the one that
      // stands for model spend - is spent at the bottom, only on a delivery the
      // receiver accepted.
      const limit = deps.limiter.takeBurst(appName);
      if (!limit.ok) {
        return fail(
          429,
          limit.kind === "burst" ? "rate_limited" : "daily_cap_reached",
          limit.kind === "burst"
            ? `too many messages: retry in ${limit.retryAfterSec}s`
            : `daily message limit reached: retry in ${limit.retryAfterSec}s`,
          // Machine-readable alongside the sentence, so a caller can back off
          // without parsing prose.
          { retryAfterSec: limit.retryAfterSec },
        );
      }

      try {
        // Token resolution already refused a token whose app is gone, so this is
        // the narrow race where the app was deleted between the two.
        const record = deps.get(appName);
        if (!record) {
          return fail(404, "not_found", "this app is no longer registered");
        }
        // Apps registered by a PERSON have no agent attached. Nothing to do
        // about it from here: naming a different target would be exactly the
        // body-supplied recipient this route refuses to have.
        if (!record.createdByAgentId) {
          return fail(
            409,
            "no_target",
            "this app was not registered by an agent, so there is no agent to message",
          );
        }
        const sent = deps.sendAsApp(
          appName,
          record.createdByAgentId,
          body.text,
        );
        if (!sent.ok) {
          // The agent that built the app is gone. Reported as its own code with
          // an answer to "so what do I do", because the raw delivery error
          // ("agent not found") reads like a bad parameter - and there is no
          // parameter.
          if (sent.status === 404) {
            return fail(
              404,
              "target_gone",
              "the agent that registered this app no longer exists, so there is nobody to message; pointing an app at a different agent is not supported yet",
            );
          }
          return fail(sent.status, sent.code, sent.message);
        }
        // ACCEPTED, so the day's budget moves. A stopped, missing or full
        // receiver never reaches this line: it woke nobody, so it costs the app
        // nothing but its burst slot.
        deps.limiter.commitDaily(appName);
        return ok({
          messageId: sent.messageId ?? "",
          ...(sent.queued === undefined ? {} : { queued: sent.queued }),
        });
      } catch (err) {
        return renderRegistryError(err);
      }
    },

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

// Announce, and never let the telling of it change what was told.
//
// Every announce call site sits AFTER its commit point and inside the handler's
// outer try, whose catch renders an HTTP failure. So a throw from the injected
// wire seam - a send implementation that reports failure by throwing, a test
// fake, a future fan-out that does real work - would answer 500 for a register
// that really did register, or a delete that really did remove the record. The
// caller's natural response to a 500 is a retry, and there is nothing left to
// retry: the name is taken, or already gone.
//
// This is the same rule the handler already applies to install/reinstall, one
// layer out. The announcement is the LAST thing that happens and the least
// important: a socket that missed a frame re-converges on the Apps tab's next
// poll, while a lie about whether the mutation happened does not heal.
function announced(what: string, send: () => void): void {
  try {
    send();
  } catch (err) {
    console.error(`[apps] "${what}" changed but was not announced:`, err);
  }
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
      // A throw here escapes to renderRegistryError, so nothing is announced -
      // a verb that failed changed nothing to tell anyone about.
      act(record.name);
      const wire = toWire(
        record,
        deps.states([record.name]).get(record.name),
        deps.publicUrl(record),
      );
      announced(record.name, () => deps.announce(wire));
      return ok(wire);
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
