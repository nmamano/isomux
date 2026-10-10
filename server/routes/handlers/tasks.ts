import type { AuditPage } from "../../../shared/audit.ts";
// Tasks resource handlers. The global shared board on the
// unified REST surface (opIds tasks.{list,get,create,update,claim,done,delete}).
//
// Strangler: complete. These handlers are the ONLY task surface - the legacy
// loopback /tasks HTTP routes that shared these core ops (the AgentManager task
// methods, injected via TasksDeps) are retired, as are the WS
// add_task/update_task/delete_task arms. The office UI drives create/update/delete
// through these REST routes. The manager
// emits the domain tasks_changed event, which the wireEventSinks sink routes
// through the emit() helper as the `all`-audience `tasks` event - so the handler
// never emits directly. The HTTP response here is the caller's own outcome
// (double-signal).
//
// [behavior-change] tasks.create: createdBy + username come from the TOKEN
// identity (deps.attributionFor), NEVER the request body - so the member cannot be
// spoofed. For a USER caller both equal the user's own name (today's posture);
// for an AGENT caller createdBy is the agent name and username the owning user.
//
// LEAF over the executor + shared types. No manager/auth imports - only the
// injected TasksDeps surface.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { TaskItem } from "../../../shared/types.ts";
import { isValidStatus, isValidPriority } from "../../../shared/types.ts";
import { inDefaultTaskList, isClosedTask } from "../../../shared/task-board.ts";
import type {
  TaskCreateReq,
  TaskUpdateReq,
  TaskClaimReq,
} from "../../../shared/contract-shapes.ts";

type TaskChanges = Partial<
  Pick<
    TaskItem,
    "title" | "description" | "priority" | "status" | "assignee" | "roomId"
  >
>;

export interface TasksDeps {
  history?(id: string, before?: number): AuditPage;
  deletedTask?(id: string): Omit<TaskItem, "version"> | null;
  restoreTask?(task: Omit<TaskItem, "version">): TaskItem;
  listTasks(): TaskItem[];
  createTask(input: {
    title: string;
    createdBy: string;
    username?: string;
    description?: string;
    priority?: TaskItem["priority"];
    assignee?: string;
    roomId?: string;
  }): TaskItem;
  updateTask(id: string, changes: TaskChanges): TaskItem | null;
  deleteTask(id: string): boolean;
  // Token-derived attribution: createdBy is the caller's display identity (agent
  // name, or the human's name on a user token); username is the token's owning
  // user. Never sourced from the request body.
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  // The set of room ids this caller can ACCESS (owner → every live room by rule;
  // member → their granted rooms; agent → its spawning user's accessible set).
  // Room ACCESS, not view - a hidden room stays accessible. Global tasks (no
  // roomId) are visible to everyone and are NOT represented here.
  accessibleRoomIds(identity: Identity): Set<string>;
  // The room a create with NO roomId in the body defaults to: an AGENT caller's
  // OWN room, or undefined (office-global) for a user / unknown identity. This is
  // how "agent create → the agent's room" and "direct user/API create with no
  // room param → global" are both realized.
  defaultCreateRoomId(identity: Identity): string | undefined;
}

// A task is visible to a caller when it is office-global (no roomId) OR its room
// is in the caller's accessible set. Used for list/get filtering and as the
// pre-mutation object-visibility gate (update/claim/done/delete → 404 when the
// caller can't see the task, so a room-task id is not a cross-room oracle).
function taskVisible(task: TaskItem, accessible: Set<string>): boolean {
  return !task.roomId || accessible.has(task.roomId);
}

// "backlog" was a status until task 77460aea folded it into priority P4.
// Callers that still send it get told where it went.
const BACKLOG_GONE =
  'status "backlog" no longer exists; backlog tasks are open tasks with priority P4';

