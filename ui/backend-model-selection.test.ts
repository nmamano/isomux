import { describe, expect, it } from "bun:test";
import { ApiError } from "./api.ts";
import {
  fetchBackendModels,
  modelListErrorMessage,
} from "./backend-model-selection.ts";
import { translatorFor } from "../shared/i18n/translate.ts";

const noSleep = async () => {};

describe("fetchBackendModels", () => {
  it("reports a slow first attempt before that request settles", async () => {
    let finishFetch!: (result: { models: never[] }) => void;
    let settled = false;
    let starting = false;
    const request = fetchBackendModels("/api/backends/opencode/models", {
      fetchFn: () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        }),
      startingDelayMs: 5,
      onStarting: () => {
        starting = true;
      },
    }).finally(() => {
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
    const result = await fetchBackendModels("/api/backends/opencode/models", {
      fetchFn: async () => {
        attempts++;
        if (attempts < 3) throw new TypeError("network failed");
        return { models: [] };
      },
      sleepFn: noSleep,
      onStarting: () => retries++,
    });

    expect(result).toEqual({ models: [] });
    expect(attempts).toBe(3);
    expect(retries).toBe(2);
  });

  it("retries 5xx responses and gives up after the bounded attempts", async () => {
    let attempts = 0;
    expect(
      fetchBackendModels("/api/backends/opencode/models", {
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
    const result = await fetchBackendModels("/api/backends/opencode/models", {
      fetchFn: async () => {
        attempts++;
        return { models: [], error: "Sign in", authError: true };
      },
      sleepFn: noSleep,
    });

    expect(result.authError).toBe(true);
    expect(attempts).toBe(1);
  });

  it("does not retry a non-server HTTP failure", async () => {
    let attempts = 0;
    expect(
      fetchBackendModels("/api/backends/opencode/models", {
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
