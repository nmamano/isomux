import { describe, expect, it } from "bun:test";
import { isAuthenticationError, parseAllowedEvent } from "./transport.ts";
import { writeSafeContractFixture } from "./contract-fixture.ts";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expectRejection } from "../../test-support/expect-rejection.ts";

describe("OpenCode OC1 raw-ingress allowlist", () => {
  it("keeps only text shape and drops provider fields before normalization", () => {
    const canary = "PROVIDER_SECRET_CANARY";
    const parsed = parseAllowedEvent(
      JSON.stringify({
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: { type: "text", id: "part-1", messageID: "message-1", text: "safe" },
          responseHeaders: { "x-provider-secret": canary },
        },
      }),
    );
    expect(parsed).toEqual({
      kind: "text",
      sessionId: "session-1",
      messageId: "message-1",
      partId: "part-1",
      text: "safe",
    });
    expect(JSON.stringify(parsed)).not.toContain(canary);
  });

  it("keeps only the reviewed provider error fields", () => {
    const canary = "PROVIDER_SECRET_CANARY";
    const parsed = parseAllowedEvent(
      JSON.stringify({
        type: "session.error",
        properties: {
          sessionID: "session-1",
          error: {
            name: "APIError",
            data: {
              message: "invalid credential",
              statusCode: 401,
              isRetryable: false,
              responseHeaders: { "x-provider-secret": canary },
              responseBody: canary,
              metadata: { url: canary },
              futureField: canary,
            },
          },
        },
      }),
    );
    expect(parsed).toEqual({
      kind: "error",
      sessionId: "session-1",
      error: {
        name: "APIError",
        message: "invalid credential",
        statusCode: 401,
        isRetryable: false,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain(canary);
  });

  it("classifies only observed structured authentication failures", () => {
    expect(
      isAuthenticationError(
        { name: "APIError", message: "invalid credential", statusCode: 401, isRetryable: false },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(true);
    expect(
      isAuthenticationError(
        {
          name: "UnknownError",
          message: "Model not found: openai/gpt-4o. Did you mean: gpt-4o, gpt-4o-mini?",
        },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(true);
    expect(
      isAuthenticationError(
        { name: "UnknownError", message: "Model not found: openai/typo. Did you mean: gpt-4o?" },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(false);
    expect(
      isAuthenticationError(
        { name: "APIError", message: "provider unavailable", statusCode: 500, isRetryable: true },
        "openai/gpt-4o",
        [],
      ),
    ).toBe(false);
    expect(
      isAuthenticationError(
        {
          name: "UnknownError",
          message: "Model not found: opencode/fake. Did you mean: fake?",
        },
        "opencode/fake",
        ["opencode"],
      ),
    ).toBe(false);
  });

  it("refuses to record a credential-shaped fixture before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-fixture-"));
    const path = join(root, "fixture.json");
    await expectRejection(
      writeSafeContractFixture(path, ["authorization: Bearer secret-canary"]),
      /Refusing to write/,
    );
    expect(await Bun.file(path).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps committed OC1 fixtures free of credential-shaped values", async () => {
    for await (const name of new Bun.Glob("fixtures/**/*").scan(import.meta.dir)) {
      const text = await Bun.file(join(import.meta.dir, name)).text();
      expect(text).not.toMatch(
        /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|bearer\s+[a-z0-9._~-]+)/i,
      );
    }
  });
});
