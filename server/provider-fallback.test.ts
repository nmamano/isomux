// The fallback switch and state (server/provider-fallback.ts, task 2008c993).
// Seam: the store's own API, with an injected clock and in-memory storage for
// the entry rules, and the office singleton over the test state root for the
// persistence across a server restart (resetProviderFallback).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { STATE_ROOT } from "./config.ts";
import {
  createProviderFallback,
  providerFallback,
  resetProviderFallback,
} from "./provider-fallback.ts";
import { removeStateDir } from "./test-support/temp-state.ts";

const HOUR = 60 * 60 * 1000;

// A store over in-memory storage and a clock the test moves.
function memoryStore(start = 1_800_000_000_000) {
  const clock = { now: start };
  const disk: { enabled: boolean; state: unknown } = {
    enabled: false,
    state: undefined,
  };
  const open = () =>
    createProviderFallback({
      load: () => disk.enabled,
      save: (enabled) => {
        disk.enabled = enabled;
      },
      loadState: () => disk.state,
      saveState: (state) => {
        // What a file write keeps: plain JSON.
        disk.state = JSON.parse(JSON.stringify(state));
      },
      now: () => clock.now,
    });
  return { clock, disk, open, store: open() };
}

describe("fallback entries", () => {
  it("count until their time, and not at it", () => {
    const { clock, store } = memoryStore();
    const until = clock.now + HOUR;
    store.start("alice", "claude", { until });
    expect(store.entry("alice", "claude")).toMatchObject({ until });
    clock.now = until - 1;
    expect(store.entry("alice", "claude")).toMatchObject({ until });
    clock.now = until;
    expect(store.entry("alice", "claude")).toBeNull();
  });

  it("are per member and provider, and keep the family of the stop", () => {
    const { clock, store } = memoryStore();
    const until = clock.now + HOUR;
    store.start("alice", "claude", { until, family: "opus" });
    expect(store.entry("alice", "claude")).toMatchObject({
      until,
      family: "opus",
    });
    expect(store.entry("alice", "codex")).toBeNull();
    expect(store.entry("bob", "claude")).toBeNull();
  });

  it("a later stop replaces the entry, family included", () => {
    const { clock, store } = memoryStore();
    store.start("alice", "claude", { until: clock.now + HOUR, family: "opus" });
    const later = clock.now + 5 * HOUR;
    store.start("alice", "claude", { until: later });
    const entry = store.entry("alice", "claude");
    expect(entry?.until).toBe(later);
    expect(entry?.family).toBeUndefined();
  });

  it("end when the member's own account changes, and a new stop counts again", () => {
    const { clock, store } = memoryStore();
    const until = clock.now + HOUR;
    store.start("alice", "claude", { until });
    // Another member's or provider's change leaves it.
    store.accountChanged("bob", "claude");
    store.accountChanged("alice", "codex");
    expect(store.entry("alice", "claude")).toMatchObject({ until });
    store.accountChanged("alice", "claude");
    expect(store.entry("alice", "claude")).toBeNull();
    store.start("alice", "claude", { until });
    expect(store.entry("alice", "claude")).toMatchObject({ until });
  });

  it("an unreadable stored state is no entry, and the store still works", () => {
    for (const junk of ["x", 7, null, [1], { alice: "claude" }]) {
      const m = memoryStore();
      m.disk.state = junk;
      const store = m.open();
      expect(store.entry("alice", "claude")).toBeNull();
      store.start("alice", "claude", { until: m.clock.now + HOUR });
      expect(store.entry("alice", "claude")?.until).toBe(m.clock.now + HOUR);
    }
  });
});

describe("the switch", () => {
  it("is off by default and saved when set", () => {
    const m = memoryStore();
    expect(m.store.isEnabled()).toBe(false);
    m.store.setEnabled(true);
    expect(m.disk.enabled).toBe(true);
    expect(m.open().isEnabled()).toBe(true);
  });
});

// The office singleton keeps its state in the state root: a server restart
// (resetProviderFallback, which a boot runs) reads it back.
describe("across a server restart", () => {
  beforeEach(() => {
    removeStateDir(STATE_ROOT);
    mkdirSync(STATE_ROOT, { recursive: true });
    resetProviderFallback();
  });
  afterEach(() => {
    resetProviderFallback();
  });

  it("keeps the switch, the entries and the account changes", () => {
    const until = Date.now() + HOUR;
    providerFallback().setEnabled(true);
    providerFallback().start("alice", "claude", { until, family: "sonnet" });
    providerFallback().start("alice", "codex", { until });

    resetProviderFallback();
    expect(providerFallback().isEnabled()).toBe(true);
    expect(providerFallback().entry("alice", "claude")).toMatchObject({
      until,
      family: "sonnet",
    });

    // An account change still counts after the next restart.
    providerFallback().accountChanged("alice", "claude");
    resetProviderFallback();
    expect(providerFallback().entry("alice", "claude")).toBeNull();
    expect(providerFallback().entry("alice", "codex")?.until).toBe(until);
  });
});
