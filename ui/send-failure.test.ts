// The text a send failure shows (task f1304a60): the Enterprise Contract lock
// reads in the member's language, any other refusal as the server wrote it.
import { describe, expect, it } from "bun:test";
import { ENTERPRISE_HELP_EMAIL, sendFailureText } from "./send-failure.ts";
import { ApiError } from "./api.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import { SUPPORTED_LANGUAGES } from "../shared/languages.ts";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withData } from "./components/Data.tsx";
import { sendFailureNode } from "./send-failure-node.tsx";

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

// Task 419dcb70: a value inside a sentence held as a string renders as Data.
// Each Data span reads as [value] here.
const shown = (node: ReactNode) =>
  renderToStaticMarkup(createElement(Fragment, null, node)).replace(
    /<span data-integrations-data=""[^>]*>(.*?)<\/span>/g,
    "[$1]",
  );

describe("withData", () => {
  it("wraps each occurrence of each value, and leaves the rest as text", () => {
    const cases: [string, string[], string][] = [
      ["No value here.", [], "No value here."],
      ["Write to a@b.io today.", ["a@b.io"], "Write to [a@b.io] today."],
      ["a@b.io or a@b.io", ["a@b.io"], "[a@b.io] or [a@b.io]"],
      ["Nothing to mark.", ["a@b.io"], "Nothing to mark."],
      ["From x to y.", ["x", "y"], "From [x] to [y]."],
      // The value is text, not a pattern: "." matches only a dot.
      ["aXb or a.b", ["a.b"], "aXb or [a.b]"],
      // An empty value marks nothing.
      ["abc", [""], "abc"],
    ];
    for (const [text, values, want] of cases)
      expect([text, shown(withData(text, values))]).toEqual([text, want]);
  });
});

describe("sendFailureNode", () => {
  it("shows the help email as a value in the lock, in each language", () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      const text = sendFailureText(translatorFor(code).t, locked);
      const html = shown(sendFailureNode(text));
      expect([code, html.split(`[${ENTERPRISE_HELP_EMAIL}]`).length]).toEqual([
        code,
        2,
      ]);
    }
  });

  it("shows any other refusal as plain text", () => {
    expect(shown(sendFailureNode("No seat left."))).toBe("No seat left.");
  });
});
