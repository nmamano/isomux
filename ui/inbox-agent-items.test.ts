// The Inbox items from live agent state (task ddf02829): who sees which,
// their keys and order, and how they count on the Inbox badge.
import { describe, expect, it } from "bun:test";
import {
  agentInboxItems,
  failureFirstLine,
  failureKey,
  type AgentInboxItem,
} from "./inbox-agent-items.ts";
import { inboxCounts } from "./inbox.ts";
import type {
  AgentChoiceInteraction,
  AgentFailure,
  AgentInfo,
  AskMemberWire,
} from "../shared/types.ts";

const ME = "u-me";
const OTHER = "u-other";

function agent(
  id: string,
  over: Partial<AgentInfo> & { roomId?: string } = {},
): AgentInfo {
  return {
    id,
    name: id,
    roomId: "r1",
    userId: OTHER,
    state: "idle",
    turnMemberIds: [],
    pendingPrompt: null,
    failure: null,
    ...over,
  } as AgentInfo;
}

function failure(since: number, memberIds: string[] = []): AgentFailure {
  return { since, content: `failed at ${since}`, memberIds };
}

function interaction(
  id: string,
  agentId: string,
  kind: AgentChoiceInteraction["kind"] = "permission",
): AgentChoiceInteraction {
  return {
    id,
    agentId,
    kind,
    title: "Wants to run Bash",
    instruction: "Pick one",
    choices: [
      { value: "allow", label: "Allow" },
      { value: "deny", label: "Deny" },
    ],
  };
}

const keys = (items: AgentInboxItem[]) => items.map((i) => i.key);

describe("agentInboxItems", () => {
  it("shows a permission wait of every agent the member can see, whoever manages or started it", () => {
    const agents = [
      agent("a1", { pendingPrompt: "permission", userId: OTHER }),
      agent("a2", { pendingPrompt: "permission", userId: null, roomId: "r2" }),
      // A picker the member opened in that chat is not an Inbox item.
      agent("a3", { pendingPrompt: "model", userId: ME }),
      agent("a4", { pendingPrompt: null, userId: ME }),
    ];
    const interactions = [
      interaction("i1", "a1"),
      // a2's engine reads its answer in chat: no interaction.
      interaction("i3", "a3", "model"),
    ];
    const items = agentInboxItems(agents, interactions, ME, []);
    expect(keys(items)).toEqual(["permission:i1", "permission:a2"]);
    const [one, two] = items;
    expect(one.kind === "permission" && one.interaction?.id).toBe("i1");
    expect([one.agentId, one.roomId]).toEqual(["a1", "r1"]);
    expect(two.kind === "permission" && two.interaction).toBeNull();
    expect([two.agentId, two.roomId]).toEqual(["a2", "r2"]);
    // A member the client cannot name (no session yet) still sees them:
    // the room reach is the whole rule.
    expect(keys(agentInboxItems(agents, interactions, null, []))).toEqual([
      "permission:i1",
      "permission:a2",
    ]);
  });

  it("picks the agent's permission interaction, not another of its choices or another agent's", () => {
    const agents = [agent("a1", { pendingPrompt: "permission" })];
    const items = agentInboxItems(
      agents,
      [
        interaction("other-agent", "a9"),
        interaction("picker", "a1", "effort"),
        interaction("ask", "a1"),
      ],
      ME,
      [],
    );
    expect(keys(items)).toEqual(["permission:ask"]);
  });

  it("shows a failure only to the agent's manager and the members who started the failed turn", () => {
    const agents = [
      agent("managed", { userId: ME, failure: failure(10) }),
      agent("started", { userId: OTHER, failure: failure(20, [OTHER, ME]) }),
      agent("neither", { userId: OTHER, failure: failure(30, [OTHER]) }),
      // Failed state without a record is not an item: the record is the rule.
      agent("bare", { userId: ME, state: "error", failure: null }),
    ];
    const items = agentInboxItems(agents, [], ME, []);
    expect(keys(items)).toEqual([
      `failed:${failureKey("started", 20)}`,
      `failed:${failureKey("managed", 10)}`,
    ]);
    const first = items[0];
    expect(first.kind === "failed" && first.failure.since).toBe(20);
    expect(first.roomId).toBe("r1");
    // No member: no failed item at all.
    expect(agentInboxItems(agents, [], null, [])).toHaveLength(0);
  });

  it("leaves out a dismissed failure until the agent fails again", () => {
    const agents = [agent("a1", { userId: ME, failure: failure(10) })];
    const dismissed = [failureKey("a1", 10)];
    expect(agentInboxItems(agents, [], ME, dismissed)).toHaveLength(0);
    // The key of the next failure differs, so it shows again.
    const again = [agent("a1", { userId: ME, failure: failure(11) })];
    expect(keys(agentInboxItems(again, [], ME, dismissed))).toEqual([
      `failed:${failureKey("a1", 11)}`,
    ]);
    // A dismiss key is per agent: another agent's same moment still shows.
    const twin = [agent("a2", { userId: ME, failure: failure(10) })];
    expect(agentInboxItems(twin, [], ME, dismissed)).toHaveLength(1);
  });

  it("orders the permission waits first, in agent order, then the failures, newest first; one agent can have both", () => {
    const agents = [
      agent("f-old", { userId: ME, failure: failure(100) }),
      agent("p-b", { pendingPrompt: "permission" }),
      agent("both", {
        userId: ME,
        pendingPrompt: "permission",
        failure: failure(300),
      }),
      agent("f-mid", { userId: ME, failure: failure(200) }),
      agent("p-a", { pendingPrompt: "permission" }),
    ];
    const items = agentInboxItems(
      agents,
      [interaction("ib", "p-b"), interaction("iboth", "both")],
      ME,
      [],
    );
    expect(keys(items)).toEqual([
      "permission:ib",
      "permission:iboth",
      "permission:p-a",
      `failed:${failureKey("both", 300)}`,
      `failed:${failureKey("f-mid", 200)}`,
      `failed:${failureKey("f-old", 100)}`,
    ]);
  });

  it("keys a failure by its agent and its start, apart for every agent and moment", () => {
    const k = failureKey("a1", 10);
    expect(k).not.toBe(failureKey("a1", 11));
    expect(k).not.toBe(failureKey("a2", 10));
    expect(failureKey("a1", 10)).toBe(k);
  });
});

