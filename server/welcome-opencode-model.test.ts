import { describe, expect, it } from "bun:test";
import {
  firstAnsweringModel,
  FREE_WELCOME_AGENT_NAME,
  freeOpenCodeCandidates,
  needsOfficeFreeModelMark,
  PAST_FREE_DEFAULT_MODELS,
  RECEPTIONIST_NAME,
  resolveWelcomeOpenCodeModel,
  retryWelcomeOpenCodeModel,
  WELCOME_MODEL_RETRY_WINDOW_CLOSED,
  type WelcomeModelRetryClock,
} from "./welcome-opencode-model.ts";
import { LOBBY_ROOM_ID, type BackendModelWire } from "../shared/types.ts";
import { preferredFreeOpenCodeModel } from "../shared/opencode-model.ts";

describe("welcome OpenCode model resolution", () => {
  const preferred = "opencode/preferred-free";

  it("selects a free replacement when the preferred id is gone", async () => {
    expect(
      await resolveWelcomeOpenCodeModel(
        async () => [
          { id: "paid/default", label: "Paid", supportedEfforts: [] },
          {
            id: "opencode/replacement-free",
            label: "Free",
            isFree: true,
            supportedEfforts: [],
          },
        ],
        preferred,
        100,
      ),
    ).toEqual({ kind: "selected", model: "opencode/replacement-free" });
  });

  it("picks only from the preferred model's provider", async () => {
    const goFree: BackendModelWire = {
      id: "opencode-go/sorts-first-free",
      label: "Go",
      isFree: true,
      supportedEfforts: [],
    };
    expect(
      await resolveWelcomeOpenCodeModel(
        async () => [
          goFree,
          {
            id: "opencode/replacement-free",
            label: "Free",
            isFree: true,
            supportedEfforts: [],
          },
        ],
        preferred,
        100,
      ),
    ).toEqual({ kind: "selected", model: "opencode/replacement-free" });
    expect(
      await resolveWelcomeOpenCodeModel(async () => [goFree], preferred, 100),
    ).toEqual({ kind: "no_free_model" });
  });

  it("bounds discovery and reports failure", async () => {
    const result = await resolveWelcomeOpenCodeModel(
      () => new Promise(() => undefined),
      preferred,
      5,
    );
    expect(result.kind).toBe("discovery_failed");
    if (result.kind === "discovery_failed") {
      expect(String(result.error)).toContain("timed out");
    }
  });
});

describe("welcome OpenCode model retry", () => {
  const preferred = "opencode/preferred-free";
  const timing = { delayMs: 100, windowMs: 1_000 };
  const free: BackendModelWire = {
    id: "opencode/replacement-free",
    label: "Free",
    isFree: true,
    supportedEfforts: [],
  };

  // Sleeping moves the clock forward, so a test covers the window at once.
  function fakeClock(): WelcomeModelRetryClock & { sleeps: number[] } {
    let now = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    };
  }

  it("waits between failed attempts and returns the first success", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        calls++;
        if (calls < 3) throw new Error("not ready");
        return [free];
      },
      preferred,
      timing,
      clock,
    );
    expect(result).toEqual({ kind: "selected", model: free.id });
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([timing.delayMs, timing.delayMs]);
  });

  it("stops at the end of the window and reports the failure", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        calls++;
        throw new Error("offline");
      },
      preferred,
      timing,
      clock,
    );
    expect(result.kind).toBe("discovery_failed");
    expect(clock.now()).toBeLessThanOrEqual(timing.windowMs);
    expect(calls).toBe(clock.sleeps.length + 1);
    expect(calls).toBeGreaterThan(1);
  });

  it("never starts a request while the previous one is pending", async () => {
    const clock = fakeClock();
    let calls = 0;
    void retryWelcomeOpenCodeModel(
      () => {
        calls++;
        return new Promise<BackendModelWire[]>(() => undefined);
      },
      preferred,
      timing,
      clock,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("ignores a result that arrives after the window", async () => {
    const clock = fakeClock();
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        await clock.sleep(timing.windowMs + 1);
        return [free];
      },
      preferred,
      timing,
      clock,
    );
    expect(result.kind).toBe("discovery_failed");
    if (result.kind === "discovery_failed")
      expect(String(result.error)).toContain(WELCOME_MODEL_RETRY_WINDOW_CLOSED);
  });

  it("starts no request when a delayed wake-up lands after the window", async () => {
    let now = 0;
    const starts: number[] = [];
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        starts.push(now);
        throw new Error("offline");
      },
      preferred,
      { delayMs: 1, windowMs: 10 },
      { now: () => now, sleep: async () => void (now = 11) },
    );
    expect(starts).toEqual([0]);
    expect(result.kind).toBe("discovery_failed");
    if (result.kind === "discovery_failed")
      expect(String(result.error)).toContain(WELCOME_MODEL_RETRY_WINDOW_CLOSED);
  });

  it("does not retry after a discovery with no free model", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryWelcomeOpenCodeModel(
      async () => {
        calls++;
        return [{ id: "paid/default", label: "Paid", supportedEfforts: [] }];
      },
      preferred,
      timing,
      clock,
    );
    expect(result).toEqual({ kind: "no_free_model" });
    expect(calls).toBe(1);
  });
});