export function tasksHandlers(deps: TasksDeps): Record<string, RouteHandler> {
  // Pre-mutation object-visibility gate: resolve the task and confirm the caller
  // can see it (accessible room ∪ global). A missing task and a task the caller
  // can't see BOTH return null → the handlers 404 uniformly, so a mutation can
  // neither write across rooms nor probe a room-task's existence.
  const visibleTask = (id: string, identity: Identity): TaskItem | null => {
    const t = deps.listTasks().find((x) => x.id === id);
    if (!t) return null;
    return taskVisible(t, deps.accessibleRoomIds(identity)) ? t : null;
  };
  return {
    "tasks.history": (ctx) => {
      const task = visibleTask(ctx.params.id, ctx.identity);
      if (!task) return fail(404, "not_found");
      const raw = ctx.query.get("before");
      if (
        raw !== null &&
        (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      )
        return fail(400, "invalid_request");
      const page = deps.history!(
        task.id,
        raw === null ? undefined : Number(raw),
      );
      return ok({
        createdAt: task.createdAt,
        createdBy: task.createdBy,
        ...page,
      });
    },
    "tasks.restore": (ctx) => {
      if (deps.listTasks().some((task) => task.id === ctx.params.id))
        return fail(409, "task_exists");
      const task = deps.deletedTask!(ctx.params.id);
      if (!task) return fail(409, "no_stored_deletion");
      if (task.roomId && !deps.accessibleRoomIds(ctx.identity).has(task.roomId))
        return fail(409, "room_unavailable");
      return created(deps.restoreTask!(task));
    },
    "tasks.list": (ctx) => {
      const status = ctx.query.get("status");
      const assignee = ctx.query.get("assignee");
      const titleFilter = ctx.query.get("title");
      const roomFilter = ctx.query.get("roomId");
      const priorityFilter = ctx.query.get("priority");
      if (status === "backlog") {
        return fail(400, "invalid_request", BACKLOG_GONE);
      }
      if (priorityFilter !== null && !isValidPriority(priorityFilter)) {
        return fail(400, "invalid_request", "invalid priority, must be P0-P4");
      }
      // Room scope FIRST: a caller only ever sees their accessible rooms UNION
      // office-global tasks; the status/assignee/title filters narrow within that.
      const accessible = deps.accessibleRoomIds(ctx.identity);
      let filtered = deps.listTasks().filter((t) => taskVisible(t, accessible));
      // Explicit room filter, same grammar as the create/update
      // roomId field so one value means one thing across all three verbs:
      //   ?roomId=<id>  -> that room only, IF the caller can access it
      //   ?roomId=      -> office-global tasks only
      //   omitted       -> no room filter (accessible rooms ∪ global, as before)
      // An inaccessible or unknown id is the same uniform 404 create/update give
      // it, NOT an empty list: a typo answering "no tasks here" is precisely the
      // silent-wrong-answer failure this param exists to end.
      if (roomFilter !== null) {
        if (roomFilter.length === 0) {
          filtered = filtered.filter((t) => !t.roomId);
        } else if (accessible.has(roomFilter)) {
          filtered = filtered.filter((t) => t.roomId === roomFilter);
        } else {
          return fail(404, "not_found");
        }
      }
      // A named priority lifts the P4 exclusion: ?priority=P4 lists the
      // open and in-progress P4 tasks. Explicit status filters are literal.
      if (!status) {
        filtered = filtered.filter((t) =>
          priorityFilter ? !isClosedTask(t) : inDefaultTaskList(t),
        );
      } else if (status !== "all") {
        filtered = filtered.filter((t) => t.status === status);
      }
      if (priorityFilter) {
        filtered = filtered.filter((t) => t.priority === priorityFilter);
      }
      if (assignee) filtered = filtered.filter((t) => t.assignee === assignee);
      if (titleFilter) {
        const q = titleFilter.toLowerCase();
        filtered = filtered.filter((t) => t.title.toLowerCase().includes(q));
      }
      return ok(filtered);
    },

    "tasks.get": (ctx) => {
      const accessible = deps.accessibleRoomIds(ctx.identity);
      const task = deps.listTasks().find((t) => t.id === ctx.params.id);
      // Not-found and not-visible collapse to the SAME 404: a room-task id must
      // not be an existence oracle for a caller outside its room.
      return task && taskVisible(task, accessible)
        ? ok(task)
        : fail(404, "not_found");
    },

    "tasks.create": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<TaskCreateReq>;
      if (typeof body.title !== "string" || body.title.length === 0) {
        return fail(400, "invalid_request", "title is required");
      }
      // A create takes no status (every task starts open), except that a
      // caller still sending the old backlog status is told where it went.
      if ((body as { status?: unknown }).status === "backlog") {
        return fail(400, "invalid_request", BACKLOG_GONE);
      }
      if (body.priority !== undefined && !isValidPriority(body.priority)) {
        return fail(400, "invalid_request", "invalid priority, must be P0-P4");
      }
      // Resolve which room the task is filed under:
      //   - body omits roomId       → scope default (agent's room / global)
      //   - body roomId === ""       → office-global (explicit)
      //   - body roomId is a room id → that room, IF the caller can access it
      // An explicit target the caller can't access is a UNIFORM 404 (no
      // unknown-vs-forbidden oracle; an owner's all-rooms set naturally lets them
      // tell a truly unknown id apart). A non-string roomId is a 400 shape error.
      let roomId: string | undefined;
      if (Object.prototype.hasOwnProperty.call(body, "roomId")) {
        if (typeof body.roomId !== "string") {
          return fail(400, "invalid_request", "roomId must be a string");
        }
        if (body.roomId.length === 0) {
          roomId = undefined; // explicit global
        } else if (deps.accessibleRoomIds(ctx.identity).has(body.roomId)) {
          roomId = body.roomId;
        } else {
          return fail(404, "not_found");
        }
      } else {
        roomId = deps.defaultCreateRoomId(ctx.identity);
      }
      const { createdBy, username } = deps.attributionFor(ctx.identity);
      const task = deps.createTask({
        title: body.title,
        createdBy,
        username,
        description:
          typeof body.description === "string" ? body.description : undefined,
        priority: body.priority,
        assignee: typeof body.assignee === "string" ? body.assignee : undefined,
        roomId,
      });
      return created(task);
    },

    "tasks.update": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<TaskUpdateReq>;
      if ((body.status as string | undefined) === "backlog") {
        return fail(400, "invalid_request", BACKLOG_GONE);
      }
      if (body.status !== undefined && !isValidStatus(body.status)) {
        return fail(
          400,
          "invalid_request",
          "invalid status, must be open|in_progress|done|obsolete",
        );
      }
      // `priority: null` CLEARS the priority; anything else
      // non-null must name a real level. An empty string is not a clear - it is
      // a malformed level, same as "P9".
      if (
        body.priority !== undefined &&
        body.priority !== null &&
        !isValidPriority(body.priority)
      ) {
        return fail(
          400,
          "invalid_request",
          "invalid priority, must be P0-P4 or null to clear",
        );
      }
      // Re-room validation is SPLIT across the visibility gate (full behavior
      // matrix at the assembly block below). Only the SHAPE check runs here: a
      // non-string roomId is a caller-side 400, so it belongs with the other
      // body-shape 400s ABOVE the gate. The accessibility check is a visibility
      // question and lives AFTER the gate.
      const reRooming = Object.prototype.hasOwnProperty.call(body, "roomId");
      if (reRooming && typeof body.roomId !== "string") {
        return fail(400, "invalid_request", "roomId must be a string");
      }
      // Every PATCH carries the version the caller read (task 4243ecc0, Nil's
      // ruling: mandatory). Same rail as rooms.setSettings: a missing version
      // is a shape 400, a stale one a 409 after the visibility gate.
      if (typeof body.version !== "string" || body.version.length === 0) {
        return fail(
          400,
          "invalid_version",
          "version is required (from a preceding read of the task)",
        );
      }
      // Object-visibility gate AFTER body-shape validation (a malformed body is
      // the caller's own 400 regardless of the task; a well-formed write to a
      // task the caller can't see is the same 404 as an unknown id).
      const current = visibleTask(ctx.params.id, ctx.identity);
      if (!current) return fail(404, "not_found");
      // The check and the write below run in one synchronous step, so no
      // other write can land between them.
      if (body.version !== current.version) {
        return fail(
          409,
          "version_conflict",
          "the task changed since your read; re-read and retry",
          { version: current.version, task: { ...current } },
        );
      }
      const changes: TaskChanges = {};
      if (typeof body.title === "string") changes.title = body.title;
      if (body.description !== undefined) {
        changes.description =
          typeof body.description === "string" ? body.description : undefined;
      }
      if (body.status !== undefined) changes.status = body.status;
      if (body.priority !== undefined) {
        // Validated above: either a real level or the null clear (which reaches
        // the core as `undefined`, like the description/assignee clears).
        changes.priority = body.priority ?? undefined;
      }
      if (body.assignee !== undefined) {
        changes.assignee =
          typeof body.assignee === "string" ? body.assignee : undefined;
      }
      // Re-room (shape already checked above), mirroring tasks.create:
      //   - "" (empty)         → clear to office-global (changes.roomId=undefined
      //                          → mirrors the description/assignee clear path;
      //                          an untouched update leaves the key out entirely)
      //   - accessible room id → move there
      //   - inaccessible/unknown id → uniform 404 (no unknown-vs-forbidden oracle;
      //                          post-gate, target reachability is a visibility Q)
      if (reRooming) {
        const rid = body.roomId as string;
        if (rid.length === 0) {
          changes.roomId = undefined; // explicit clear → office-global
        } else if (deps.accessibleRoomIds(ctx.identity).has(rid)) {
          changes.roomId = rid;
        } else {
          return fail(404, "not_found");
        }
      }
      const task = deps.updateTask(ctx.params.id, changes);
      return task ? ok(task) : fail(404, "not_found");
    },

    "tasks.claim": (ctx) => {
      const body = (ctx.body ?? {}) as TaskClaimReq;
      const current = visibleTask(ctx.params.id, ctx.identity);
      if (!current) return fail(404, "not_found");
      // A claim takes an unheld task, or one the named assignee already holds.
      // Taking a task from its holder is an explicit PATCH of assignee, which
      // carries the version (task 4243ecc0).
      const claimant =
        typeof body.assignee === "string" && body.assignee.length > 0
          ? body.assignee
          : undefined;
      if (current.assignee && current.assignee !== claimant) {
        return fail(
          409,
          "task_held",
          `the task is held by ${current.assignee}; to reassign it, PATCH assignee with the task's version`,
          { assignee: current.assignee },
        );
      }
      const changes: TaskChanges = { status: "in_progress" };
      if (typeof body.assignee === "string") changes.assignee = body.assignee;
      const task = deps.updateTask(ctx.params.id, changes);
      return task ? ok(task) : fail(404, "not_found");
    },

    "tasks.done": (ctx) => {
      if (!visibleTask(ctx.params.id, ctx.identity))
        return fail(404, "not_found");
      const task = deps.updateTask(ctx.params.id, { status: "done" });
      return task ? ok(task) : fail(404, "not_found");
    },

    "tasks.delete": (ctx) => {
      if (!visibleTask(ctx.params.id, ctx.identity))
        return fail(404, "not_found");
      return deps.deleteTask(ctx.params.id)
        ? noContent()
        : fail(404, "not_found");
    },
  };
}
