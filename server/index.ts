import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientCommand } from "../shared/types.ts";
import * as AgentManager from "./agent-manager.ts";
import { loadRecentCwds, saveRecentCwd, loadTasks, saveTasks, getFilePath, saveFile } from "./persistence.ts";
import type { Attachment } from "../shared/types.ts";
import { startUpdateChecker, getUpdateStatus, onUpdateChange } from "./update-checker.ts";
import type { TaskItem } from "../shared/types.ts";
import { generateTaskId, isValidStatus, isValidPriority } from "../shared/types.ts";
import { join } from "path";

const browsers = new Set<ServerWebSocket<unknown>>();
let tasks: TaskItem[] = loadTasks();

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    ws.send(data);
  }
}

// Wire AgentManager events to WebSocket broadcasts
AgentManager.onEvent((event) => {
  broadcast(event as ServerMessage);
});

async function handleCommand(cmd: ClientCommand, ws: ServerWebSocket<unknown>) {
  switch (cmd.type) {
    case "spawn":
      saveRecentCwd(cmd.cwd);
      await AgentManager.spawn(cmd.name, cmd.cwd, cmd.permissionMode, cmd.desk, cmd.customInstructions, cmd.roomId, cmd.outfit, cmd.modelFamily);
      break;
    case "kill":
      await AgentManager.kill(cmd.agentId);
      break;
    case "abort":
      await AgentManager.abort(cmd.agentId);
      break;
    case "send_message":
      // Don't await — let it stream in the background
      AgentManager.sendMessage(cmd.agentId, cmd.text, cmd.username, cmd.attachments);
      break;
    case "new_conversation":
      await AgentManager.newConversation(cmd.agentId);
      break;
    case "resume":
      await AgentManager.resume(cmd.agentId, cmd.sessionId);
      break;
    case "edit_agent":
      if (cmd.cwd) saveRecentCwd(cmd.cwd);
      AgentManager.editAgent(cmd.agentId, { name: cmd.name, cwd: cmd.cwd, outfit: cmd.outfit, customInstructions: cmd.customInstructions, modelFamily: cmd.modelFamily });
      break;
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
      } as ServerMessage);
      break;
    }
    case "terminal_open": {
      const opened = AgentManager.openTerminal(cmd.agentId);
      if (opened) {
        // Replay buffered output so the browser catches up
        const buffer = AgentManager.getTerminalBuffer(cmd.agentId);
        if (buffer) {
          broadcast({ type: "terminal_output", agentId: cmd.agentId, data: buffer } as ServerMessage);
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
    case "update_office_settings": {
      const envFile = cmd.envFile && cmd.envFile.trim() ? cmd.envFile.trim() : null;
      let keyCount: number | undefined;
      if (envFile) {
        try {
          keyCount = AgentManager.validateEnvPath(envFile);
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "settings_save_response", requestId: cmd.requestId, ok: false, error: err.message || "Invalid env file" } as ServerMessage));
          break;
        }
      }
      AgentManager.setOfficeSettings(cmd.prompt, envFile);
      ws.send(JSON.stringify({ type: "settings_save_response", requestId: cmd.requestId, ok: true, keyCount } as ServerMessage));
      break;
    }
    case "update_room_settings": {
      const envFile = cmd.envFile && cmd.envFile.trim() ? cmd.envFile.trim() : null;
      let keyCount: number | undefined;
      if (envFile) {
        try {
          keyCount = AgentManager.validateEnvPath(envFile);
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "settings_save_response", requestId: cmd.requestId, ok: false, error: err.message || "Invalid env file" } as ServerMessage));
          break;
        }
      }
      const ok = AgentManager.setRoomSettings(cmd.roomId, cmd.prompt, envFile);
      if (!ok) {
        ws.send(JSON.stringify({ type: "settings_save_response", requestId: cmd.requestId, ok: false, error: "Room not found" } as ServerMessage));
      } else {
        ws.send(JSON.stringify({ type: "settings_save_response", requestId: cmd.requestId, ok: true, keyCount } as ServerMessage));
      }
      break;
    }
    case "request_settings_validation": {
      let envFile: string | null = null;
      if (cmd.scope === "office") {
        envFile = AgentManager.getOfficeSettings().envFile;
      } else if (cmd.scope === "room" && cmd.roomId) {
        const room = AgentManager.getRooms().find((r) => r.id === cmd.roomId);
        envFile = room?.envFile ?? null;
      }
      if (!envFile) {
        ws.send(JSON.stringify({ type: "settings_validation", requestId: cmd.requestId, scope: cmd.scope, roomId: cmd.roomId, envFile: null, ok: true } as ServerMessage));
        break;
      }
      try {
        const keyCount = AgentManager.validateEnvPath(envFile);
        ws.send(JSON.stringify({ type: "settings_validation", requestId: cmd.requestId, scope: cmd.scope, roomId: cmd.roomId, envFile, ok: true, keyCount } as ServerMessage));
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "settings_validation", requestId: cmd.requestId, scope: cmd.scope, roomId: cmd.roomId, envFile, ok: false, error: err.message || "Invalid env file" } as ServerMessage));
      }
      break;
    }
    case "add_task": {
      const task: TaskItem = {
        id: generateTaskId(tasks.map(t => t.id)),
        title: cmd.title.trim(),
        description: cmd.description,
        priority: cmd.priority && isValidPriority(cmd.priority) ? cmd.priority : undefined,
        status: "open",
        assignee: cmd.assignee,
        createdBy: cmd.username,
        createdAt: Date.now(),
      };
      tasks.push(task);
      saveTasks(tasks);
      broadcast({ type: "tasks", tasks } as ServerMessage);
      break;
    }
    case "update_task": {
      const task = tasks.find((t) => t.id === cmd.id);
      if (task) {
        const c = cmd.changes;
        if (c.title !== undefined) task.title = String(c.title);
        if (c.description !== undefined) task.description = c.description ? String(c.description) : undefined;
        if (c.assignee !== undefined) task.assignee = c.assignee ? String(c.assignee) : undefined;
        if (c.status !== undefined && isValidStatus(c.status)) task.status = c.status;
        if (c.priority !== undefined && isValidPriority(c.priority)) task.priority = c.priority;
        saveTasks(tasks);
        broadcast({ type: "tasks", tasks } as ServerMessage);
      }
      break;
    }
    case "delete_task": {
      tasks = tasks.filter((t) => t.id !== cmd.id);
      saveTasks(tasks);
      broadcast({ type: "tasks", tasks } as ServerMessage);
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
      AgentManager.editMessage(cmd.agentId, cmd.logEntryId, cmd.newText, cmd.username);
      break;
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

    // Task HTTP API
    if (url.pathname.startsWith("/tasks")) {
      const corsHeaders = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
      const parts = url.pathname.split("/").filter(Boolean); // ["tasks"] or ["tasks", id] or ["tasks", id, action]
      const taskId = parts[1];
      const action = parts[2]; // "claim" or "done"

      // DELETE blocked at HTTP level
      if (req.method === "DELETE") {
        return new Response(JSON.stringify({ error: "DELETE not allowed via HTTP" }), { status: 405, headers: corsHeaders });
      }

      // GET /tasks — list (excludes done by default)
      if (req.method === "GET" && !taskId) {
        const status = url.searchParams.get("status");
        const assignee = url.searchParams.get("assignee");
        const titleFilter = url.searchParams.get("title");
        let filtered = tasks;
        if (!status) {
          filtered = filtered.filter((t) => t.status !== "done");
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
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: corsHeaders });
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks — create
      if (req.method === "POST" && !taskId) {
        let body: Record<string, unknown>;
        try { body = await req.json() as Record<string, unknown>; } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: corsHeaders });
        }
        if (!body.title || !body.createdBy) {
          return new Response(JSON.stringify({ error: "title and createdBy required" }), { status: 400, headers: corsHeaders });
        }
        if (body.priority !== undefined && !isValidPriority(body.priority)) {
          return new Response(JSON.stringify({ error: "invalid priority, must be P0-P3" }), { status: 400, headers: corsHeaders });
        }
        const task: TaskItem = {
          id: generateTaskId(tasks.map(t => t.id)),
          title: String(body.title).trim(),
          description: body.description ? String(body.description) : undefined,
          priority: body.priority as TaskItem["priority"],
          status: "open",
          assignee: body.assignee ? String(body.assignee) : undefined,
          createdBy: String(body.createdBy),
          createdAt: Date.now(),
        };
        tasks.push(task);
        saveTasks(tasks);
        broadcast({ type: "tasks", tasks } as ServerMessage);
        return new Response(JSON.stringify(task), { status: 201, headers: corsHeaders });
      }

      // PATCH /tasks/:id — update
      if (req.method === "PATCH" && taskId && !action) {
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: corsHeaders });
        let body: Record<string, unknown>;
        try { body = await req.json() as Record<string, unknown>; } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: corsHeaders });
        }
        if (body.status !== undefined && !isValidStatus(body.status)) {
          return new Response(JSON.stringify({ error: "invalid status, must be open|in_progress|done" }), { status: 400, headers: corsHeaders });
        }
        if (body.priority !== undefined && !isValidPriority(body.priority)) {
          return new Response(JSON.stringify({ error: "invalid priority, must be P0-P3" }), { status: 400, headers: corsHeaders });
        }
        if (body.title !== undefined) task.title = String(body.title);
        if (body.description !== undefined) task.description = body.description ? String(body.description) : undefined;
        if (body.status !== undefined) task.status = body.status as TaskItem["status"];
        if (body.priority !== undefined) task.priority = body.priority ? body.priority as TaskItem["priority"] : undefined;
        if (body.assignee !== undefined) task.assignee = body.assignee ? String(body.assignee) : undefined;
        saveTasks(tasks);
        broadcast({ type: "tasks", tasks } as ServerMessage);
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks/:id/claim
      if (req.method === "POST" && taskId && action === "claim") {
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: corsHeaders });
        let body: Record<string, unknown>;
        try { body = await req.json() as Record<string, unknown>; } catch {
          return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: corsHeaders });
        }
        task.assignee = body.assignee ? String(body.assignee) : task.assignee;
        task.status = "in_progress";
        saveTasks(tasks);
        broadcast({ type: "tasks", tasks } as ServerMessage);
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      // POST /tasks/:id/done
      if (req.method === "POST" && taskId && action === "done") {
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: corsHeaders });
        // Agents send `curl -d '{}'` — consume the body so Bun doesn't warn
        try { await req.json(); } catch {}
        task.status = "done";
        saveTasks(tasks);
        broadcast({ type: "tasks", tasks } as ServerMessage);
        return new Response(JSON.stringify(task), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: corsHeaders });
    }

    // File upload endpoint: POST /api/upload/{agentId}
    if (url.pathname.startsWith("/api/upload/") && req.method === "POST") {
      const agentId = url.pathname.split("/")[3];
      if (!agentId || !AgentManager.getAgent(agentId)) {
        return new Response(JSON.stringify({ error: "agent not found" }), {
          status: 404, headers: { "Content-Type": "application/json" },
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
            return new Response(JSON.stringify({ error: `Maximum ${MAX_FILES} files per upload` }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          if (value.size > MAX_FILE_SIZE) {
            return new Response(JSON.stringify({ error: `File "${value.name}" exceeds 20MB limit` }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          totalSize += value.size;
          if (totalSize > MAX_TOTAL) {
            return new Response(JSON.stringify({ error: "Total upload exceeds 40MB limit" }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          const buffer = Buffer.from(await value.arrayBuffer());
          const att = saveFile(agentId, buffer, value.type || "application/octet-stream", value.name);
          if (att) attachments.push(att);
        }
        return new Response(JSON.stringify({ attachments }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || "Upload failed" }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // File serving endpoint (also handles legacy /api/images/ URLs)
    if (url.pathname.startsWith("/api/files/") || url.pathname.startsWith("/api/images/")) {
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
      const ext = filename.split(".").pop();
      const mimeTypes: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
        pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
        json: "application/json", csv: "text/csv", xml: "text/xml",
        html: "text/html", css: "text/css",
      };
      return new Response(Bun.file(filePath), {
        headers: {
          "Content-Type": mimeTypes[ext!] || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    // Static file serving
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
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
      // Send current agent list
      const agents = AgentManager.getAllAgents();
      const recentCwds = loadRecentCwds();
      ws.send(JSON.stringify({ type: "full_state", agents, recentCwds, office: AgentManager.getOfficeSettings(), rooms: AgentManager.getRooms() } as ServerMessage));
      // Send tasks
      ws.send(JSON.stringify({ type: "tasks", tasks } as ServerMessage));
      // Send update status
      const update = getUpdateStatus();
      if (update.updateAvailable) {
        ws.send(JSON.stringify({ type: "update_status", updateAvailable: true, current: update.current, latest: update.latest } as ServerMessage));
      }
      // Send cached log history and slash commands for each agent
      for (const agent of agents) {
        const logs = AgentManager.getAgentLogs(agent.id);
        for (const entry of logs) {
          ws.send(JSON.stringify({ type: "log_entry", entry } as ServerMessage));
        }
        const cmds = AgentManager.getAgentCommands(agent.id);
        if (cmds.commands.length > 0 || cmds.skills.length > 0) {
          ws.send(JSON.stringify({
            type: "slash_commands",
            agentId: agent.id,
            commands: cmds.commands,
            skills: cmds.skills,
          } as ServerMessage));
        }
      }
    },
    message(ws, data) {
      try {
        const cmd = JSON.parse(data as string) as ClientCommand;
        handleCommand(cmd, ws);
      } catch (e) {
        console.error("Invalid command:", e);
      }
    },
    close(ws) {
      browsers.delete(ws);
    },
  },
});

// Start update checker
onUpdateChange((status) => {
  broadcast({ type: "update_status", updateAvailable: status.updateAvailable, current: status.current, latest: status.latest } as ServerMessage);
});
startUpdateChecker();

// Restore persisted agents on startup
AgentManager.restoreAgents().then((restored) => {
  if (restored.length > 0) {
    console.log(`Restored ${restored.length} agent(s): ${restored.map((a) => a.name).join(", ")}`);
  }
});

console.log(`Isomux running at http://localhost:${server.port}`);
