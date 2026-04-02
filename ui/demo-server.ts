import { OfficeState, type OfficeEvent } from "../shared/office-state.ts";
import type { ClientCommand, ServerMessage, LogEntry } from "../shared/types.ts";
import { shimEmit } from "./ws.ts";

const state = new OfficeState();

const DEMO_REPLY =
  "This is a demo. Your message was not actually sent to Claude. To use Isomux for real, follow the setup instructions at isomux.com.";

// Track pending reply timeouts per agent to avoid flickering on rapid sends
const pendingReplies = new Map<string, ReturnType<typeof setTimeout>>();

function emitEvents(events: OfficeEvent[]) {
  for (const event of events) {
    switch (event.type) {
      case "agent_added":
        shimEmit({ type: "agent_added", agent: event.agent });
        // Send empty slash_commands so autocomplete initializes
        shimEmit({ type: "slash_commands", agentId: event.agent.id, commands: [], skills: [] });
        break;
      case "agent_removed":
        shimEmit({ type: "agent_removed", agentId: event.agentId });
        break;
      case "agent_updated":
        shimEmit({ type: "agent_updated", agentId: event.agentId, changes: event.changes });
        break;
      case "room_created":
        shimEmit({ type: "room_created", roomCount: event.roomCount });
        break;
      case "room_closed":
        shimEmit({ type: "room_closed", room: event.room, roomCount: event.roomCount });
        break;
      case "office_prompt_set":
        shimEmit({ type: "office_prompt", text: event.value });
        break;
      case "todos_changed":
        shimEmit({ type: "todos", todos: event.todos });
        break;
    }
  }
}

function makeLogEntry(agentId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>): LogEntry {
  return {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentId,
    timestamp: Date.now(),
    kind,
    content,
    metadata,
  };
}

export function handleCommand(cmd: ClientCommand) {
  switch (cmd.type) {
    case "spawn": {
      const result = state.spawn({
        name: cmd.name,
        cwd: cmd.cwd,
        permissionMode: cmd.permissionMode,
        desk: cmd.desk,
        room: cmd.room,
        customInstructions: cmd.customInstructions,
      });
      if (result) {
        emitEvents(result.events);
        // System message
        const entry = makeLogEntry(result.agent.id, "system", `Agent "${cmd.name}" ready. Working in ${cmd.cwd}. (Demo mode)`);
        shimEmit({ type: "log_entry", entry });
      }
      break;
    }
    case "kill": {
      emitEvents(state.kill(cmd.agentId));
      break;
    }
    case "edit_agent": {
      emitEvents(state.editAgent(cmd.agentId, {
        name: cmd.name,
        cwd: cmd.cwd,
        outfit: cmd.outfit,
        customInstructions: cmd.customInstructions,
      }));
      break;
    }
    case "swap_desks": {
      emitEvents(state.swapDesks(cmd.deskA, cmd.deskB, cmd.room));
      break;
    }
    case "create_room": {
      emitEvents(state.createRoom());
      break;
    }
    case "close_room": {
      emitEvents(state.closeRoom(cmd.room));
      break;
    }
    case "move_agent": {
      emitEvents(state.moveAgent(cmd.agentId, cmd.targetRoom));
      break;
    }
    case "set_topic": {
      emitEvents(state.setTopic(cmd.agentId, cmd.topic));
      break;
    }
    case "reset_topic": {
      emitEvents(state.resetTopic(cmd.agentId));
      break;
    }
    case "set_office_prompt": {
      emitEvents(state.setOfficePrompt(cmd.text));
      break;
    }
    case "add_todo": {
      emitEvents(state.addTodo(cmd.text, cmd.username));
      break;
    }
    case "delete_todo": {
      emitEvents(state.deleteTodo(cmd.id));
      break;
    }
    case "send_message": {
      // Log the user message
      const userEntry = makeLogEntry(cmd.agentId, "user_message", cmd.text, cmd.username ? { username: cmd.username } : undefined);
      shimEmit({ type: "log_entry", entry: userEntry });
      // Cancel any pending reply for this agent (prevents flickering on rapid sends)
      const prev = pendingReplies.get(cmd.agentId);
      if (prev) clearTimeout(prev);
      // Briefly show "thinking" state, then reply
      shimEmit({ type: "agent_updated", agentId: cmd.agentId, changes: { state: "thinking" } });
      pendingReplies.set(cmd.agentId, setTimeout(() => {
        pendingReplies.delete(cmd.agentId);
        const replyEntry = makeLogEntry(cmd.agentId, "text", DEMO_REPLY);
        shimEmit({ type: "log_entry", entry: replyEntry });
        shimEmit({ type: "agent_updated", agentId: cmd.agentId, changes: { state: "idle" } });
      }, 800));
      break;
    }
    // Silent no-ops
    case "abort":
    case "terminal_open":
    case "terminal_input":
    case "terminal_resize":
    case "terminal_close":
    case "new_conversation":
    case "resume":
    case "list_sessions":
      break;
  }
}

export function sendInitialState() {
  const s = state.getState();
  shimEmit({ type: "full_state", agents: s.agents, recentCwds: s.recentCwds, roomCount: s.roomCount });
  shimEmit({ type: "office_prompt", text: s.officePrompt });
  shimEmit({ type: "todos", todos: s.todos });
}
