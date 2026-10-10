import { expect, it, spyOn } from "bun:test";
import { logOpenCodeError, openCodeErrorMessage, openCodeRetryMessage } from "./errors.ts";

it("gives errors a cause without copying provider text", () => {
  for (const [error, cause] of [
    [{ name: "ContextOverflowError" }, /conversation.*long/i],
    [{ name: "APIError", statusCode: 429 }, /rate limit.*429/i],
    [{ name: "APIError", statusCode: 503 }, /HTTP 503/],
    [{ name: "APIError", message: "Header timeout SECRET_CANARY" }, /time/i],
    [{ name: "APIError", message: "Connection reset by server SECRET_CANARY" }, /connection/i],
    [{ name: "UnknownError", message: 'Agent not found: "SECRET_CANARY"' }, /configuration/i],
    [{ name: "UnknownError", message: "SECRET_CANARY" }, /OpenCode.*turn/i],
    [{ name: "NewUnknownEvent", message: "SECRET_CANARY" }, /provider or transport/i],
  ] as const) {
    const copy = openCodeErrorMessage(error);
    expect(copy).toMatch(cause);
    expect(copy).not.toContain("SECRET_CANARY");
  }
});

it("logs reviewed cause fields with secrets redacted", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    logOpenCodeError({ name: "APIError", statusCode: 503, isRetryable: true,
      message: "Bearer bearer-canary https://user:pass-canary@example.com/?token=url-canary sk-abcdefghijklmnopqrstuvwxyz123456" });
    const output = JSON.stringify(logged.mock.calls);
    for (const secret of ["bearer-canary", "pass-canary", "url-canary", "abcdefghijklmnopqrstuvwxyz123456"])
      expect(output).not.toContain(secret);
    expect(output).toContain("APIError");
    expect(output).toContain("503");
    expect(output).toContain("isRetryable");
  } finally { logged.mockRestore(); }
});

for (const [label, message, cause] of [
  ["timeout", "SSE read timed out SECRET_CANARY", /time/i],
  ["network", "Connection reset by server SECRET_CANARY", /connection/i],
  ["HTTP status", "HTTP 503 SECRET_CANARY", /503/],
  ["rate limit", "rate limit SECRET_CANARY", /rate limit/i],
  ["overloaded", "overloaded SECRET_CANARY", /busy/i],
  ["unknown", "SECRET_CANARY", /provider/i],
] as const) {
  it(`shows a reviewed ${label} retry cause and bounded attempt`, () => {
    const copy = openCodeRetryMessage(message, 2);
    expect(copy).toMatch(cause);
    expect(copy).toMatch(/retrying 2 of 5/);
    expect(copy).not.toContain("SECRET_CANARY");
  });
}
