// Phase 0.2 DI seam test for AgentManager. Proves the manager is an
// instantiable unit: collaborators (backend resolver, event sink, officeState,
// persisted-rooms snapshot) are injected, FakeBackend is used instead of a real
// backend, and the two init-order invariants hold. This is NOT the Phase 0.3
// multi-socket harness or the Phase 1.1 onboarding flow — it exercises the seam
// only, with zero LLM/provider calls.
//
// State-root isolation caveat: STATE_ROOT is an eager import-time const, and
// `bun test` runs every test file in ONE shared process — so when this file is
// part of a full-suite run, config.ts has usually already resolved STATE_ROOT
// to the real ~/.isomux before this file sets ISOMUX_HOME. Assertions that
// would touch disk (spawn, the production factory) are therefore gated on
// ISOLATED below and SKIP in the shared run, so they can never write to real
// state. They DO run when this file is invoked on its own
// (`bun test server/test-support/agent-manager.di.test.ts`), and will run in
// the full suite once the Phase 0.3 script split invokes `bun test` with
// ISOMUX_HOME pre-set. The disk-free assertions run unconditionally — though
// note importing agent-manager pulls in persistence.ts, whose top-level
// mkdirSync(ISOMUX_DIR) runs against the resolved STATE_ROOT at import (a no-op
// on an existing root; it writes no agent content, so operations stay disk-free).

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeStateDir } from "./temp-state.ts";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import type { AgentBackendType } from "../../shared/types.ts";
import type { Backend } from "../backends/types.ts";
import type { EventHandler } from "../internal-types.ts";

const tmpHome = mkdtempSync(join(tmpdir(), "isomux-di-agent-"));
process.env.ISOMUX_HOME = tmpHome;

const { STATE_ROOT } = await import("../config.ts");
const { createAgentManager, createProductionAgentManager } = await import(
  "../agent-manager.ts"
);

// True only when this file's ISOMUX_HOME actually won the import-time race, i.e.
// STATE_ROOT resolved to our temp dir. Disk-touching assertions gate on this so
// they never write to the real ~/.isomux in a shared-process suite run.
const ISOLATED = STATE_ROOT === tmpHome;
if (!ISOLATED) {
  console.warn(
    `[agent-manager.di.test] STATE_ROOT=${STATE_ROOT} != temp; ` +
      "skipping disk-touching DI assertions (spawn, production factory). " +
      "Run this file alone, or via the Phase 0.3 ISOMUX_HOME-set script, for full coverage.",
  );
}

afterAll(() => {
  removeStateDir(tmpHome);
});

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id) => ({ id, name: id, prompt: null }));
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
  it.skipIf(!ISOLATED)(
    "consults the injected resolver and drives the FakeBackend on spawn (no real backend)",
    async () => {
      const fake = new FakeBackend();
      const { calls, resolveBackend } = spyResolver(fake);
      const mgr = createAgentManager({
        resolveBackend,
        officeState: new OfficeState({ rooms: rooms("room-a") }),
        initialRooms: [],
      });
      const info = await mgr.spawn(
        "TestAgent",
        tmpHome,
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
    },
  );

  it.skipIf(!ISOLATED)(
    "production factory constructs against today's defaults (shallow)",
    () => {
      // Empty temp home → loadAgents() returns [], so OfficeState seeds the
      // default single room. Reads tmpHome only.
      const mgr = createProductionAgentManager();
      expect(mgr.getRooms().length).toBeGreaterThanOrEqual(1);
    },
  );
});
