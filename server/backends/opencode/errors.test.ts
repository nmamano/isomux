import { expect, it, spyOn } from "bun:test";
import { Lexer, defaults } from "marked";
import { translatorFor } from "../../../shared/i18n/translate.ts";
import {
  logOpenCodeError,
  logOpenCodeStreamSilence,
  openCodeErrorMessage,
  openCodeProviderRefusal,
  openCodeRetryMessage,
  PROVIDER_TEXT_LIMIT,
  providerText,
} from "./errors.ts";
import type { OpenCodeStreamSilence } from "./transport.ts";

it("gives errors a cause without copying provider text", () => {
  for (const [error, cause] of [
    [{ name: "ContextOverflowError" }, /conversation.*long/i],
    [{ name: "APIError", statusCode: 429 }, /rate limit.*429/i],
    [{ name: "APIError", statusCode: 503 }, /HTTP 503/],
    [{ name: "APIError", message: "Header timeout SECRET_CANARY" }, /time/i],
    [
      { name: "APIError", message: "Connection reset by server SECRET_CANARY" },
      /connection/i,
    ],
    [
      { name: "UnknownError", message: 'Agent not found: "SECRET_CANARY"' },
      /configuration/i,
    ],
    [{ name: "UnknownError", message: "SECRET_CANARY" }, /OpenCode.*turn/i],
    [
      { name: "NewUnknownEvent", message: "SECRET_CANARY" },
      /provider or transport/i,
    ],
  ] as const) {
    const copy = openCodeErrorMessage(error);
    expect(copy).toMatch(cause);
    expect(copy).not.toContain("SECRET_CANARY");
  }
});

it("logs reviewed cause fields with secrets redacted", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    logOpenCodeError({
      name: "APIError",
      statusCode: 503,
      isRetryable: true,
      message:
        "Bearer bearer-canary https://user:pass-canary@example.com/?token=url-canary sk-abcdefghijklmnopqrstuvwxyz123456",
    });
    const output = JSON.stringify(logged.mock.calls);
    for (const secret of [
      "bearer-canary",
      "pass-canary",
      "url-canary",
      "abcdefghijklmnopqrstuvwxyz123456",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("APIError");
    expect(output).toContain("503");
    expect(output).toContain("isRetryable");
  } finally {
    logged.mockRestore();
  }
});

it("logs the agent, the failure and OpenCode's log next to the cause", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    logOpenCodeError(
      { name: "Error" },
      {
        agentId: "agent-1",
        failure: "failure text",
        step: "begin_turn",
        openCodeLog: "/profile/opencode.log",
      },
    );
    expect(logged.mock.calls).toHaveLength(1);
    const [tag, line] = logged.mock.calls[0] as [string, string];
    expect(tag).toBe("[opencode]");
    expect(JSON.parse(line)).toEqual({
      agentId: "agent-1",
      name: "Error",
      failure: "failure text",
      step: "begin_turn",
      openCodeLog: "/profile/opencode.log",
    });
  } finally {
    logged.mockRestore();
  }
});

// Task 430d7bfd: one line per silent stream, in the same journal as a
// failure.
it("logs a stream silence as one tagged line with its fields", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const silence: OpenCodeStreamSilence = {
      agentId: "agent-1",
      sessionId: "ses_1",
      silence: 1,
      deadlineAt: "2026-10-17T00:46:30.000Z",
      lastEvent: { type: "server.heartbeat", at: "2026-10-17T00:46:00.000Z" },
      waitingOn: "tool",
      tools: ["bash"],
      probe: "healthy",
      outcome: "recovered",
      openCodeLog: "/profile/opencode.log",
    };
    logOpenCodeStreamSilence(silence);
    expect(logged.mock.calls).toHaveLength(1);
    const [tag, line] = logged.mock.calls[0] as [string, string];
    expect(tag).toBe("[opencode]");
    expect(JSON.parse(line)).toEqual({
      event: "event_stream_silent",
      ...silence,
    });
  } finally {
    logged.mockRestore();
  }
});

// Observed from OpenCode Zen on 2026-10-17, as a 403 APIError.
const FREE_TIER_REFUSAL =
  "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";

// Task 1a963907: a refusal names the provider and quotes its message.
it("quotes a provider refusal and names the provider", () => {
  for (const error of [
    { name: "APIError", statusCode: 403, message: FREE_TIER_REFUSAL },
    { name: "APIError", statusCode: 400, message: FREE_TIER_REFUSAL },
    { name: "APIError", statusCode: 429, message: FREE_TIER_REFUSAL },
    { name: "APIError", message: `rate limit: ${FREE_TIER_REFUSAL}` },
    { name: "APIError", message: `Quota exceeded. ${FREE_TIER_REFUSAL}` },
  ]) {
    const copy = openCodeProviderRefusal(error, "opencode");
    expect(copy).toContain("`opencode`");
    expect(copy).toContain(`${FREE_TIER_REFUSAL}"`);
  }
});

it("leaves failures that are not a provider refusal to the generic copy", () => {
  for (const error of [
    { name: "APIError", statusCode: 403 },
    { name: "APIError", statusCode: 403, message: " \n\t " },
    { name: "APIError", statusCode: 401, message: FREE_TIER_REFUSAL },
    { name: "APIError", statusCode: 503, message: FREE_TIER_REFUSAL },
    { name: "APIError", message: FREE_TIER_REFUSAL },
    { name: "UnknownError", statusCode: 403, message: FREE_TIER_REFUSAL },
  ]) {
    expect(openCodeProviderRefusal(error, "opencode")).toBeNull();
  }
});

