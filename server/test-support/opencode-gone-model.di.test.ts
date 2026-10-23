// An OpenCode agent whose model OpenCode no longer lists (task 73951c9f): the
// failed turn's line offers the model picker, the agent carries the gone
// model until its model changes, and a gone model on the agent that faces
// visitors (the lobby agent) pages its manager once per model. Nothing here
// switches the model: a member chose it.

import { afterEach, describe, expect, it } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import {
  LOBBY_ROOM,
  LOBBY_ROOM_ID,
  type AgentInfo,
  type PagerEntry,
  type RoomWire,
} from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import { createPagerStore, type PagerPersistence } from "../pager-store.ts";
import type { AgentEvent } from "../internal-types.ts";
import { STATE_ROOT } from "../config.ts";

const ROOM: RoomWire = {
  id: "room-gone-model",
  name: "room-gone-model",
  prompt: null,
  canCloseWhenEmpty: true,
};
const GONE = "opencode/removed-model";
const MANAGER = "user-gone-model";

function pagerStore() {
  const persistence: PagerPersistence = {
    load: () => ({ kind: "missing" }),
    save: () => {},
    quarantine: () => true,
  };
  const raised: Array<"created" | "reraised"> = [];
  const store = createPagerStore({
    persistence,
    onRaised: (_entry, kind) => {
      raised.push(kind);
    },
  });
  return { store, raised };
}

const fakes: FakeBackend[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0))
    for (const session of fake.sessions) session.close();
});

async function harness(opts: { roomId?: string; userId?: string | null }) {
  const events: AgentEvent[] = [];
  // The end of the next failed turn, as the OpenCode transport sends it.
  let nextEnd: { pickModel?: true; goneModel?: string } = {};
  const fake = new FakeBackend({
    storedSessionState: "durable",
    session: {
      onSend: (_text, _attachments, session) =>
        session.push({
          kind: "turn_completed",
          status: "failed",
          error: "OpenCode no longer lists this model.",
          ...nextEnd,
        }),
    },
  });
  fakes.push(fake);
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: [LOBBY_ROOM, ROOM] }),
    initialRooms: [],
    eventSink: (event) => events.push(event),
  });
  mgr.configureAgentTurnDeps();
  const pager = pagerStore();
  mgr.attachPagerStore(pager.store);
  const info = await mgr.spawn(
    "Receptionist",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    opts.roomId ?? LOBBY_ROOM_ID,
    undefined,
    GONE,
    undefined,
    undefined,
    "opencode",
    undefined,
    opts.userId === undefined ? MANAGER : opts.userId,
  );
  expect(info, "the agent spawned").not.toBeNull();
  const agentId = info!.id;
  expect(mgr.getAgent(agentId)?.roomId).toBe(opts.roomId ?? LOBBY_ROOM_ID);
  // The agent as a browser holds it: the spawn's record, then every
  // agent_updated change after a JSON round trip, merged as ui/store.tsx does.
  const asBrowserSees = (): AgentInfo => {
    let agent = JSON.parse(JSON.stringify(info)) as AgentInfo;
    for (const event of events) {
      if (event.type !== "agent_updated" || event.agentId !== agentId) continue;
      const changes = JSON.parse(JSON.stringify(event.changes));
      agent = { ...agent, ...changes };
    }
    return agent;
  };
  const failTurn = async (end: {
    pickModel?: true;
    goneModel?: string;
  }): Promise<void> => {
    nextEnd = end;
    await mgr.sendMessage(agentId, "hello", "tester");
  };
  return { mgr, agentId, pager, asBrowserSees, failTurn };
}

const pages = (entries: PagerEntry[]) =>
  entries.map((entry) => ({
    source: entry.source.kind === "agent" ? entry.source.agentId : null,
    target: entry.targetUserId,
    key: entry.key,
    raiseCount: entry.raiseCount,
  }));

describe("the failed turn's line", () => {
  it("offers the model picker only on a turn that asks for it", async () => {
    const { mgr, agentId, failTurn } = await harness({ roomId: ROOM.id });
    await failTurn({ pickModel: true });
    await failTurn({});
    const errors = mgr
      .getAgentLogs(agentId)
      .filter((entry) => entry.kind === "error");
    expect(errors).toHaveLength(2);
    expect(errors.map((entry) => entry.metadata?.pickModel === true)).toEqual([
      true,
      false,
    ]);
  });
});