// Task 0387b8de: the provider can refuse a free model its catalog still
// lists, so the seed checks the candidates in order.
describe("free OpenCode model candidates", () => {
  const preferred = "opencode/preferred-free";
  const free = (id: string, extra: Partial<BackendModelWire> = {}) => ({
    id,
    label: id,
    isFree: true,
    supportedEfforts: [],
    ...extra,
  });

  it("puts the preferred id first, then the other free models of its provider in id order", () => {
    const models: BackendModelWire[] = [
      free("opencode/zeta-free"),
      { id: "opencode/paid", label: "Paid", supportedEfforts: [] },
      free("opencode/alpha-free"),
      free("opencode/hidden-free", { hidden: true }),
      free("opencode-go/sorts-first-free"),
      free(preferred),
      free("anthropic/other-free"),
    ];
    const candidates = freeOpenCodeCandidates(models, preferred);
    expect(candidates).toEqual([
      preferred,
      "opencode/alpha-free",
      "opencode/zeta-free",
    ]);
    // The picker and the templates keep their choice.
    expect(candidates[0]).toBe(
      preferredFreeOpenCodeModel(models, preferred)!.id,
    );
  });

  it("starts at the first other free model when the preferred id is not listed, and is empty without one", () => {
    const models = [free("opencode/b-free"), free("opencode/a-free")];
    const candidates = freeOpenCodeCandidates(models, preferred);
    expect(candidates).toEqual(["opencode/a-free", "opencode/b-free"]);
    expect(candidates[0]).toBe(
      preferredFreeOpenCodeModel(models, preferred)!.id,
    );
    expect(
      freeOpenCodeCandidates([free("opencode-go/x-free")], preferred),
    ).toEqual([]);
  });
});

