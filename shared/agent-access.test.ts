// The access slider's pure rules (task e77304b1): the order of the stops, how
// an agent saved before the slider reads, which bodies agents.setAccess
// takes, and the exact Claude built-in tools at each stop below Standard.

import { describe, expect, it } from "bun:test";
import {
  AGENT_ACCESS_STOPS,
  agentAccessOf,
  belowStandard,
  claudeToolsForStop,
  parseAgentAccessGrant,
  parseAgentPack,
  type AgentAccess,
} from "./agent-access.ts";

const ORDER: AgentAccess[] = [
  "chat",
  "office",
  "folder",
  "web",
  "standard",
  "privileged",
];

describe("agent access stops", () => {
  it("run from chat to privileged, and only the four lowest have no shell", () => {
    expect([...AGENT_ACCESS_STOPS]).toEqual(ORDER);
    expect(ORDER.filter((stop) => belowStandard(stop))).toEqual([
      "chat",
      "office",
      "folder",
      "web",
    ]);
  });

  it("an agent saved before the slider reads its stop from the privileged flag", () => {
    expect(agentAccessOf({})).toBe("standard");
    expect(agentAccessOf({ privileged: false })).toBe("standard");
    expect(agentAccessOf({ privileged: true })).toBe("privileged");
    // A record with a stop reads the stop.
    expect(agentAccessOf({ access: "folder", privileged: false })).toBe(
      "folder",
    );
    expect(agentAccessOf({ access: "chat" })).toBe("chat");
  });
});

describe("parseAgentPack", () => {
  it("takes token limits with areas, and refuses a pack without areas or with replies only", () => {
    expect(parseAgentPack({ areas: { tasks: "read" } })).toEqual({
      areas: { tasks: "read" },
    });
    expect(
      parseAgentPack({ areas: { asks: "write" }, rooms: ["room-1"] }),
    ).toEqual({ areas: { asks: "write" }, rooms: ["room-1"] });
    // No areas axis would be every area.
    expect(parseAgentPack({ rooms: ["room-1"] })).toBeNull();
    expect(parseAgentPack({})).toBeNull();
    // Replies only is an inbox rule: an agent has no token inbox.
    expect(
      parseAgentPack({ areas: { agents: "write" }, repliesOnly: true }),
    ).toBeNull();
    // What token limits refuse, a pack refuses too.
    expect(parseAgentPack({ areas: { nowhere: "read" } })).toBeNull();
    expect(parseAgentPack({ areas: { tasks: "admin" } })).toBeNull();
    expect(parseAgentPack(null)).toBeNull();
  });
});

describe("parseAgentAccessGrant", () => {
  const pack = { areas: { tasks: "read" } } as const;

  it("takes a pack exactly at office, folder and web", () => {
    for (const access of ["office", "folder", "web"] as const) {
      expect({
        access,
        grant: parseAgentAccessGrant({ access, pack }),
      }).toEqual({ access, grant: { access, pack } });
      expect({ access, grant: parseAgentAccessGrant({ access }) }).toEqual({
        access,
        grant: null,
      });
    }
    for (const access of ["chat", "standard", "privileged"] as const) {
      expect({ access, grant: parseAgentAccessGrant({ access }) }).toEqual({
        access,
        grant: { access },
      });
      expect({
        access,
        grant: parseAgentAccessGrant({ access, pack }),
      }).toEqual({ access, grant: null });
    }
  });

  it("refuses an unknown stop, a bad pack and extra keys", () => {
    for (const body of [
      { access: "admin" },
      { access: "Folder", pack },
      {
        access: "web",
        pack: { areas: { agents: "write" }, repliesOnly: true },
      },
      { access: "office", pack: { rooms: ["room-1"] } },
      { access: "standard", privileged: true },
      {},
      null,
      "standard",
    ]) {
      expect({ body, grant: parseAgentAccessGrant(body) }).toEqual({
        body,
        grant: null,
      });
    }
  });
});

describe("claudeToolsForStop", () => {
  it("is the exact built-in list at each stop below standard, and the engine default above", () => {
    const sorted = (stop: AgentAccess) => {
      const tools = claudeToolsForStop(stop);
      return tools === null ? null : [...tools].sort();
    };
    // Exact lists, never "everything except": a tool the SDK adds later stays
    // off. Office tools reach the office through mcpServers, not this list.
    expect(
      Object.fromEntries(ORDER.map((stop) => [stop, sorted(stop)])),
    ).toEqual({
      // The CLI has no TodoWrite (claude-access.live.test.ts): office has
      // no built-in tool, only the office MCP tools.
      chat: [],
      office: [],
      folder: ["Edit", "Glob", "Grep", "Read", "Write"],
      web: ["Edit", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "Write"],
      standard: null,
      privileged: null,
    });
  });
});
