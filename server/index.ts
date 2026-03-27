import type { ServerWebSocket } from "bun";
import type { AgentInfo, ServerMessage, ClientCommand } from "../shared/types.ts";
import { generateOutfit } from "./outfit.ts";
import { join } from "path";

// In-memory agent registry
const agents = new Map<string, AgentInfo>();
const browsers = new Set<ServerWebSocket<unknown>>();

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    ws.send(data);
  }
}

function findFreeDesk(): number | null {
  const taken = new Set([...agents.values()].map((a) => a.desk));
  for (let i = 0; i < 8; i++) {
    if (!taken.has(i)) return i;
  }
  return null;
}

function handleCommand(cmd: ClientCommand) {
  switch (cmd.type) {
    case "spawn": {
      const desk = findFreeDesk();
      if (desk === null) return;
      const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const agent: AgentInfo = {
        id,
        name: cmd.name,
        desk,
        cwd: cmd.cwd,
        outfit: generateOutfit(cmd.name),
        permissionMode: cmd.permissionMode,
        state: "idle",
      };
      agents.set(id, agent);
      broadcast({ type: "agent_added", agent });
      break;
    }
    case "kill": {
      if (agents.delete(cmd.agentId)) {
        broadcast({ type: "agent_removed", agentId: cmd.agentId });
      }
      break;
    }
    case "send_message": {
      // Phase 2: forward to SDK session
      // For now, just echo back as a log entry
      const agent = agents.get(cmd.agentId);
      if (!agent) return;
      broadcast({
        type: "log_entry",
        entry: {
          id: `log-${Date.now()}`,
          agentId: cmd.agentId,
          timestamp: Date.now(),
          kind: "user_message",
          content: cmd.text,
        },
      });
      // Mock: transition to working, then back to idle
      agents.set(cmd.agentId, { ...agent, state: "thinking" });
      broadcast({ type: "agent_updated", agentId: cmd.agentId, changes: { state: "thinking" } });
      setTimeout(() => {
        const a = agents.get(cmd.agentId);
        if (a) {
          agents.set(cmd.agentId, { ...a, state: "idle" });
          broadcast({ type: "agent_updated", agentId: cmd.agentId, changes: { state: "idle" } });
          broadcast({
            type: "log_entry",
            entry: {
              id: `log-${Date.now()}`,
              agentId: cmd.agentId,
              timestamp: Date.now(),
              kind: "text",
              content: `[Mock] I received your message: "${cmd.text}". SDK integration coming in phase 2.`,
            },
          });
        }
      }, 1500);
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

    // Static file serving
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(UI_DIST, filePath));
    if (await file.exists()) {
      return new Response(file);
    }
    // SPA fallback
    return new Response(Bun.file(join(UI_DIST, "index.html")));
  },
  websocket: {
    open(ws) {
      browsers.add(ws);
      const msg: ServerMessage = {
        type: "full_state",
        agents: [...agents.values()],
      };
      ws.send(JSON.stringify(msg));
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

console.log(`Isomux running at http://localhost:${server.port}`);
