import { describe, expect, it } from "bun:test";
import {
  resolveAgentEngineSettings,
  validateCodexSandbox,
} from "./agent-validators.ts";

describe("validateCodexSandbox", () => {
  it("leaves an absent raw value undefined for non-agent consumers", () => {
    expect(validateCodexSandbox(undefined)).toBeUndefined();
    expect(
      validateCodexSandbox(
        "garbage" as Parameters<typeof validateCodexSandbox>[0],
      ),
    ).toBeUndefined();
  });
});

describe("resolveAgentEngineSettings", () => {
  it("applies backend defaults without giving Claude a sandbox", () => {
    expect(resolveAgentEngineSettings("codex", {})).toMatchObject({
      permissionMode: "never",
      codexSandbox: "danger-full-access",
    });
    expect(resolveAgentEngineSettings("claude", {})).toMatchObject({
      permissionMode: "auto",
      codexSandbox: undefined,
    });
  });

  it("preserves an explicit valid Codex choice and fills only absent values", () => {
    expect(
      resolveAgentEngineSettings("codex", {
        permissionMode: "on-request",
      }),
    ).toMatchObject({
      permissionMode: "on-request",
      codexSandbox: "danger-full-access",
    });
  });

  it("is idempotent", () => {
    const once = resolveAgentEngineSettings("codex", {});
    expect(resolveAgentEngineSettings("codex", once)).toEqual(once);
  });
});