it("bounds provider text to one redacted line", () => {
  const secrets = [
    "Bearer bearer-canary",
    "https://user:pass-canary@example.com/x",
    "https://example.com/?token=url-canary",
    "sk-abcdefghijklmnopqrstuvwxyz123456",
  ];
  const message = `denied\n\n  ${secrets.join("\t")}\u001b[31m end`;
  const text = providerText(message)!;
  for (const secret of [
    "bearer-canary",
    "pass-canary",
    "url-canary",
    "abcdefghijklmnopqrstuvwxyz123456",
  ])
    expect(text).not.toContain(secret);
  expect(text).toStartWith("denied Bearer ");
  expect(text).toEndWith("[31m end");
  // eslint-disable-next-line no-control-regex
  expect(text).not.toMatch(/[\u0000-\u001f\u007f]|\s\s/);
  const copy = openCodeProviderRefusal(
    { name: "APIError", statusCode: 403, message },
    "opencode",
  );
  expect(copy).toContain(text);
});

it("cuts long provider text after redacting it", () => {
  const long = "x".repeat(PROVIDER_TEXT_LIMIT * 2);
  const text = providerText(long)!;
  expect(text).toHaveLength(PROVIDER_TEXT_LIMIT);
  expect(text).toEndWith("…");
  // A key across the cut is redacted whole; cutting first would leave a
  // prefix too short for the pattern to match.
  const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const straddling = providerText(
    `${"y".repeat(PROVIDER_TEXT_LIMIT - 12)} ${key}`,
  )!;
  expect(straddling).not.toContain(key.slice(0, 9));
  expect(straddling.length).toBeLessThanOrEqual(PROVIDER_TEXT_LIMIT);
  // The cut counts code points: no lone surrogate renders as U+FFFD.
  const emoji = providerText("😀".repeat(PROVIDER_TEXT_LIMIT))!;
  expect(emoji.isWellFormed()).toBe(true);
  expect(Array.from(emoji)).toHaveLength(PROVIDER_TEXT_LIMIT);
  expect(emoji).toStartWith("😀");
});

// Inside a quote, a direction override reverses the rest of the line on
// screen, Isomux's own words included.
it("drops direction and zero-width format characters", () => {
  const formats = [
    ...range(0x200b, 0x200f),
    ...range(0x202a, 0x202e),
    ...range(0x2066, 0x2069),
  ];
  for (const code of formats) {
    const text = providerText(`denied${String.fromCodePoint(code)}here`)!;
    expect(text.codePointAt(6)).toBe(0x20);
    expect(text).toHaveLength("denied here".length);
  }
});

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

// The chat renders a system line through InlineMarkdown, which lexes it this
// way and shows an escape as its text and every other token as its source.
function inlineTokens(line: string) {
  return Lexer.lexInline(line, { ...defaults, gfm: true, breaks: false });
}

it("keeps provider markdown inert in the retry line", () => {
  const message =
    "Retry later. [Isomux support: re-enter your key here](https://evil.example/login) **urgent** _now_ `code` ~~old~~ <b>x</b> ![i](https://e.x/i.png) mail ops@evil.example or www.evil.example, C:\\temp https://opencode.ai/workspace/wrk_01/go";
  const line = openCodeRetryMessage(message, 1, "opencode");
  const start = line.indexOf('"') + 1;
  const quoted = line.slice(start, line.lastIndexOf('"'));
  const tokens = inlineTokens(quoted);
  expect(
    tokens
      .map((token) => token.type)
      .filter((type) => type !== "text" && type !== "escape"),
  ).toEqual([]);
  const shown = tokens
    .map((token) => (token.type === "escape" ? token.text : token.raw))
    .join("");
  expect(shown).toBe(message);
  // The whole line lexes with no provider-made link, emphasis or code.
  for (const token of inlineTokens(line))
    expect(["link", "strong", "em", "del", "html"]).not.toContain(token.type);
});

it("words a refusal in the reader's language", () => {
  const error = {
    name: "APIError",
    statusCode: 403,
    message: FREE_TIER_REFUSAL,
  };
  const english = openCodeProviderRefusal(error, "opencode");
  const spanish = openCodeProviderRefusal(
    error,
    "opencode",
    translatorFor("es").t,
  );
  expect(spanish).toContain(FREE_TIER_REFUSAL);
  expect(spanish).toContain("`opencode`");
  expect(spanish).not.toBe(english);
});

it("quotes the provider's retry message with the provider and attempt", () => {
  for (const message of [
    "Free usage exceeded, subscribe to Go",
    "HTTP 503 Service Unavailable",
  ]) {
    const copy = openCodeRetryMessage(message, 2, "opencode");
    expect(copy).toContain("`opencode`");
    expect(copy).toContain(`"${message}"`);
    expect(copy).toMatch(/\b2\b.*\b5\b/);
  }
  const redacted = openCodeRetryMessage(
    "rate limit sk-abcdefghijklmnopqrstuvwxyz123456",
    1,
    "opencode",
  );
  expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
});

it("keeps the generic retry line when OpenCode sends no message", () => {
  for (const message of [undefined, "", "  "]) {
    const copy = openCodeRetryMessage(message, 3, "opencode");
    expect(copy).toMatch(/provider/i);
    expect(copy).not.toContain("`opencode`");
    expect(copy).toMatch(/retrying 3 of 5/);
  }
});
