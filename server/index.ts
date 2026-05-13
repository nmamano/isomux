import type { ServerWebSocket } from "bun";
import type {
  ServerMessage,
  ClientCommand,
  BackendModelWire,
} from "../shared/types.ts";
import * as AgentManager from "./agent-manager.ts";
import { getBackend } from "./backends/index.ts";
import * as CronjobManager from "./cronjob-manager.ts";
import {
  loadRecentCwds,
  saveRecentCwd,
  getFilePath,
  saveFile,
} from "./persistence.ts";
import type { Attachment } from "../shared/types.ts";
import {
  startUpdateChecker,
  getUpdateStatus,
  onUpdateChange,
} from "./update-checker.ts";
import { startBackupScheduler, getBackupStatus } from "./backup.ts";
import { logCodexVersionAtBoot } from "./backends/codex/version-check.ts";
import { resolveCwd } from "./cwd-utils.ts";
import type { TaskItem } from "../shared/types.ts";
import { isValidStatus, isValidPriority } from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import {
  listUsers,
  getUser,
  claimUser,
  updateUser,
  deleteUser,
} from "./users.ts";
import { watchFile, stopWatch, type FileWatcher } from "./file-editor.ts";
import { mimeTypeForFilename } from "./mime-types.ts";
import { join } from "path";

const browsers = new Set<ServerWebSocket<unknown>>();

// Per-WS editor file watchers. Each open file gets one fs.watch handle keyed
// by `${agentId}\0${absPath}` so the same path can be watched independently
// across agents. Watchers close on editor_close or WS disconnect.
const editorWatchers = new WeakMap<
  ServerWebSocket<unknown>,
  Map<string, FileWatcher>
>();

function editorKey(agentId: string, absPath: string): string {
  return `${agentId}\0${absPath}`;
}

function getWatcherMap(ws: ServerWebSocket<unknown>): Map<string, FileWatcher> {
  let map = editorWatchers.get(ws);
  if (!map) {
    map = new Map();
    editorWatchers.set(ws, map);
  }
  return map;
}

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    ws.send(data);
  }
}

// Wire AgentManager events to WebSocket broadcasts
AgentManager.onEvent((event) => {
  // Task mutations carry the full list as a domain event; the wire still
  // uses the legacy `{type:"tasks", tasks}` shape so the UI doesn't change.
  if (event.type === "tasks_changed") {
    broadcast({ type: "tasks", tasks: event.tasks });
    return;
  }
  broadcast(event);
});

// Wire CronjobManager events to WebSocket broadcasts
CronjobManager.onCronjobEvent((event) => {
  broadcast(event);
});

