import { describe, expect, it } from "bun:test";
import { ApiError } from "./api.ts";
import {
  defaultBackendModel,
  effortPickerOptions,
  fetchBackendModels,
  modelListErrorMessage,
  openCodeModelSelectionReady,
  partitionBackendModelsForPicker,
  selectSupportedEffort,
} from "./backend-model-selection.ts";
import { effortLevelsFor, type BackendModelWire } from "../shared/types.ts";
import { translatorFor } from "../shared/i18n/translate.ts";

const noSleep = async () => {};
const PROJECT = { cwd: "/work/project" };

describe("fetchBackendModels", () => {
  // Listing models can start a backend for cwd, so the request is a POST with
  // the cwd in the body: the server's Origin check covers it (task 77ec7e9d).
  it("sends a POST with the cwd in the JSON body on every attempt, through apiFetch", async () => {
    const realFetch = globalThis.fetch;
    const sent: { url: string; method?: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });
      return sent.length === 1
        ? new Response("", { status: 503 })
        : Response.json({ models: [] });
    }) as typeof fetch;
    try {
      const result = await fetchBackendModels(
        "/api/backends/opencode/models",
        PROJECT,
        { sleepFn: noSleep },
      );
      expect(result).toEqual({ models: [] });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent).toEqual([
      { url: "/api/backends/opencode/models", method: "POST", body: PROJECT },
      { url: "/api/backends/opencode/models", method: "POST", body: PROJECT },
    ]);
  });

  it("reports a slow first attempt before that request settles", async () => {
    let finishFetch!: (result: { models: never[] }) => void;
    let settled = false;
    let starting = false;
    const request = fetchBackendModels(
      "/api/backends/opencode/models",
      PROJECT,
      {
        fetchFn: () =>
          new Promise((resolve) => {
            finishFetch = resolve;
          }),
        startingDelayMs: 5,
        onStarting: () => {
          starting = true;
        },
      },
    ).finally(() => {
      settled = true;
    });

    await Bun.sleep(20);
    expect(starting).toBe(true);
    expect(settled).toBe(false);
    finishFetch({ models: [] });
    await request;
  });

  it("retries transport failures and then succeeds", async () => {
    let attempts = 0;
    let retries = 0;
    const result = await fetchBackendModels(
      "/api/backends/opencode/models",
      PROJECT,
      {
        fetchFn: async () => {
          attempts++;
          if (attempts < 3) throw new TypeError("network failed");
          return { models: [] };
        },
        sleepFn: noSleep,
        onStarting: () => retries++,
      },
    );

    expect(result).toEqual({ models: [] });
    expect(attempts).toBe(3);
    expect(retries).toBe(2);
  });

  it("retries 5xx responses and gives up after the bounded attempts", async () => {
    let attempts = 0;
    expect(
      fetchBackendModels("/api/backends/opencode/models", PROJECT, {
        fetchFn: async () => {
          attempts++;
          throw new ApiError(502, "http_502", "Bad gateway");
        },
        sleepFn: noSleep,
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(attempts).toBe(3);
  });

  it("does not retry an authentication failure", async () => {
    let attempts = 0;
    const result = await fetchBackendModels(
      "/api/backends/opencode/models",
      PROJECT,
      {
        fetchFn: async () => {
          attempts++;
          return { models: [], error: "Sign in", authError: true };
        },
        sleepFn: noSleep,
      },
    );

    expect(result.authError).toBe(true);
    expect(attempts).toBe(1);
  });

  it("does not retry a non-server HTTP failure", async () => {
    let attempts = 0;
    expect(
      fetchBackendModels("/api/backends/opencode/models", PROJECT, {
        fetchFn: async () => {
          attempts++;
          throw new ApiError(403, "forbidden", "Forbidden");
        },
        sleepFn: noSleep,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(1);
  });
});

describe("modelListErrorMessage", () => {
  const english = translatorFor("en");
  const catalan = translatorFor("ca");

  it("names the login that is missing when the failure is an auth one", () => {
    const authError = { message: "", authError: true };
    expect(modelListErrorMessage(english, true, authError)).toBe(
      english.t("common.model.openCodeListFailed"),
    );
    expect(modelListErrorMessage(english, false, authError)).toBe(
      english.t("common.model.codexNotSignedIn"),
    );
  });

  it("carries the backend's own message as an untranslated detail", () => {
    expect(
      modelListErrorMessage(english, true, {
        message: "connect ECONNREFUSED",
        authError: false,
      }),
    ).toBe(
      english.t("common.model.openCodeLoadFailed", {
        detail: " (connect ECONNREFUSED)",
      }),
    );
    expect(
      modelListErrorMessage(catalan, true, {
        message: "connect ECONNREFUSED",
        authError: false,
      }),
    ).toBe(
      catalan.t("common.model.openCodeLoadFailed", {
        detail: " (connect ECONNREFUSED)",
      }),
    );
  });

  it("drops the parentheses when the backend said nothing", () => {
    expect(
      modelListErrorMessage(english, false, {
        message: "  ",
        authError: false,
      }),
    ).toBe(english.t("common.model.listLoadFailed", { detail: "" }));
  });
});

describe("effortPickerOptions", () => {
  const levels = (options: { level: string }[]) =>
    options.map((option) => option.level);
  const model = (id: string, efforts: string[]): BackendModelWire => ({
    id,
    label: id,
    isDefault: false,
    hidden: false,
    supportedEfforts: efforts.map((level) => ({ level })),
  });

  it("offers the Claude family levels from effortLevelsFor", () => {
    for (const family of ["opus", "fable", "sonnet", "haiku"]) {
      expect(levels(effortPickerOptions("claude", family, null))).toEqual(
        levels(effortLevelsFor("claude", family)),
      );
    }
  });

  it("offers no level for a limited Claude family", () => {
    expect(effortPickerOptions("claude", "haiku", null, ["haiku"])).toEqual([]);
    expect(
      levels(effortPickerOptions("claude", "opus", null, ["haiku"])),
    ).toEqual(levels(effortLevelsFor("claude", "opus")));
  });

  it("offers the selected OpenCode model's levels, or none", () => {
    const models = [model("p/a", ["low", "high"]), model("p/b", [])];
    expect(levels(effortPickerOptions("opencode", "p/a", models))).toEqual([
      "low",
      "high",
    ]);
    expect(effortPickerOptions("opencode", "p/b", models)).toEqual([]);
    expect(effortPickerOptions("opencode", "p/a", null)).toEqual([]);
  });

  it("offers the Codex model's levels, else the static fallback", () => {
    const models = [model("gpt-x", ["low", "ultra"]), model("gpt-y", [])];
    expect(levels(effortPickerOptions("codex", "gpt-x", models))).toEqual([
      "low",
      "ultra",
    ]);
    const fallback = levels(effortPickerOptions("codex", "gpt-y", models));
    expect(fallback).toEqual(
      levels(effortPickerOptions("codex", "gpt-y", null)),
    );
    expect(fallback).toContain("minimal");
    expect(fallback).not.toContain("max");
    expect(fallback).not.toContain("ultra");
  });
});

describe("defaultBackendModel", () => {
  const model = (
    id: string,
    extra: Partial<BackendModelWire> = {},
  ): BackendModelWire => ({ id, label: id, supportedEfforts: [], ...extra });
  const first = model("first/model");
  const reported = model("reported/model", { isDefault: true });
  const muse = model("opencode/muse-spark-1.2-contributor-free", {
    isFree: true,
  });

  it("prefers Muse Spark for OpenCode and falls back for a login without it", () => {
    const spare = model("spare/model");
    expect(defaultBackendModel([first, spare, reported, muse], false)?.id).toBe(
      muse.id,
    );
    expect(defaultBackendModel([first, reported], false)?.id).toBe(reported.id);
    expect(defaultBackendModel([first], false)?.id).toBe(first.id);
  });

  // The rest of the Codex order is codexDefaultModel's (shared/types.test.ts).
  it("follows the Codex-reported default, not the OpenCode preference", () => {
    expect(defaultBackendModel([first, muse, reported], true)?.id).toBe(
      reported.id,
    );
  });
});

describe("selectSupportedEffort", () => {
  const options = (...levels: string[]) => levels.map((level) => ({ level }));

  it("keeps a supported effort, then prefers high, then the first level the model lists", () => {
    expect(
      selectSupportedEffort("medium", options("low", "medium", "high")),
    ).toBe("medium");
    expect(
      selectSupportedEffort("xhigh", options("low", "medium", "high")),
    ).toBe("high");
    expect(selectSupportedEffort("xhigh", options("medium", "low"))).toBe(
      "medium",
    );
    expect(selectSupportedEffort("xhigh", [])).toBeUndefined();
  });
});

describe("openCodeModelSelectionReady", () => {
  const models: BackendModelWire[] = [
    { id: "gate/model", label: "Gate model", supportedEfforts: [] },
    {
      id: "gate/hidden",
      label: "Hidden model",
      hidden: true,
      supportedEfforts: [],
    },
  ];

  it("needs a model the loaded catalog shows, and trusts the stored one until a catalog loads", () => {
    type Row = [string, string, boolean, BackendModelWire[] | null, boolean];
    const rows: Row[] = [
      ["no model", "", false, null, false],
      ["listed", "gate/model", false, models, true],
      ["not listed", "retired/model", false, models, false],
      ["hidden", "gate/hidden", false, models, false],
      // Still loading, or discovery failed: nothing to check against.
      ["no catalog", "retired/model", false, null, true],
    ];
    for (const [row, modelFamily, loading, catalog, ready] of rows) {
      expect({
        row,
        ready: openCodeModelSelectionReady(modelFamily, loading, catalog),
      }).toEqual({ row, ready });
    }
  });
});

describe("partitionBackendModelsForPicker", () => {
  it("preserves Free, Pay-as-you-go, and Subscription membership and order", () => {
    const free: BackendModelWire = {
      id: "opencode/big-pickle",
      label: "Big Pickle",
      isFree: true,
      supportedEfforts: [],
    };
    const secondFree: BackendModelWire = {
      id: "opencode/gpt-5-nano",
      label: "GPT-5 Nano",
      isFree: true,
      supportedEfforts: [],
    };
    const paid: BackendModelWire = {
      id: "opencode/kimi-k3",
      label: "Kimi K3",
      supportedEfforts: [],
    };
    const go: BackendModelWire = {
      id: "opencode-go/kimi-k3",
      label: "Kimi K3",
      supportedEfforts: [],
    };
    expect(
      partitionBackendModelsForPicker([go, free, paid, secondFree], true),
    ).toEqual({
      available: [paid],
      free: [free, secondFree],
      subscription: [go],
    });
  });
});
