// Phase 0.2 DI seam test for AgentManager. Proves the manager is an
// instantiable unit: collaborators (backend resolver, event sink, officeState,
// persisted-rooms snapshot) are injected, FakeBackend is used instead of a real
// backend, and the two init-order invariants hold. This is NOT the Phase 0.3
// multi-socket harness or the Phase 1.1 onboarding flow — it exercises the seam
// only, with zero LLM/provider calls.
//
// State-root isolation: STATE_ROOT is an eager import-time const resolved from
// ISOMUX_HOME. The bun test preload (server/test-support/preload.ts) presets
// ISOMUX_HOME to a temp dir before any test imports config.ts, so STATE_ROOT is
// a throwaway temp root for the whole shared `bun test` process. That is what
// lets the disk-touching assertions here (spawn, the production factory) run
// in-suite; before Phase 0.3 they were gated on an ISOLATED check and skipped,
// because this file lost the import-time race to set its own ISOMUX_HOME. The
// disk-free assertions never needed the gate: importing agent-manager pulls in
// persistence.ts, but that import is side-effect-free (state dirs are created
// lazily on first write), so neither the import nor these assertions touch real
// state. The preload removes the temp root at process exit.

import { describe, it, expect } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import type { AgentBackendType } from "../../shared/types.ts";
import type { Backend } from "../backends/types.ts";
import type { EventHandler } from "../internal-types.ts";
import { STATE_ROOT } from "../config.ts";
import {
  createAgentManager,
  createProductionAgentManager,
} from "../agent-manager.ts";

// STATE_ROOT is a temp dir (the bun test preload preset ISOMUX_HOME before
// config.ts was imported), so the disk-touching assertions below run in-suite
// instead of skipping. The preload owns temp-root cleanup at process exit.

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

function capture() {
  const events: Parameters<EventHandler>[0][] = [];
  const sink: EventHandler = (e) => events.push(e);
  return { events, sink };
}

// Spy resolver: records the agentTypes asked for and returns the FakeBackend.
function spyResolver(backend: Backend) {
  const calls: AgentBackendType[] = [];
  const resolveBackend = (agentType: AgentBackendType) => {
    calls.push(agentType);
    return backend;
  };
  return { calls, resolveBackend };
}

describe("AgentManager DI (disk-free seam)", () => {
  it("seeds rooms synchronously at construction (invariant 1)", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a", "room-b") }),
      initialRooms: [],
    });
    // getRooms() returns the injected ids immediately — no async restore needed.
    expect(mgr.getRooms().map((r) => r.id)).toEqual(["room-a", "room-b"]);
  });

  it("routes domain events to the injected event sink", () => {
    const { events, sink } = capture();
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
      eventSink: sink,
    });
    // createRoom is latched (persistence stays off until restoreAgents), so this
    // emits to the sink without any disk write.
    mgr.createRoom("Room B");
    expect(events.some((e) => e.type === "room_created")).toBe(true);
  });

  it("onEvent() overrides the default noop sink", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    const { events, sink } = capture();
    mgr.onEvent(sink);
    mgr.renameRoom("room-a", "Renamed");
    expect(events.some((e) => e.type === "room_renamed")).toBe(true);
  });

  it("constructs with the default noop sink without throwing", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    expect(() => mgr.createRoom("No sink")).not.toThrow();
  });
});

describe("AgentManager DI (temp-state isolated)", () => {
  it("consults the injected resolver and drives the FakeBackend on spawn (no real backend)", async () => {
    const fake = new FakeBackend();
    const { calls, resolveBackend } = spyResolver(fake);
    const mgr = createAgentManager({
      resolveBackend,
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    const info = await mgr.spawn(
      "TestAgent",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    );
    expect(info).not.toBeNull();
    // Resolver consulted (production getBackend bypassed) and a FakeSession
    // created — proving no real LLM/provider call.
    expect(calls).toContain("claude");
    expect(fake.createSessionCount).toBeGreaterThan(0);
    expect(fake.lastSession?.opts.agentId).toBe(info!.id);
    // Close the fake session so the manager's background stream consumer
    // doesn't stay parked after the test.
    fake.lastSession?.close();
  });

  it("production factory constructs against today's defaults (shallow)", () => {
    // Empty temp home → loadAgents() returns [], so OfficeState seeds the
    // default single room. Reads the temp STATE_ROOT only.
    const mgr = createProductionAgentManager();
    expect(mgr.getRooms().length).toBeGreaterThanOrEqual(1);
  });
});
