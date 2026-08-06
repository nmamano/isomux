// Apps resource handlers - the agent-facing app registry (opIds
// apps.{list,get,register,delete}). See internal-docs/agent-apps-design.md.
//
// The verb is REGISTER, not create: the agent already built the app: isomux is
// being handed something that exists, and answers with the port it allocated
// and the data directory it created.
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
import type { Identity } from "../../identity/index.ts";
import type { AppRecord } from "../../../shared/types.ts";
import type {
  AppErrorCode,
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
}

// The ONE place a record becomes wire. `state` is derived, never stored, so
// when a supervisor lands only this function changes.
function toWire(record: AppRecord): AppWire {
  return { ...record, state: "registered" };
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
        return ok(visible.map(toWire));
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    // The owner-or-office-owner guard has already run on :name, so reaching
    // here means the caller may see this app - a miss is a genuine unknown.
    "apps.get": (ctx) => {
      try {
        const record = deps.get(ctx.params.name);
        return record ? ok(toWire(record)) : fail(404, "not_found");
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
        return created(toWire(record));
      } catch (err) {
        return renderRegistryError(err);
      }
    },

    "apps.delete": (ctx) => {
      try {
        return deps.remove(ctx.params.name)
          ? noContent()
          : fail(404, "not_found");
      } catch (err) {
        return renderRegistryError(err);
      }
    },
  };
}

// An AppRegistryError carries the wire code; anything else is a genuine
// surprise and is re-thrown for the executor to log and answer 500.
function renderRegistryError(err: unknown) {
  if (err instanceof AppRegistryError) {
    return fail(STATUS_BY_CODE[err.code], err.code, err.message);
  }
  throw err;
}