describe("the first free model that answers", () => {
  const timing = { probeTimeoutMs: 100, probeBudgetMs: 250 };
  // Time moves only when the code under test sleeps (a sleep is a probe's
  // timeout), and a sleep settles after a macrotask, so a probe that settles
  // at once always wins its race. A sleep that lost its race still moves the
  // clock when it fires: no case here has enough fast refusals to reach the
  // budget that way.
  function fakeClock(): WelcomeModelRetryClock & { sleeps: number[] } {
    let now = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => now,
      sleep: (ms) =>
        new Promise((resolve) =>
          setTimeout(() => {
            sleeps.push(ms);
            now += ms;
            resolve();
          }, 0),
        ),
    };
  }
  // A probe script per model: it answers, refuses, or never settles.
  function probes(script: Record<string, "answers" | "refuses" | "hangs">) {
    const started: string[] = [];
    let open = 0;
    let maxOpen = 0;
    const probe = async (model: string) => {
      started.push(model);
      maxOpen = Math.max(maxOpen, ++open);
      try {
        if (script[model] === "hangs") await new Promise(() => undefined);
        if (script[model] === "refuses")
          throw new Error("Model is unavailable");
      } finally {
        open--;
      }
    };
    return { probe, started, maxOpen: () => maxOpen };
  }

  it("probes in order, one at a time, and returns the first that answers", async () => {
    const p = probes({ a: "refuses", b: "answers", c: "answers" });
    expect(
      await firstAnsweringModel(["a", "b", "c"], p.probe, timing, fakeClock()),
    ).toBe("b");
    expect(p.started).toEqual(["a", "b"]);
    expect(p.maxOpen()).toBe(1);
  });

  it("counts a probe that does not settle by its timeout as refused and goes on", async () => {
    const p = probes({ a: "hangs", b: "answers" });
    const clock = fakeClock();
    expect(await firstAnsweringModel(["a", "b"], p.probe, timing, clock)).toBe(
      "b",
    );
    expect(p.started).toEqual(["a", "b"]);
    expect(clock.sleeps).toContain(timing.probeTimeoutMs);
  });

  it("starts no probe that the budget would cut, and returns null", async () => {
    // Two timeouts fit in the budget; a third would start with 50 ms left.
    const p = probes({ a: "hangs", b: "hangs", c: "answers" });
    const clock = fakeClock();
    expect(
      await firstAnsweringModel(["a", "b", "c"], p.probe, timing, clock),
    ).toBeNull();
    expect(p.started).toEqual(["a", "b"]);
    expect(clock.now()).toBeLessThanOrEqual(timing.probeBudgetMs);
  });

  it("returns null when every candidate refuses, or there is none", async () => {
    const p = probes({ a: "refuses", b: "refuses" });
    expect(
      await firstAnsweringModel(["a", "b"], p.probe, timing, fakeClock()),
    ).toBeNull();
    expect(p.started).toEqual(["a", "b"]);
    expect(
      await firstAnsweringModel([], p.probe, timing, fakeClock()),
    ).toBeNull();
  });

  it("counts a probe that throws before it returns a promise as refused", async () => {
    const started: string[] = [];
    const probe = (model: string): Promise<void> => {
      started.push(model);
      if (model === "a") throw new Error("no environment");
      return Promise.resolve();
    };
    expect(
      await firstAnsweringModel(["a", "b"], probe, timing, fakeClock()),
    ).toBe("b");
    expect(started).toEqual(["a", "b"]);
  });
});

// Task c00b3973: the boot backfill marks only the two agents the office seeds,
// and only while they sit on a model the office used as its free default.
describe("needsOfficeFreeModelMark", () => {
  const OLD = "opencode/nemotron-3-ultra-free";
  const seed = (
    changes: Partial<Parameters<typeof needsOfficeFreeModelMark>[0]> = {},
  ): Parameters<typeof needsOfficeFreeModelMark>[0] => ({
    agentType: "opencode",
    name: FREE_WELCOME_AGENT_NAME,
    roomId: "room-1",
    modelFamily: OLD,
    ...changes,
  });

  it("marks the Free Welcome Agent and the lobby Receptionist on each past default", () => {
    expect(PAST_FREE_DEFAULT_MODELS).toContain(OLD);
    for (const model of PAST_FREE_DEFAULT_MODELS) {
      expect(needsOfficeFreeModelMark(seed({ modelFamily: model }))).toBe(true);
      expect(
        needsOfficeFreeModelMark(
          seed({
            name: RECEPTIONIST_NAME,
            roomId: LOBBY_ROOM_ID,
            modelFamily: model,
          }),
        ),
      ).toBe(true);
    }
  });

  it("leaves a seed on another model, and every other agent, unmarked", () => {
    expect(
      needsOfficeFreeModelMark(seed({ modelFamily: "opencode/a-member-pick" })),
    ).toBe(false);
    expect(
      needsOfficeFreeModelMark(
        seed({
          name: RECEPTIONIST_NAME,
          roomId: LOBBY_ROOM_ID,
          modelFamily: "opencode/a-member-pick",
        }),
      ),
    ).toBe(false);
    // The Receptionist's name outside the lobby is a member's agent.
    expect(needsOfficeFreeModelMark(seed({ name: RECEPTIONIST_NAME }))).toBe(
      false,
    );
    // Another agent, in the lobby or in a room.
    expect(
      needsOfficeFreeModelMark(
        seed({ name: "Lobby Helper", roomId: LOBBY_ROOM_ID }),
      ),
    ).toBe(false);
    expect(needsOfficeFreeModelMark(seed({ name: "Builder" }))).toBe(false);
    // Only OpenCode agents run on a free model of the office.
    expect(needsOfficeFreeModelMark(seed({ agentType: "claude" }))).toBe(false);
  });
});
