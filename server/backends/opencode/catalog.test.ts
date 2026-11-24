// The OpenCode model list's provider origin (task ef863241).
//
// Seam: discoverOpenCodeModels and readProviderActivations over the fake
// OpenCode 2 server (fake-opencode-v2.ts). The live tier checks the real
// server's answer in adapter.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import {
  discoverOpenCodeModels,
  OPENCODE_EVENT_STREAM_DEADLINE_MS,
  readProviderActivations,
} from "./catalog.ts";
import {
  drivenClock,
  FAKE_CWD,
  fakeOpenCode,
  fakeSupervisor,
  modelRow,
  settleUntil,
  type FakeOptions,
} from "./fake-opencode-v2.ts";
import { splitModel } from "./transport.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Task ef863241: the model list says, per model, whether its provider is set
// up in OpenCode config (GET /api/provider activation "enabled") or found by
// OpenCode itself from an env key or a sign-in ("auto"). Only a listing that
// asks for it reads the providers; the kept catalog stays as it is.
describe("OpenCode 2 model list: provider origin", () => {
  const CANARY = "PROVIDER_SECRET_CANARY";
  const PROVIDERS = [
    {
      id: "own",
      name: "Own",
      activation: "enabled",
      settings: { apiKey: CANARY },
    },
    {
      id: "openai",
      name: "OpenAI",
      activation: "auto",
      settings: { apiKey: CANARY },
    },
  ];
  const MODELS = () => [
    modelRow("own", "llama"),
    modelRow("openai", "gpt"),
    // A provider the provider list does not name.
    modelRow("stray", "model"),
  ];
  const origin = (models: { id: string; providerFromConfig?: boolean }[]) =>
    Object.fromEntries(
      models.map((m) => [
        m.id,
        Object.hasOwn(m, "providerFromConfig")
          ? m.providerFromConfig
          : "absent",
      ]),
    );
  const providerReads = (fake: ReturnType<typeof fakeOpenCode>) =>
    fake.calls("GET", /^\/api\/provider$/);

  it("marks each model by its provider's activation, and leaves the kept catalog as it was", async () => {
    const fake = fakeOpenCode({ models: MODELS, providers: () => PROVIDERS });
    cleanups.push(fake.restore);
    const lease = fakeSupervisor();
    const listed = await discoverOpenCodeModels(lease.supervisor, FAKE_CWD, {
      providerOrigin: true,
    });
    expect(origin(listed)).toEqual({
      "own/llama": true,
      "openai/gpt": false,
      "stray/model": "absent",
    });
    expect(providerReads(fake)).toHaveLength(1);
    expect(providerReads(fake)[0].query.get("location[directory]")).toBe(
      FAKE_CWD,
    );
    expect(JSON.stringify(listed)).not.toContain(CANARY);
    // The same kept catalog, without the option (a turn, the one-shot
    // path): no field, and no provider read.
    const plain = await discoverOpenCodeModels(lease.supervisor, FAKE_CWD);
    expect(origin(plain)).toEqual({
      "own/llama": "absent",
      "openai/gpt": "absent",
      "stray/model": "absent",
    });
    expect(providerReads(fake)).toHaveLength(1);
    expect(fake.calls("GET", /^\/api\/model$/)).toHaveLength(1);
    expect(lease.releases()).toBe(2);
  });

  const failures: [string, FakeOptions][] = [
    ["an HTTP 500", { status: { provider: 500 } }],
    [
      "a body that is not JSON",
      {
        override: (route) =>
          route === "provider" ? new Response("not json") : undefined,
      },
    ],
    [
      "a refused connection",
      {
        override: (route) => {
          if (route === "provider") throw new TypeError("Unable to connect.");
          return undefined;
        },
      },
    ],
  ];
  for (const [name, options] of failures)
    it(`lists the models without the field after ${name} from the provider read`, async () => {
      const fake = fakeOpenCode({ models: MODELS, ...options });
      cleanups.push(fake.restore);
      const lease = fakeSupervisor();
      const listed = await discoverOpenCodeModels(lease.supervisor, FAKE_CWD, {
        providerOrigin: true,
      });
      // The condition: the provider route was asked, exactly once.
      expect(providerReads(fake)).toHaveLength(1);
      expect(origin(listed)).toEqual({
        "own/llama": "absent",
        "openai/gpt": "absent",
        "stray/model": "absent",
      });
      expect(lease.releases()).toBe(1);
    });

  // A pending read's state, for the cases that drive the clock by hand.
  function watch(read: Promise<Map<string, string> | null>) {
    const state: {
      value: Map<string, string> | null | "pending" | "rejected";
    } = { value: "pending" };
    read.then(
      (value) => (state.value = value),
      () => (state.value = "rejected"),
    );
    return state;
  }

  // The catalog read for the same folder already waited out the plugins, so
  // a 503 here is not asked again: the listing does not wait for it.
  it("asks once on a 503 and gives null, with no pause on the clock", async () => {
    const fake = fakeOpenCode({ status: { provider: 503 } });
    cleanups.push(fake.restore);
    const lease = await fakeSupervisor().supervisor.acquire();
    const clock = drivenClock();
    const state = watch(
      readProviderActivations(lease, FAKE_CWD, undefined, clock.scheduler),
    );
    await settleUntil(() => state.value !== "pending");
    expect(state.value).toBeNull();
    expect(providerReads(fake)).toHaveLength(1);
  });

  it("gives up on a provider read that never answers at the event-stream deadline", async () => {
    const fake = fakeOpenCode({ hold: { provider: "always" } });
    cleanups.push(fake.restore);
    const lease = await fakeSupervisor().supervisor.acquire();
    const clock = drivenClock();
    const state = watch(
      readProviderActivations(lease, FAKE_CWD, undefined, clock.scheduler),
    );
    await settleUntil(() => providerReads(fake).length === 1);
    expect(providerReads(fake)).toHaveLength(1);
    clock.advance(OPENCODE_EVENT_STREAM_DEADLINE_MS - 1);
    await settleUntil(() => state.value !== "pending", 20);
    expect(state.value).toBe("pending");
    clock.advance(1);
    await settleUntil(() => state.value !== "pending");
    expect(state.value).toBeNull();
  });

  it("gives up on a held provider read when the caller's signal aborts", async () => {
    const fake = fakeOpenCode({ hold: { provider: "always" } });
    cleanups.push(fake.restore);
    const lease = await fakeSupervisor().supervisor.acquire();
    const clock = drivenClock();
    const controller = new AbortController();
    const state = watch(
      readProviderActivations(
        lease,
        FAKE_CWD,
        controller.signal,
        clock.scheduler,
      ),
    );
    await settleUntil(() => providerReads(fake).length === 1);
    expect(providerReads(fake)).toHaveLength(1);
    controller.abort();
    await settleUntil(() => state.value !== "pending");
    expect(state.value).toBeNull();
  });
});

