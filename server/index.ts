import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientCommand } from "../shared/types.ts";
import * as AgentManager from "./agent-manager.ts";
import { join } from "path";

const browsers = new Set<ServerWebSocket<unknown>>();

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
      await AgentManager.spawn(cmd.name, cmd.cwd, cmd.permissionMode);
      break;
    case "kill":
      await AgentManager.kill(cmd.agentId);
      break;
    case "send_message":
      // Don't await — let it stream in the background
      AgentManager.sendMessage(cmd.agentId, cmd.text);
      break;
    case "new_conversation":
      await AgentManager.newConversation(cmd.agentId);
      break;
    case "resume":
      await AgentManager.resume(cmd.agentId, cmd.sessionId);
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
      // Send current agent list
      const agents = AgentManager.getAllAgents();
      ws.send(JSON.stringify({ type: "full_state", agents } as ServerMessage));
      // Send cached log history for each agent
      for (const agent of agents) {
        const logs = AgentManager.getAgentLogs(agent.id);
        for (const entry of logs) {
          ws.send(JSON.stringify({ type: "log_entry", entry } as ServerMessage));
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