async function handleCommand(cmd: ClientCommand, ws: ServerWebSocket<unknown>) {
  switch (cmd.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      break;
    case "spawn": {
      try {
        AgentManager.validateCwd(cmd.cwd);
      } catch (err) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Invalid directory"),
            }),
          );
        }
        break;
      }
      saveRecentCwd(cmd.cwd);
      try {
        const created = await AgentManager.spawn(
          cmd.name,
          cmd.cwd,
          cmd.permissionMode,
          cmd.desk,
          cmd.customInstructions,
          cmd.roomId,
          cmd.outfit,
          cmd.modelFamily,
          cmd.effort,
          cmd.username,
          cmd.agentType,
          cmd.codexSandbox,
        );
        if (cmd.requestId) {
          if (created) {
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: true,
              }),
            );
          } else {
            // spawn() returns null on duplicate name or full room — neither
            // throws, so without this branch we'd report ok:true on logical
            // failure and the UI would close the dialog as if it worked.
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: false,
                error:
                  "Cannot create agent: name may be taken or the target room has no free desks.",
              }),
            );
          }
        }
      } catch (err) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Spawn failed"),
            }),
          );
        }
      }
      break;
    }
    case "kill":
      await AgentManager.kill(cmd.agentId);
      break;
    case "abort":
      await AgentManager.abort(cmd.agentId);
      break;
    case "send_message":
      // Don't await — let it stream in the background
      void AgentManager.sendMessage(
        cmd.agentId,
        cmd.text,
        cmd.username,
        cmd.device,
        cmd.attachments,
      );
      break;
    case "cancel_queued":
      AgentManager.cancelQueued(cmd.agentId, cmd.messageId);
      break;
    case "send_now":
      void AgentManager.sendNow(cmd.agentId);
      break;
    case "new_conversation":
      await AgentManager.newConversation(cmd.agentId);
      break;
    case "resume":
      await AgentManager.resume(cmd.agentId, cmd.sessionId);
      break;
    case "edit_agent": {
      if (cmd.cwd) {
        try {
          AgentManager.validateCwd(cmd.cwd);
        } catch (err) {
          if (cmd.requestId) {
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: false,
                error: errMessage(err, "Invalid directory"),
              }),
            );
          }
          break;
        }
        saveRecentCwd(cmd.cwd);
      }
      try {
        await AgentManager.editAgent(cmd.agentId, {
          name: cmd.name,
          cwd: cmd.cwd,
          outfit: cmd.outfit,
          customInstructions: cmd.customInstructions,
          modelFamily: cmd.modelFamily,
          effort: cmd.effort,
          permissionMode: cmd.permissionMode,
          codexSandbox: cmd.codexSandbox,
        });
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: true,
            }),
          );
        }
      } catch (err) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Edit failed"),
            }),
          );
        }
      }
      break;
    }
    case "swap_desks":
      AgentManager.swapDesks(cmd.deskA, cmd.deskB, cmd.roomId);
      break;
    case "set_topic":
      AgentManager.setTopic(cmd.agentId, cmd.topic);
      break;
    case "reset_topic":
      AgentManager.resetTopic(cmd.agentId);
      break;
    case "list_sessions": {
      const sessions = AgentManager.listSessions(cmd.agentId);
      const currentSessionId = AgentManager.getCurrentSessionId(cmd.agentId);
      broadcast({
        type: "sessions_list",
        agentId: cmd.agentId,
        sessions,
        currentSessionId,
      });
      break;
    }
    case "terminal_open": {
      const opened = AgentManager.openTerminal(cmd.agentId);
      if (opened) {
        // Replay buffered output so the browser catches up
        const buffer = AgentManager.getTerminalBuffer(cmd.agentId);
        if (buffer) {
          broadcast({
            type: "terminal_output",
            agentId: cmd.agentId,
            data: buffer,
          });
        }
      }
      break;
    }
    case "terminal_input":
      AgentManager.terminalInput(cmd.agentId, cmd.data);
      break;
    case "terminal_resize":
      AgentManager.terminalResize(cmd.agentId, cmd.cols, cmd.rows);
      break;
    case "terminal_close":
      AgentManager.closeTerminal(cmd.agentId);
      break;
    case "editor_open": {
      const probe = AgentManager.openEditorFile(cmd.agentId, cmd.path);
      if (!probe.ok) {
        ws.send(
          JSON.stringify({
            type: "editor_open_error",
            agentId: cmd.agentId,
            path: cmd.path,
            reason: probe.error === "not_agent" ? "io_error" : "bad_path",
            message:
              probe.error === "not_agent" ? "agent not found" : undefined,
          }),
        );
        break;
      }
      const r = probe.result;
      if (r.kind !== "ok") {
        ws.send(
          JSON.stringify({
            type: "editor_open_error",
            agentId: cmd.agentId,
            path: r.path,
            reason: r.kind,
            message: r.kind === "io_error" ? r.message : undefined,
            size: r.kind === "too_large" ? r.size : undefined,
          }),
        );
        break;
      }
      ws.send(
        JSON.stringify({
          type: "editor_content",
          agentId: cmd.agentId,
          path: r.path,
          content: r.content,
          mtime: r.mtime,
          language: r.language,
          size: r.size,
        }),
      );
      // Install (or replace) the per-WS watcher so external edits surface as
      // `editor_external_change`. Replacing collapses duplicate opens.
      const map = getWatcherMap(ws);
      const key = editorKey(cmd.agentId, r.path);
      const old = map.get(key);
      if (old) stopWatch(old);
      const watcher = watchFile(r.path, cmd.agentId, (mtime) => {
        ws.send(
          JSON.stringify({
            type: "editor_external_change",
            agentId: cmd.agentId,
            path: r.path,
            mtime,
          }),
        );
      });
      if (watcher) map.set(key, watcher);
      break;
    }
    case "editor_save": {
      // Resolve against the agent's cwd in case the client sent a relative
      // path (it shouldn't, but the resolution is cheap and matches open).
      const abs = AgentManager.resolveEditorPathForAgent(cmd.agentId, cmd.path);
      if (!abs) {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: cmd.path,
            ok: false,
            error: "agent not found",
          }),
        );
        break;
      }
      const result = AgentManager.saveEditorFile(
        abs,
        cmd.content,
        cmd.expectedMtime,
        cmd.force ?? false,
      );
      if (result.kind === "ok") {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: result.path,
            ok: true,
            mtime: result.mtime,
          }),
        );
      } else if (result.kind === "stale") {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: result.path,
            ok: false,
            reason: "stale",
            currentMtime: result.currentMtime,
            error: "File changed on disk since you opened it.",
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "editor_save_response",
            agentId: cmd.agentId,
            path: result.path,
            ok: false,
            error: result.message,
          }),
        );
      }
      break;
    }
    case "editor_close": {
      const abs = AgentManager.resolveEditorPathForAgent(cmd.agentId, cmd.path);
      if (!abs) break;
      const map = getWatcherMap(ws);
      const key = editorKey(cmd.agentId, abs);
      const w = map.get(key);
      if (w) {
        stopWatch(w);
        map.delete(key);
      }
      break;
    }
    case "update_office_settings": {
      const envFile =
        cmd.envFile && cmd.envFile.trim() ? cmd.envFile.trim() : null;
      if (envFile) {
        try {
          AgentManager.validateEnvPath(envFile);
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Invalid env file"),
            }),
          );
          break;
        }
      }
      AgentManager.setOfficeSettings(cmd.prompt, envFile);
      ws.send(
        JSON.stringify({
          type: "settings_save_response",
          requestId: cmd.requestId,
          ok: true,
        }),
      );
      break;
    }
    case "update_room_settings": {
      const ok = AgentManager.setRoomSettings(cmd.roomId, cmd.prompt);
      if (!ok) {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: false,
            error: "Room not found",
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      }
      break;
    }
    case "request_cwd_validation": {
      try {
        AgentManager.validateCwd(cmd.cwd);
        ws.send(
          JSON.stringify({
            type: "cwd_validation",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "cwd_validation",
            requestId: cmd.requestId,
            ok: false,
            error: errMessage(err, "Invalid directory"),
          }),
        );
      }
      break;
    }
    case "list_backend_models": {
      // Resolves the env file stack the same way a real spawn would, so
      // OPENAI_API_KEY / CHATGPT_LOGIN overrides from office or user files
      // are reflected in the model list. cwd validation is best-effort —
      // codex model/list itself doesn't require the cwd to be a real dir,
      // but we pass the requested cwd through so the subprocess inherits
      // it (matches what'll be used at spawn time).
      try {
        const backend = getBackend(cmd.agentType);
        const env = AgentManager.buildEnvFor(cmd.username);
        const models = await backend.listModels({
          // The codex subprocess's cwd must be a real directory or posix_spawn
          // fails with ENOENT before our error path can clean up — resolve `~`
          // here the same way AgentManager.spawn does before persisting.
          cwd: resolveCwd(cmd.cwd),
          env,
          includeHidden: cmd.includeHidden,
        });
        const wire: BackendModelWire[] = models.map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description,
          isDefault: m.isDefault,
          hidden: m.hidden,
          supportedEfforts: m.supportedEfforts,
          defaultEffort: m.defaultEffort,
        }));
        ws.send(
          JSON.stringify({
            type: "list_backend_models_response",
            requestId: cmd.requestId,
            ok: true,
            models: wire,
          }),
        );
      } catch (err) {
        const message = errMessage(err);
        // Auth-error flag lets the UI render a login-instructions message
        // instead of a generic "failed to load" — same pattern the
        // orchestrator uses for in-session auth detection.
        const authError = (() => {
          try {
            return getBackend(cmd.agentType).detectAuthError(message);
          } catch {
            return false;
          }
        })();
        ws.send(
          JSON.stringify({
            type: "list_backend_models_response",
            requestId: cmd.requestId,
            ok: false,
            error: message,
            authError,
          }),
        );
      }
      break;
    }
    case "request_settings_validation": {
      let envFile: string | null = null;
      if (cmd.scope === "office") {
        envFile = AgentManager.getOfficeSettings().envFile;
      } else if (cmd.scope === "user" && cmd.username) {
        envFile = getUser(cmd.username)?.envFile ?? null;
      }
      if (!envFile) {
        ws.send(
          JSON.stringify({
            type: "settings_validation",
            requestId: cmd.requestId,
            scope: cmd.scope,
            username: cmd.username,
            envFile: null,
            ok: true,
          }),
        );
        break;
      }
      try {
        const keyCount = AgentManager.validateEnvPath(envFile);
        ws.send(
          JSON.stringify({
            type: "settings_validation",
            requestId: cmd.requestId,
            scope: cmd.scope,
            username: cmd.username,
            envFile,
            ok: true,
            keyCount,
          }),
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "settings_validation",
            requestId: cmd.requestId,
            scope: cmd.scope,
            username: cmd.username,
            envFile,
            ok: false,
            error: errMessage(err, "Invalid env file"),
          }),
        );
      }
      break;
    }
    case "add_task": {
      AgentManager.addTask(cmd.title, cmd.username, {
        description: cmd.description,
        priority:
          cmd.priority && isValidPriority(cmd.priority)
            ? cmd.priority
            : undefined,
        assignee: cmd.assignee,
        username: cmd.username,
      });
      break;
    }
    case "update_task": {
      const c = cmd.changes;
      const changes: Partial<
        Pick<
          TaskItem,
          "title" | "description" | "priority" | "status" | "assignee"
        >
      > = {};
      if (c.title !== undefined) changes.title = String(c.title);
      if (c.description !== undefined)
        changes.description = c.description ? String(c.description) : undefined;
      if (c.assignee !== undefined)
        changes.assignee = c.assignee ? String(c.assignee) : undefined;
      if (c.status !== undefined && isValidStatus(c.status))
        changes.status = c.status;
      if (c.priority !== undefined && isValidPriority(c.priority))
        changes.priority = c.priority;
      AgentManager.updateTask(cmd.id, changes);
      break;
    }
    case "delete_task": {
      AgentManager.deleteTask(cmd.id);
      break;
    }
    case "create_room":
      AgentManager.createRoom(cmd.name);
      break;
    case "close_room":
      AgentManager.closeRoom(cmd.roomId);
      break;
    case "rename_room":
      AgentManager.renameRoom(cmd.roomId, cmd.name);
      break;
    case "move_agent":
      AgentManager.moveAgent(cmd.agentId, cmd.targetRoomId);
      break;
    case "reorder_rooms":
      AgentManager.reorderRooms(cmd.order);
      break;
    case "edit_message":
      // Don't await — let it stream in the background (like send_message)
      void AgentManager.editMessage(
        cmd.agentId,
        cmd.logEntryId,
        cmd.newText,
        cmd.username,
        cmd.device,
      );
      break;
    case "add_cronjob": {
      try {
        AgentManager.validateCwd(cmd.cwd);
      } catch (err) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "agent_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: errMessage(err, "Invalid directory"),
            }),
          );
        }
        break;
      }
      saveRecentCwd(cmd.cwd);
      CronjobManager.addCronjob({
        name: cmd.name,
        schedule: cmd.schedule,
        prompt: cmd.prompt,
        cwd: cmd.cwd,
        agentType: cmd.agentType ?? "claude",
        modelFamily: cmd.modelFamily,
        effort: cmd.effort,
        permissionMode: cmd.permissionMode,
        codexSandbox: cmd.codexSandbox,
        username: cmd.username,
      });
      if (cmd.requestId) {
        ws.send(
          JSON.stringify({
            type: "agent_save_response",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      }
      break;
    }
    case "update_cronjob": {
      if (cmd.changes.cwd) {
        try {
          AgentManager.validateCwd(cmd.changes.cwd);
        } catch (err) {
          if (cmd.requestId) {
            ws.send(
              JSON.stringify({
                type: "agent_save_response",
                requestId: cmd.requestId,
                ok: false,
                error: errMessage(err, "Invalid directory"),
              }),
            );
          }
          break;
        }
        saveRecentCwd(cmd.changes.cwd);
      }
      CronjobManager.updateCronjob(cmd.id, cmd.changes);
      if (cmd.requestId) {
        ws.send(
          JSON.stringify({
            type: "agent_save_response",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      }
      break;
    }
    case "delete_cronjob":
      CronjobManager.deleteCronjob(cmd.id);
      break;
    case "run_cronjob_now":
      CronjobManager.runCronjobNow(cmd.id, cmd.username);
      break;
    case "update_cronjobs_prompt":
      CronjobManager.setCronjobsPrompt(cmd.value);
      ws.send(
        JSON.stringify({
          type: "settings_save_response",
          requestId: cmd.requestId,
          ok: true,
        }),
      );
      break;
    case "list_cronjob_runs": {
      const runs = CronjobManager.getRunsForCronjob(cmd.cronjobId);
      ws.send(
        JSON.stringify({
          type: "cronjob_runs",
          cronjobId: cmd.cronjobId,
          runs,
        }),
      );
      break;
    }
    case "list_all_cronjob_runs": {
      // Returns runs for every cronjob dir on disk (including deleted ones)
      // so the Runs tab can surface historical runs after a cronjob is gone.
      for (const { jobId, runs } of CronjobManager.getAllRunsByJob()) {
        ws.send(
          JSON.stringify({
            type: "cronjob_runs",
            cronjobId: jobId,
            runs,
          }),
        );
      }
      // Sentinel so the client can flip its "runs loaded" flag even when no
      // cronjob has ever fired (no run dirs on disk = zero cronjob_runs sent).
      ws.send(JSON.stringify({ type: "cronjob_runs_complete" }));
      break;
    }
    case "load_cronjob_run": {
      // Client passes jobId from the run row it just clicked, so no scan
      // needed. Works for runs from deleted cronjobs too: getRunTranscript
      // reads from disk regardless of whether the cronjob config still exists.
      const { entries } = CronjobManager.getRunTranscript(
        cmd.cronjobId,
        cmd.runId,
      );
      for (const entry of entries) {
        ws.send(JSON.stringify({ type: "log_entry", entry }));
      }
      break;
    }
    case "send_cronjob_run_message":
      // Don't await — let it stream in the background (matches send_message).
      void CronjobManager.sendRunMessage(
        cmd.cronjobId,
        cmd.runId,
        cmd.text,
        cmd.username,
        cmd.device,
      );
      break;
    case "edit_cronjob_run_message":
      // Don't await — let it stream in the background (matches edit_message).
      void CronjobManager.editRunMessage(
        cmd.cronjobId,
        cmd.runId,
        cmd.logEntryId,
        cmd.newText,
        cmd.username,
        cmd.device,
      );
      break;
    case "claim_user": {
      const user = claimUser(cmd.username, {
        defaultRoomId: cmd.defaultRoomId,
        notifRooms: cmd.notifRooms,
      });
      broadcast({ type: "user_updated", user });
      broadcast({ type: "users_list", users: listUsers() });
      break;
    }
    case "update_user": {
      // Validate envFile if present.
      if (cmd.changes.envFile && cmd.changes.envFile.trim()) {
        try {
          AgentManager.validateEnvPath(cmd.changes.envFile.trim());
        } catch (err) {
          if (cmd.requestId) {
            ws.send(
              JSON.stringify({
                type: "settings_save_response",
                requestId: cmd.requestId,
                ok: false,
                error: errMessage(err, "Invalid env file"),
              }),
            );
          }
          break;
        }
      }
      const result = updateUser(cmd.username, cmd.changes);
      if (!result.ok) {
        if (cmd.requestId) {
          ws.send(
            JSON.stringify({
              type: "settings_save_response",
              requestId: cmd.requestId,
              ok: false,
              error: result.error,
            }),
          );
        }
        break;
      }
      if (cmd.requestId) {
        ws.send(
          JSON.stringify({
            type: "settings_save_response",
            requestId: cmd.requestId,
            ok: true,
          }),
        );
      }
      // Tell the client the old key when a re-key rename happened, so it can
      // drop the stale entry from its keyed map without waiting for the
      // follow-up users_list rebroadcast.
      const renamed =
        cmd.username.toLowerCase() !== result.user.name.toLowerCase();
      broadcast({
        type: "user_updated",
        user: result.user,
        ...(renamed ? { prevName: cmd.username } : {}),
      });
      broadcast({ type: "users_list", users: listUsers() });
      break;
    }
    case "delete_user": {
      deleteUser(cmd.username);
      broadcast({ type: "users_list", users: listUsers() });
      break;
    }
  }
}

// Resolve UI dist path
const UI_DIST = join(import.meta.dir, "..", "ui", "dist");

const PORT = parseInt(process.env.PORT || "4000");

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // CORS preflight for task API
    if (req.method === "OPTIONS" && url.pathname.startsWith("/tasks")) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // CORS preflight for cronjobs API
    if (req.method === "OPTIONS" && url.pathname.startsWith("/cronjobs")) {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Cronjobs HTTP API (read-only — mutations go through WebSocket)
    if (url.pathname.startsWith("/cronjobs")) {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      };
      const parts = url.pathname.split("/").filter(Boolean); // ["cronjobs"] or ["cronjobs", id] or ["cronjobs", id, "runs"] or ["cronjobs", id, "runs", runId]
      if (req.method !== "GET") {
        return new Response(JSON.stringify({ error: "method not allowed" }), {
          status: 405,
          headers: corsHeaders,
        });
      }
      const cronjobs = CronjobManager.listCronjobs();
      // GET /cronjobs
      if (parts.length === 1) {
        return new Response(JSON.stringify(cronjobs), { headers: corsHeaders });
      }
      const jobId = parts[1];
      const cronjob = cronjobs.find((c) => c.id === jobId);
      if (!cronjob)
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      // GET /cronjobs/:id
      if (parts.length === 2) {
        return new Response(JSON.stringify(cronjob), { headers: corsHeaders });
      }
      // GET /cronjobs/:id/runs
      if (parts[2] === "runs" && parts.length === 3) {
        const runs = CronjobManager.getRunsForCronjob(jobId);
        return new Response(JSON.stringify(runs), { headers: corsHeaders });
      }
      // GET /cronjobs/:id/runs/:runId
      if (parts[2] === "runs" && parts.length === 4) {
        const { run, entries } = CronjobManager.getRunTranscript(
          jobId,
          parts[3],
        );
        if (!run)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ run, entries }), {
          headers: corsHeaders,
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Task HTTP API
    if (url.pathname.startsWith("/tasks")) {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      };
      const parts = url.pathname.split("/").filter(Boolean); // ["tasks"] or ["tasks", id] or ["tasks", id, action]
      const taskId = parts[1];
      const action = parts[2]; // "claim" or "done"

      // DELETE blocked at HTTP level
      if (req.method === "DELETE") {
        return new Response(
          JSON.stringify({ error: "DELETE not allowed via HTTP" }),
          { status: 405, headers: corsHeaders },
        );
      }

      // GET /tasks — list (excludes done and backlog by default)
      if (req.method === "GET" && !taskId) {
        const status = url.searchParams.get("status");
        const assignee = url.searchParams.get("assignee");
        const titleFilter = url.searchParams.get("title");
        let filtered = AgentManager.getTasks();
        if (!status) {
          filtered = filtered.filter(
            (t) => t.status !== "done" && t.status !== "backlog",
          );
        } else if (status !== "all") {
          filtered = filtered.filter((t) => t.status === status);
        }
        if (assignee) {
          filtered = filtered.filter((t) => t.assignee === assignee);
        }
        if (titleFilter) {
          const q = titleFilter.toLowerCase();
          filtered = filtered.filter((t) => t.title.toLowerCase().includes(q));
        }
        return new Response(JSON.stringify(filtered), { headers: corsHeaders });
      }

      // GET /tasks/:id — detail
      if (req.method === "GET" && taskId && !action) {
        const task = AgentManager.getTasks().find((t) => t.id === taskId);
        if (!task)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks — create
      if (req.method === "POST" && !taskId) {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        if (
          typeof body.title !== "string" ||
          typeof body.createdBy !== "string"
        ) {
          return new Response(
            JSON.stringify({ error: "title and createdBy required" }),
            { status: 400, headers: corsHeaders },
          );
        }
        if (body.priority !== undefined && !isValidPriority(body.priority)) {
          return new Response(
            JSON.stringify({ error: "invalid priority, must be P0-P3" }),
            { status: 400, headers: corsHeaders },
          );
        }
        const task = AgentManager.addTask(body.title, body.createdBy, {
          description:
            typeof body.description === "string" ? body.description : undefined,
          priority: body.priority,
          assignee:
            typeof body.assignee === "string" ? body.assignee : undefined,
          username:
            typeof body.username === "string" ? body.username : undefined,
        });
        return new Response(JSON.stringify(task), {
          status: 201,
          headers: corsHeaders,
        });
      }

      // PATCH /tasks/:id — update
      if (req.method === "PATCH" && taskId && !action) {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        if (body.status !== undefined && !isValidStatus(body.status)) {
          return new Response(
            JSON.stringify({
              error: "invalid status, must be open|in_progress|backlog|done",
            }),
            { status: 400, headers: corsHeaders },
          );
        }
        if (body.priority !== undefined && !isValidPriority(body.priority)) {
          return new Response(
            JSON.stringify({ error: "invalid priority, must be P0-P3" }),
            { status: 400, headers: corsHeaders },
          );
        }
        const changes: Partial<
          Pick<
            TaskItem,
            "title" | "description" | "priority" | "status" | "assignee"
          >
        > = {};
        if (typeof body.title === "string") changes.title = body.title;
        if (body.description !== undefined)
          changes.description =
            typeof body.description === "string" ? body.description : undefined;
        if (body.status !== undefined) changes.status = body.status;
        if (body.priority !== undefined)
          changes.priority = body.priority ? body.priority : undefined;
        if (body.assignee !== undefined)
          changes.assignee =
            typeof body.assignee === "string" ? body.assignee : undefined;
        const task = AgentManager.updateTask(taskId, changes);
        if (!task)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks/:id/claim
      if (req.method === "POST" && taskId && action === "claim") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const changes: Partial<Pick<TaskItem, "status" | "assignee">> = {
          status: "in_progress",
        };
        if (typeof body.assignee === "string") changes.assignee = body.assignee;
        const task = AgentManager.updateTask(taskId, changes);
        if (!task)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks/:id/done
      if (req.method === "POST" && taskId && action === "done") {
        // Agents send `curl -d '{}'` — consume the body so Bun doesn't warn
        try {
          await req.json();
        } catch {}
        const task = AgentManager.updateTask(taskId, { status: "done" });
        if (!task)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    // GET /backup/status — last-run timestamp, ok/error, retention, dest dir.
    if (url.pathname === "/backup/status" && req.method === "GET") {
      return new Response(JSON.stringify(getBackupStatus()), {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
      });
    }

    // POST /agents/:id/diff — emit a styled diff card into the agent's chat,
    // matching the /isomux-diff slash command. Lets an agent surface a diff
    // when the boss asks "show me your changes". Optional body: { dir }.
    if (url.pathname.startsWith("/agents/") && req.method === "POST") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 3 && parts[2] === "diff") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const agentId = parts[1];
        let dir: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.dir === "string") dir = body.dir;
        } catch {}
        const result = AgentManager.emitAgentDiff(agentId, dir);
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /agents/:id/edit-file — emit an `edit-request` card so the boss
      // can open the file in the editor side panel. Mirrors /diff. Body: { path }.
      if (parts.length === 3 && parts[2] === "edit-file") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const agentId = parts[1];
        let path: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.path === "string") path = body.path;
        } catch {}
        if (!path) {
          return new Response(JSON.stringify({ error: "missing path" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const result = AgentManager.emitAgentEditRequest(agentId, path);
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /agents/:id/read-file — copy a file into the agent's files dir
      // and emit a `file-view` card so the boss sees the file (images render
      // inline, others render as a clickable file chip). Replaces the older
      // "Read tool on an image → SDK extracts bytes" convention; works for
      // both Claude and Codex agents. Body: { path }.
      if (parts.length === 3 && parts[2] === "read-file") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const agentId = parts[1];
        let path: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.path === "string") path = body.path;
        } catch {}
        if (!path) {
          return new Response(JSON.stringify({ error: "missing path" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const result = AgentManager.emitAgentReadFile(agentId, path);
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /agents/:id/terminal-command — emit a `terminal-command` card so
      // the boss can prefill the terminal panel with this command. Mirrors
      // /edit-file. Body: { command }. Single-line; not auto-executed.
      if (parts.length === 3 && parts[2] === "terminal-command") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const agentId = parts[1];
        let command: string | undefined;
        try {
          const body = (await req.json()) as Record<string, unknown> | null;
          if (body && typeof body.command === "string") command = body.command;
        } catch {}
        if (!command) {
          return new Response(JSON.stringify({ error: "missing command" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const result = AgentManager.emitAgentTerminalCommand(agentId, command);
        if (!result.ok)
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: corsHeaders,
        });
      }
      // POST /agents/:id/message — queue a message into the receiving agent's
      // chat. The sender's identity (name + room) is looked up server-side
      // from senderAgentId so callers can't spoof identity or inject
      // prefix-delimiter characters into the prompt the receiver sees.
      // Body: { text, senderAgentId, clientMessageId? }
      if (parts.length === 3 && parts[2] === "message") {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const receiverId = parts[1];
        let body: Record<string, unknown> | null = null;
        try {
          body = (await req.json()) as Record<string, unknown> | null;
        } catch {}
        if (!body) {
          return new Response(JSON.stringify({ error: "invalid JSON body" }), {
            status: 400,
            headers: corsHeaders,
          });
        }
        const text = typeof body.text === "string" ? body.text : null;
        const senderAgentId =
          typeof body.senderAgentId === "string" ? body.senderAgentId : null;
        const clientMessageId =
          typeof body.clientMessageId === "string"
            ? body.clientMessageId
            : undefined;
        if (!text || !senderAgentId) {
          return new Response(
            JSON.stringify({ error: "required: text, senderAgentId" }),
            { status: 400, headers: corsHeaders },
          );
        }
        if (senderAgentId === receiverId) {
          return new Response(
            JSON.stringify({ error: "cannot send to self" }),
            { status: 400, headers: corsHeaders },
          );
        }
        const senderInfo = AgentManager.getAgentDisplay(senderAgentId);
        if (!senderInfo) {
          return new Response(
            JSON.stringify({ error: "senderAgentId is not a known agent" }),
            { status: 400, headers: corsHeaders },
          );
        }
        const result = AgentManager.enqueueMessage(receiverId, {
          sender: {
            kind: "agent",
            agentId: senderAgentId,
            agentName: senderInfo.name,
            roomName: senderInfo.roomName,
          },
          text,
          clientMessageId,
        });
        if (!result.ok) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: result.status,
            headers: corsHeaders,
          });
        }
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }
    }

    // File upload endpoint: POST /api/upload/{agentId}
    if (url.pathname.startsWith("/api/upload/") && req.method === "POST") {
      const agentId = url.pathname.split("/")[3];
      if (!agentId || !AgentManager.getAgent(agentId)) {
        return new Response(JSON.stringify({ error: "agent not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const formData = await req.formData();
        const attachments: Attachment[] = [];
        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
        const MAX_FILES = 5;
        const MAX_TOTAL = 40 * 1024 * 1024; // 40MB
        let totalSize = 0;
        let fileCount = 0;

        for (const [, value] of formData) {
          if (!(value instanceof File)) continue;
          fileCount++;
          if (fileCount > MAX_FILES) {
            return new Response(
              JSON.stringify({
                error: `Maximum ${MAX_FILES} files per upload`,
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          if (value.size > MAX_FILE_SIZE) {
            return new Response(
              JSON.stringify({
                error: `File "${value.name}" exceeds 20MB limit`,
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          totalSize += value.size;
          if (totalSize > MAX_TOTAL) {
            return new Response(
              JSON.stringify({ error: "Total upload exceeds 40MB limit" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          const buffer = Buffer.from(await value.arrayBuffer());
          const att = saveFile(
            agentId,
            buffer,
            value.type || "application/octet-stream",
            value.name,
          );
          if (att) attachments.push(att);
        }
        return new Response(JSON.stringify({ attachments }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: errMessage(err, "Upload failed") }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // File serving endpoint (also handles legacy /api/images/ URLs)
    if (
      url.pathname.startsWith("/api/files/") ||
      url.pathname.startsWith("/api/images/")
    ) {
      const parts = url.pathname.split("/").filter(Boolean); // ["api", "files"|"images", agentId, filename]
      const agentId = parts[2];
      const filename = parts[3];
      if (!agentId || !filename) {
        return new Response("Not found", { status: 404 });
      }
      const filePath = getFilePath(agentId, filename);
      if (!filePath) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(Bun.file(filePath), {
        headers: {
          "Content-Type": mimeTypeForFilename(filename),
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    // Static file serving
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(UI_DIST, filePath));
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Cache-Control": "no-cache" },
      });
    }
    // SPA fallback
    return new Response(Bun.file(join(UI_DIST, "index.html")), {
      headers: { "Cache-Control": "no-cache" },
    });
  },
  websocket: {
    open(ws) {
      browsers.add(ws);
      // Send users (boss profiles) FIRST so the full_state reducer can apply
      // the current user's defaultRoomId from server-stored prefs.
      ws.send(
        JSON.stringify({
          type: "users_list",
          users: listUsers(),
        }),
      );
      // Send current agent list
      const agents = AgentManager.getAllAgents();
      const recentCwds = loadRecentCwds();
      ws.send(
        JSON.stringify({
          type: "full_state",
          agents,
          recentCwds,
          office: AgentManager.getOfficeSettings(),
          rooms: AgentManager.getRooms(),
        }),
      );
      // Send tasks
      ws.send(
        JSON.stringify({
          type: "tasks",
          tasks: AgentManager.getTasks(),
        }),
      );
      // Send cronjobs + cronjobsPrompt
      ws.send(
        JSON.stringify({
          type: "cronjobs_state",
          cronjobs: CronjobManager.listCronjobs(),
          cronjobsPrompt: CronjobManager.getCronjobsPrompt(),
        }),
      );
      // Send update status
      const update = getUpdateStatus();
      if (update.updateAvailable) {
        ws.send(
          JSON.stringify({
            type: "update_status",
            updateAvailable: true,
            current: update.current,
            latest: update.latest,
          }),
        );
      }
      // Send cached log history and slash commands for each agent
      for (const agent of agents) {
        const logs = AgentManager.getAgentLogs(agent.id);
        for (const entry of logs) {
          ws.send(JSON.stringify({ type: "log_entry", entry }));
        }
        const cmds = AgentManager.getAgentCommands(agent.id);
        if (cmds.commands.length > 0 || cmds.skills.length > 0) {
          ws.send(
            JSON.stringify({
              type: "slash_commands",
              agentId: agent.id,
              commands: cmds.commands,
              skills: cmds.skills,
            }),
          );
        }
      }
    },
    message(ws, data) {
      try {
        const cmd = JSON.parse(data as string) as ClientCommand;
        void handleCommand(cmd, ws);
      } catch (e) {
        console.error("Invalid command:", e);
      }
    },
    close(ws) {
      browsers.delete(ws);
      // Drop any per-WS editor watchers on disconnect.
      const map = editorWatchers.get(ws);
      if (map) {
        for (const w of map.values()) stopWatch(w);
        editorWatchers.delete(ws);
      }
    },
  },
});

// Start update checker
onUpdateChange((status) => {
  broadcast({
    type: "update_status",
    updateAvailable: status.updateAvailable,
    current: status.current,
    latest: status.latest,
  });
});
startUpdateChecker();

// Restore persisted agents on startup
void AgentManager.restoreAgents().then((restored) => {
  if (restored.length > 0) {
    console.log(
      `Restored ${restored.length} agent(s): ${restored.map((a) => a.name).join(", ")}`,
    );
  }
});

// Boot cronjob scheduler (loads configs, reconciles stale "running" rows, starts tick).
CronjobManager.startCronjobScheduler();

// Daily ~/.isomux/ backup tarball with N=7 retention. See server/backup.ts.
startBackupScheduler();

// Codex CLI version check. Logs ok/mismatch/not-installed to the server log.
// Doesn't block startup — Claude agents are independent. Codex agent spawn
// (step 8) will refuse if this check failed.
void logCodexVersionAtBoot();

console.log(`Isomux running at http://localhost:${server.port}`);
