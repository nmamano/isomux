import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientCommand } from "../shared/types.ts";
import * as AgentManager from "./agent-manager.ts";
import { loadRecentCwds, saveRecentCwd, loadTodos, saveTodos } from "./persistence.ts";
import type { TodoItem } from "../shared/types.ts";
import { join } from "path";
import { execSync } from "child_process";

const browsers = new Set<ServerWebSocket<unknown>>();
let todos: TodoItem[] = loadTodos();

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

async function handleCommand(cmd: ClientCommand) {
  switch (cmd.type) {
    case "spawn":
      saveRecentCwd(cmd.cwd);
      await AgentManager.spawn(cmd.name, cmd.cwd, cmd.permissionMode, cmd.desk, cmd.customInstructions);
      break;
    case "kill":
      await AgentManager.kill(cmd.agentId);
      break;
    case "abort":
      await AgentManager.abort(cmd.agentId);
      break;
    case "send_message":
      // Don't await — let it stream in the background
      AgentManager.sendMessage(cmd.agentId, cmd.text, cmd.username);
      break;
    case "new_conversation":
      await AgentManager.newConversation(cmd.agentId);
      break;
    case "resume":
      await AgentManager.resume(cmd.agentId, cmd.sessionId);
      break;
    case "edit_agent":
      if (cmd.cwd) saveRecentCwd(cmd.cwd);
      AgentManager.editAgent(cmd.agentId, { name: cmd.name, cwd: cmd.cwd, outfit: cmd.outfit, customInstructions: cmd.customInstructions });
      break;
    case "swap_desks":
      AgentManager.swapDesks(cmd.deskA, cmd.deskB);
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
    case "set_office_prompt":
      AgentManager.setOfficePrompt(cmd.text);
      broadcast({ type: "office_prompt", text: cmd.text.trim() } as ServerMessage);
      break;
    case "add_todo": {
      const todo: TodoItem = {
        id: crypto.randomUUID(),
        text: cmd.text.trim(),
        createdBy: cmd.username,
        createdAt: Date.now(),
      };
      todos.push(todo);
      saveTodos(todos);
      broadcast({ type: "todos", todos } as ServerMessage);
      break;
    }
    case "delete_todo": {
      todos = todos.filter((t) => t.id !== cmd.id);
      saveTodos(todos);
      broadcast({ type: "todos", todos } as ServerMessage);
      break;
    }
  }
}

// Resolve UI dist path
const UI_DIST = join(import.meta.dir, "..", "ui", "dist");

const PORT = parseInt(process.env.PORT || "4000");

// Detect Tailscale FQDN for HTTPS redirect (via `tailscale serve`)
let tailscaleHttpsUrl: string | null = null;
let tailscaleFqdn: string | null = null;
try {
  const tsStatus = JSON.parse(execSync("tailscale status --json", { timeout: 3000 }).toString());
  const fqdn = tsStatus?.Self?.DNSName?.replace(/\.$/, "");
  if (fqdn) {
    // Check if `tailscale serve` is configured for HTTPS
    const serveStatus = execSync("tailscale serve status --json", { timeout: 3000 }).toString();
    const serveConfig = JSON.parse(serveStatus);
    if (serveConfig?.TCP?.["443"]) {
      tailscaleFqdn = fqdn;
      tailscaleHttpsUrl = `https://${fqdn}`;
      console.log(`Tailscale HTTPS redirect enabled → ${tailscaleHttpsUrl}`);
    }
  }
} catch {
  // Tailscale not available or not configured — no redirect
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Redirect to Tailscale HTTPS for direct browser requests (not proxied ones)
    if (tailscaleHttpsUrl && url.pathname !== "/ws") {
      const host = req.headers.get("host") || "";
      // Tailscale proxy sets Host to the FQDN; direct requests use the raw hostname:port
      if (!host.includes(tailscaleFqdn!)) {
        return Response.redirect(`${tailscaleHttpsUrl}${url.pathname}${url.search}`, 302);
      }
    }

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
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
      ws.send(JSON.stringify({ type: "full_state", agents, recentCwds } as ServerMessage));
      // Send office prompt
      ws.send(JSON.stringify({ type: "office_prompt", text: AgentManager.getOfficePrompt() } as ServerMessage));
      // Send todos
      ws.send(JSON.stringify({ type: "todos", todos } as ServerMessage));
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
        handleCommand(cmd);
      } catch (e) {
        console.error("Invalid command:", e);
      }
    },
    close(ws) {
      browsers.delete(ws);
    },
  },
});

// Restore persisted agents on startup
AgentManager.restoreAgents().then((restored) => {
  if (restored.length > 0) {
    console.log(`Restored ${restored.length} agent(s): ${restored.map((a) => a.name).join(", ")}`);
  }
});

console.log(`Isomux running at http://localhost:${server.port}`);