describe("inboxCounts with agent items", () => {
  const ask = (id: string, agentId: string) =>
    ({ id, agentId, createdAt: 1, updatedAt: 1 }) as AskMemberWire;
  const agents = [
    agent("a1", {
      userId: ME,
      pendingPrompt: "permission",
      failure: failure(5),
    }),
    agent("a2", { pendingPrompt: "permission" }),
  ];

  it("counts the items with the asks, new until seen, and leaves out the open chat's", () => {
    const items = agentInboxItems(agents, [interaction("i1", "a1")], ME, []);
    expect(keys(items)).toEqual([
      "permission:i1",
      "permission:a2",
      `failed:${failureKey("a1", 5)}`,
    ]);
    const asks = [ask("q1", "a1"), ask("q2", "a2")];
    const count = (seen: string[], except?: string) => {
      const c = inboxCounts(
        asks,
        agents,
        new Map(),
        new Set(seen),
        except,
        items,
      );
      return [c.asks, c.newAsks];
    };
    expect(count([])).toEqual([5, 5]);
    expect(count(["q1", "permission:a2"])).toEqual([5, 3]);
    expect(count(["q1", "q2", ...keys(items)])).toEqual([5, 0]);
    // In a1's chat, its ask and both its items are already on screen.
    expect(count([], "a1")).toEqual([2, 2]);
    expect(count([], "a2")).toEqual([3, 3]);
    // Items with no ask open count on their own.
    const c = inboxCounts([], agents, new Map(), new Set(), undefined, items);
    expect([c.asks, c.newAsks]).toEqual([3, 3]);
  });
});

describe("failureFirstLine", () => {
  it("keeps the first line that is not blank, trimmed, and inner spaces", () => {
    expect(failureFirstLine("one line")).toBe("one line");
    expect(failureFirstLine("first  part\nsecond\nthird")).toBe("first  part");
    expect(failureFirstLine("\n  \n\t first \nsecond")).toBe("first");
    expect(failureFirstLine("first\r\nsecond")).toBe("first");
    expect(failureFirstLine("\r\n  \r\nfirst\r\n")).toBe("first");
  });

  it("gives an empty string when every line is blank", () => {
    expect(failureFirstLine("")).toBe("");
    expect(failureFirstLine(" \n\t\r\n ")).toBe("");
  });
});
