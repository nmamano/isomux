// The access slider's pure rules (task e77304b1): the order of the stops, how
// an agent saved before the slider reads, which bodies agents.setAccess
// takes, and the exact Claude built-in tools at each stop below Standard.
// Task 82da687b: at office, folder and web the grant is one fixed set of
// areas; a body or record never chooses it.

import { describe, expect, it } from "bun:test";
import {
  AGENT_ACCESS_STOPS,
  accessGrantOf,
  agentAccessOf,
  belowStandard,
  claudeToolsForStop,
  engineRunsAccess,
  parseAgentAccessGrant,
  sameAccessGrant,
  type AgentAccess,
} from "./agent-access.ts";
import type { ApiTokenLimits } from "./api-token-limits.ts";

// A record as an older release saved it, with a pack: the record type has
// none since task 82da687b.
type SavedRecord = Parameters<typeof accessGrantOf>[0];
const saved = (record: object) => record as SavedRecord;

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

// The one grant of an agent at office, folder and web (task 82da687b).
const FIXED: ApiTokenLimits = {
  areas: { agents: "write", tasks: "write", asks: "write" },
};
const PACK_STOPS = ["office", "folder", "web"] as const;
const OTHER_STOPS = ["chat", "standard", "privileged"] as const;

describe("parseAgentAccessGrant", () => {
  it("gives the fixed grant at office, folder and web, and no pack at the other stops", () => {
    for (const access of PACK_STOPS)
      expect({ access, grant: parseAgentAccessGrant({ access }) }).toEqual({
        access,
        grant: { access, pack: FIXED },
      });
    for (const access of OTHER_STOPS)
      expect({ access, grant: parseAgentAccessGrant({ access }) }).toEqual({
        access,
        grant: { access },
      });
  });

  // A caller that asks for a pack must not get a wider grant than it asked
  // for without being told: a body with a pack is refused at every stop, the
  // fixed grant itself included.
  it("refuses a body with a pack at every stop", () => {
    const packs = [{ areas: { tasks: "read" } }, FIXED, {}, null];
    for (const access of [...PACK_STOPS, ...OTHER_STOPS])
      for (const pack of packs)
        expect({
          access,
          pack,
          grant: parseAgentAccessGrant({ access, pack }),
        }).toEqual({ access, pack, grant: null });
  });

  it("refuses an unknown stop and extra keys", () => {
    for (const body of [
      { access: "admin" },
      { access: "Folder" },
      { access: "office", rooms: ["room-1"] },
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

  // Callers spread and intersect the grant: a shared object would let one
  // caller widen every later grant.
  it("returns a fresh grant each time", () => {
    const first = parseAgentAccessGrant({ access: "office" });
    const areas = first?.pack?.areas as Record<string, string> | undefined;
    if (areas) areas.logs = "read";
    expect(parseAgentAccessGrant({ access: "office" })).toEqual({
      access: "office",
      pack: FIXED,
    });
    expect(accessGrantOf({ access: "folder" })).toEqual({
      access: "folder",
      pack: FIXED,
    });
  });
});

describe("accessGrantOf", () => {
  // A record saved before task 82da687b can carry a narrow or a wide pack;
  // either reads as the fixed grant.
  it("reads a saved pack as the fixed grant at office, folder and web", () => {
    const packs = [
      undefined,
      { areas: { asks: "write" } },
      { areas: { logs: "read", tasks: "read" }, rooms: ["r1"] },
    ] as const;
    for (const access of PACK_STOPS)
      for (const pack of packs)
        expect({
          access,
          pack,
          grant: accessGrantOf(saved({ access, pack })),
        }).toEqual({ access, pack, grant: { access, pack: FIXED } });
  });

  it("gives no pack at the other stops, a saved one included", () => {
    for (const access of OTHER_STOPS)
      expect({
        access,
        grant: accessGrantOf(
          saved({ access, pack: { areas: { asks: "write" } } }),
        ),
      }).toEqual({ access, grant: { access } });
    // An agent saved before the slider.
    expect(accessGrantOf({ privileged: true })).toEqual({
      access: "privileged",
    });
    expect(accessGrantOf({})).toEqual({ access: "standard" });
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

// The UI and every server gate (setAccess, PATCH, spawn) read this rule. A
// Codex stop below Standard is proven for one model, at every stop
// (server/backends/codex/access.ts; folder and web since task 25015e41);
// OpenCode runs all four with any model (server/backends/opencode/access.ts).
describe("engineRunsAccess", () => {
  it("runs a stop below Standard on Claude and OpenCode, and on Codex only with a proven model", () => {
    const cases: [string, string | null, Record<AgentAccess, boolean>][] = [
      [
        "claude",
        "opus",
        {
          chat: true,
          office: true,
          folder: true,
          web: true,
          standard: true,
          privileged: true,
        },
      ],
      [
        "codex",
        "gpt-5.5",
        {
          chat: true,
          office: true,
          folder: true,
          web: true,
          standard: true,
          privileged: true,
        },
      ],
      // Another Codex model, or none resolved yet: no stop below Standard.
      ...(
        ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-6.1-sol", "", null] as const
      ).map((model): [string, string | null, Record<AgentAccess, boolean>] => [
        "codex",
        model,
        {
          chat: false,
          office: false,
          folder: false,
          web: false,
          standard: true,
          privileged: true,
        },
      ]),
      // OpenCode's tools are the same for every model (task e77304b1,
      // merge C2): every stop, whatever the model.
      ...(
        ["gpt-5.5", "opencode/big-pickle", "anthropic/claude-x", null] as const
      ).map((model): [string, string | null, Record<AgentAccess, boolean>] => [
        "opencode",
        model,
        {
          chat: true,
          office: true,
          folder: true,
          web: true,
          standard: true,
          privileged: true,
        },
      ]),
      // An engine Isomux does not know runs no stop below Standard.
      [
        "other",
        "gpt-5.5",
        {
          chat: false,
          office: false,
          folder: false,
          web: false,
          standard: true,
          privileged: true,
        },
      ],
    ];
    for (const [agentType, model, want] of cases) {
      const got = Object.fromEntries(
        ORDER.map((stop) => [stop, engineRunsAccess(agentType, stop, model)]),
      );
      expect({ agentType, model, got }).toEqual({
        agentType,
        model,
        got: want,
      });
    }
  });
});

// A false "same" drops a member's change at save; a false "different" rotates
// the token and restarts the session for nothing. Only the stop counts now.
describe("sameAccessGrant", () => {
  it("compares the stop only", () => {
    expect(
      sameAccessGrant(
        { access: "office", pack: { areas: { asks: "write" } } },
        { access: "office" },
      ),
    ).toBe(true);
    expect(
      sameAccessGrant(
        parseAgentAccessGrant({ access: "web" })!,
        parseAgentAccessGrant({ access: "web" })!,
      ),
    ).toBe(true);
    expect(sameAccessGrant({ access: "office" }, { access: "folder" })).toBe(
      false,
    );
    expect(
      sameAccessGrant({ access: "standard" }, { access: "privileged" }),
    ).toBe(false);
  });
});