// A provider that routes to other vendors names its models vendor/model, so
// the model half of an id can hold slashes. The provider half takes none: the
// id Isomux keeps is split at its first slash.
describe("OpenCode 2 model list: model ids with slashes", () => {
  it("lists a model whose id holds slashes, under its provider", async () => {
    const fake = fakeOpenCode({
      models: () => [
        modelRow("router", "vendor/model", { name: "Vendor Model" }),
        modelRow("router", "/auto", { name: "Auto" }),
        modelRow("bad/provider", "model"),
        modelRow("router", "bad model"),
        modelRow("router", "bad?model"),
      ],
      providers: () => [
        { id: "router", name: "Router", activation: "enabled" },
      ],
    });
    cleanups.push(fake.restore);
    const listed = await discoverOpenCodeModels(
      fakeSupervisor().supervisor,
      FAKE_CWD,
      { providerOrigin: true },
    );
    expect(listed.map((m) => [m.id, m.label, m.providerFromConfig])).toEqual([
      ["router//auto", "router - Auto", true],
      ["router/vendor/model", "router - Vendor Model", true],
    ]);
    for (const { id } of listed) {
      expect(splitModel(id)[0]).toBe("router");
    }
    expect(splitModel("router/vendor/model")[1]).toBe("vendor/model");
    expect(splitModel("router//auto")[1]).toBe("/auto");
  });
});
