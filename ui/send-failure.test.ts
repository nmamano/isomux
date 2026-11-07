// The text a send failure shows (task f1304a60): the Enterprise Contract lock
// reads in the member's language, any other refusal as the server wrote it.
import { describe, expect, it } from "bun:test";
import { ENTERPRISE_HELP_EMAIL, sendFailureText } from "./send-failure.ts";
import { ApiError } from "./api.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import { SUPPORTED_LANGUAGES } from "../shared/languages.ts";

// The server's English text for the lock.
const SERVER_TEXT = "This office is marked as an Enterprise office.";
const locked = new ApiError(409, "enterprise_secret_needed", SERVER_TEXT);

describe("sendFailureText", () => {
  it("shows the lock in each language, from the catalog", () => {
    const lines = SUPPORTED_LANGUAGES.map(({ code }) =>
      sendFailureText(translatorFor(code).t, locked),
    );
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toBe(SERVER_TEXT);
      // Not a key that is missing from the catalog.
      expect(line).not.toMatch(/^[\w.]+$/);
      // IT is told where to write, with no placeholder left.
      expect(line).toContain(ENTERPRISE_HELP_EMAIL);
      expect(line).not.toContain("{");
    }
    // Each language has its own line.
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("shows any other refusal as the server wrote it", () => {
    const { t } = translatorFor("en");
    expect(
      sendFailureText(t, new ApiError(429, "queue_full", "queue_full")),
    ).toBe("queue_full");
    expect(
      sendFailureText(t, new ApiError(409, "seats_full", "No seat left.")),
    ).toBe("No seat left.");
    // An outbox record from before the code was kept has no code.
    expect(sendFailureText(t, { message: "Agent stopped." })).toBe(
      "Agent stopped.",
    );
  });
});
