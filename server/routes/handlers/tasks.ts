// Tasks resource handlers — Phase 3a slice 1. The global shared board on the
// unified REST surface (opIds tasks.{list,get,create,update,claim,done,delete}).
//
// Strangler: these REST handlers and the legacy loopback /tasks HTTP routes
// delegate to the SAME core ops (the AgentManager task methods, injected via
// TasksDeps). The office UI now drives create/update/delete through these REST
// routes — the WS add_task/update_task/delete_task arms are retired. The manager
// emits the domain tasks_changed event, which the wireEventSinks sink routes
// through the emit() helper as the `all`-audience `tasks` event — so the handler
// never emits directly. The HTTP response here is the caller's own outcome
// (double-signal).
//
// [behavior-change] tasks.create: createdBy + username come from the TOKEN
// identity (deps.attributionFor), NEVER the request body — so the boss cannot be
// spoofed. For a USER caller both equal the user's own name (today's posture);
// for an AGENT caller createdBy is the agent name and username the owning user.
//
// LEAF over the executor + shared types. No manager/auth imports — only the
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
import type {
  TaskCreateReq,
  TaskUpdateReq,
  TaskClaimReq,
} from "../../../shared/contract-shapes.ts";

type TaskChanges = Partial<
  Pick<TaskItem, "title" | "description" | "priority" | "status" | "assignee">
>;

export interface TasksDeps {
  listTasks(): TaskItem[];
  createTask(input: {
    title: string;
    createdBy: string;
    username?: string;
    description?: string;
    priority?: TaskItem["priority"];
    assignee?: string;
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
}

export function tasksHandlers(deps: TasksDeps): Record<string, RouteHandler> {
  return {
    "tasks.list": (ctx) => {
      const status = ctx.query.get("status");
      const assignee = ctx.query.get("assignee");
      const titleFilter = ctx.query.get("title");
      let filtered = deps.listTasks();
      if (!status) {
        filtered = filtered.filter(
          (t) => t.status !== "done" && t.status !== "backlog",
        );
      } else if (status !== "all") {
        filtered = filtered.filter((t) => t.status === status);
      }
      if (assignee) filtered = filtered.filter((t) => t.assignee === assignee);
      if (titleFilter) {
        const q = titleFilter.toLowerCase();
        filtered = filtered.filter((t) => t.title.toLowerCase().includes(q));
      }
      return ok(filtered);
    },

    "tasks.get": (ctx) => {
      const task = deps.listTasks().find((t) => t.id === ctx.params.id);
      return task ? ok(task) : fail(404, "not_found");
    },

    "tasks.create": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<TaskCreateReq>;
      if (typeof body.title !== "string" || body.title.length === 0) {
        return fail(400, "invalid_request", "title is required");
      }
      if (body.priority !== undefined && !isValidPriority(body.priority)) {
        return fail(400, "invalid_request", "invalid priority, must be P0-P3");
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
      });
      return created(task);
    },

    "tasks.update": (ctx) => {
      const body = (ctx.body ?? {}) as TaskUpdateReq;
      if (body.status !== undefined && !isValidStatus(body.status)) {
        return fail(
          400,
          "invalid_request",
          "invalid status, must be open|in_progress|backlog|done",
        );
      }
      if (body.priority !== undefined && !isValidPriority(body.priority)) {
        return fail(400, "invalid_request", "invalid priority, must be P0-P3");
      }
      const changes: TaskChanges = {};
      if (typeof body.title === "string") changes.title = body.title;
      if (body.description !== undefined) {
        changes.description =
          typeof body.description === "string" ? body.description : undefined;
      }
      if (body.status !== undefined) changes.status = body.status;
      if (body.priority !== undefined) {
        changes.priority = body.priority ? body.priority : undefined;
      }
      if (body.assignee !== undefined) {
        changes.assignee =
          typeof body.assignee === "string" ? body.assignee : undefined;
      }
      const task = deps.updateTask(ctx.params.id, changes);
      return task ? ok(task) : fail(404, "not_found");
    },

    "tasks.claim": (ctx) => {
      const body = (ctx.body ?? {}) as TaskClaimReq;
      const changes: TaskChanges = { status: "in_progress" };
      if (typeof body.assignee === "string") changes.assignee = body.assignee;
      const task = deps.updateTask(ctx.params.id, changes);
      return task ? ok(task) : fail(404, "not_found");
    },

    "tasks.done": (ctx) => {
      const task = deps.updateTask(ctx.params.id, { status: "done" });
      return task ? ok(task) : fail(404, "not_found");
    },

    "tasks.delete": (ctx) => {
      return deps.deleteTask(ctx.params.id)
        ? noContent()
        : fail(404, "not_found");
    },
  };
}