describe("the gone model on the agent", () => {
  it("a turn that names a gone model flags the agent, and the browser sees it", async () => {
    const { mgr, agentId, asBrowserSees, failTurn } = await harness({
      roomId: ROOM.id,
    });
    await failTurn({ pickModel: true, goneModel: GONE });
    expect(mgr.getAgent(agentId)?.goneModel).toBe(GONE);
    expect(asBrowserSees().goneModel).toBe(GONE);
    // The model stays the member's choice.
    expect(mgr.getAgent(agentId)?.modelFamily).toBe(GONE);
  });

  it("a model change or setGoneModel(null) clears the flag for the browser too; another edit keeps it", async () => {
    const { mgr, agentId, asBrowserSees } = await harness({ roomId: ROOM.id });
    mgr.setGoneModel(agentId, GONE);
    expect(asBrowserSees().goneModel).toBe(GONE);
    mgr.setGoneModel(agentId, null);
    expect(mgr.getAgent(agentId)?.goneModel ?? null).toBeNull();
    expect(asBrowserSees().goneModel ?? null).toBeNull();
    mgr.setGoneModel(agentId, GONE);
    await mgr.editAgent(agentId, { name: "Renamed" });
    expect(mgr.getAgent(agentId)?.goneModel).toBe(GONE);
    expect(asBrowserSees().goneModel).toBe(GONE);
    await mgr.editAgent(agentId, { modelFamily: "opencode/kept-model" });
    expect(mgr.getAgent(agentId)?.modelFamily).toBe("opencode/kept-model");
    expect(mgr.getAgent(agentId)?.goneModel ?? null).toBeNull();
    expect(asBrowserSees().goneModel ?? null).toBeNull();
  });

  it("an engine switch clears the flag for the browser too", async () => {
    const { mgr, agentId, asBrowserSees } = await harness({ roomId: ROOM.id });
    mgr.setGoneModel(agentId, GONE);
    expect(asBrowserSees().goneModel).toBe(GONE);
    await mgr.editAgent(agentId, { agentType: "claude" });
    expect(mgr.getAgent(agentId)?.agentType).toBe("claude");
    expect(mgr.getAgent(agentId)?.goneModel ?? null).toBeNull();
    expect(asBrowserSees().goneModel ?? null).toBeNull();
  });
});

describe("the page for the agent that faces visitors", () => {
  it("pages the lobby agent's manager once per gone model", async () => {
    const { mgr, agentId, pager, failTurn } = await harness({});
    await failTurn({ pickModel: true, goneModel: GONE });
    // The same model again, from a turn and from the daily check: no new page.
    await failTurn({ pickModel: true, goneModel: GONE });
    mgr.setGoneModel(agentId, GONE);
    expect(pager.raised).toEqual(["created"]);
    const first = pages(pager.store.list());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      source: agentId,
      target: MANAGER,
      raiseCount: 1,
    });
    expect(first[0].key).toContain(GONE);
    // Another gone model is another page.
    const next = "opencode/also-removed";
    mgr.setGoneModel(agentId, next);
    expect(pager.raised).toEqual(["created", "created"]);
    const both = pages(pager.store.list());
    expect(both).toHaveLength(2);
    expect(both.filter((page) => page.key?.includes(next))).toHaveLength(1);
  });

  it("flags but does not page for an agent outside the lobby", async () => {
    const { mgr, agentId, pager, failTurn } = await harness({
      roomId: ROOM.id,
    });
    await failTurn({ pickModel: true, goneModel: GONE });
    mgr.setGoneModel(agentId, "opencode/also-removed");
    expect(mgr.getAgent(agentId)?.goneModel).toBe("opencode/also-removed");
    expect(pager.raised).toEqual([]);
    expect(pager.store.list()).toEqual([]);
  });

  it("flags but does not page for a lobby agent with no manager", async () => {
    const { mgr, agentId, pager } = await harness({ userId: null });
    mgr.setGoneModel(agentId, GONE);
    expect(mgr.getAgent(agentId)?.goneModel).toBe(GONE);
    expect(pager.raised).toEqual([]);
    expect(pager.store.list()).toEqual([]);
  });
});
