import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import * as scanner from "../log-redaction.ts";
import {
  appendLog,
  loadLog,
  loadSessionsMap,
  prepareLogEntry,
} from "../persistence.ts";
import { appendRunLog, loadRunLog } from "../cronjob-persistence.ts";
import type { LogEntry } from "../../shared/types.ts";
import {
  msg,
  renderLogText,
  type LogPart,
} from "../../shared/i18n/log-message.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";

const english = translatorFor("en");

const secret = "sk-proj-" + "Q".repeat(24);
const safe = "sk-proj-...REDACTED";
function entry(): LogEntry {
  return {
    id: "log-redaction",
    agentId: "redaction-agent",
    timestamp: 1,
    kind: "user_message",
    content: secret,
    metadata: { nested: [{ value: secret }] },
  };
}

it("redacts direct agent appends and session previews, without rewriting history", () => {
  const dir = join(STATE_ROOT, "logs", "redaction-agent");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "redaction-session.jsonl");
  const historical = JSON.stringify({ ...entry(), id: "old" }) + "\n";
  writeFileSync(file, historical);
  appendLog("redaction-agent", "redaction-session", entry());
  expect(readFileSync(file, "utf8").startsWith(historical)).toBe(true);
  const logs = loadLog("redaction-agent", "redaction-session");
  expect(logs[0].content).toBe(secret);
  expect(logs[1]).toEqual({
    ...entry(),
    content: safe,
    metadata: { nested: [{ value: safe }] },
  });
  expect(JSON.stringify(loadSessionsMap("redaction-agent"))).not.toContain(
    secret,
  );
  expect(JSON.stringify(loadSessionsMap("redaction-agent"))).toContain(safe);
});

it("redacts direct scheduled-run transcript appends", () => {
  appendRunLog("redaction-job", "redaction-run", "redaction-session", entry());
  const raw = readFileSync(
    join(
      STATE_ROOT,
      "cronjobs",
      "redaction-job",
      "redaction-run",
      "redaction-session.jsonl",
    ),
    "utf8",
  );
  expect(raw).not.toContain(secret);
  expect(raw).toContain(safe);
  expect(
    loadRunLog("redaction-job", "redaction-run", "redaction-session"),
  ).toEqual([
    { ...entry(), content: safe, metadata: { nested: [{ value: safe }] } },
  ]);
});

it("keeps the original entry after scanner failure and emits one fixed diagnostic line", () => {
  for (const cron of [false, true]) {
    let reads = 0;
    const input = entry();
    input.metadata = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        if (reads++ === 0) throw new Error(secret);
        return "original";
      },
    });
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      if (cron)
        appendRunLog("redaction-job", "failure-run", "failure-session", input);
      else appendLog("redaction-agent", "failure-session", input);
      const logs = cron
        ? loadRunLog("redaction-job", "failure-run", "failure-session")
        : loadLog("redaction-agent", "failure-session");
      expect(logs[0].content).toBe(secret);
      expect(logs[0].metadata).toEqual({ value: "original" });
      expect(diagnostic.mock.calls).toEqual([
        [
          "Log secret redaction failed; keeping original entry.",
          input.id,
          input.kind,
        ],
      ]);
    } finally {
      diagnostic.mockRestore();
    }
  }
});

it("redacts the motivating systemd tool result in the actual JSONL file", () => {
  const anthropic = "sk-ant-api03-" + "Z".repeat(24);
  const input = {
    ...entry(),
    kind: "tool_result" as const,
    content:
      '[Service]\nEnvironment="OPENAI_API_KEY=' +
      secret +
      '"\nEnvironment="ANTHROPIC_API_KEY=' +
      anthropic +
      '"',
  };
  appendLog("redaction-agent", "systemd-session", input);
  const raw = readFileSync(
    join(STATE_ROOT, "logs", "redaction-agent", "systemd-session.jsonl"),
    "utf8",
  );
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain(anthropic);
  expect(JSON.parse(raw).content).toBe(
    '[Service]\nEnvironment="OPENAI_API_KEY=sk-proj-...REDACTED"\nEnvironment="ANTHROPIC_API_KEY=sk-ant-a...REDACTED"',
  );
});

it("scans a prepared entry only once across repeated agent and cron appends", () => {
  for (const content of [secret, "ordinary output"]) {
    const scan = spyOn(scanner, "redactLogEntry");
    try {
      const original = { ...entry(), content };
      const prepared = prepareLogEntry(original);
      expect(prepared).not.toBe(original);
      const session = content === secret ? "memo-secret" : "memo-plain";
      appendLog("redaction-agent", session, prepared);
      appendLog("redaction-agent", session, prepared);
      appendRunLog("redaction-job", "memo-run", session, prepared);
      appendRunLog("redaction-job", "memo-run", session, prepared);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(loadLog("redaction-agent", session)).toEqual([prepared, prepared]);
      expect(loadRunLog("redaction-job", "memo-run", session)).toEqual([
        prepared,
        prepared,
      ]);
      // Producer-owned input is not memoized and can safely change later.
      original.content = "sk-" + "V".repeat(24);
      appendLog("redaction-agent", session, original);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(loadLog("redaction-agent", session)[2].content).toBe(
        "sk-VVVVV...REDACTED",
      );
    } finally {
      scan.mockRestore();
    }
  }
});

// A server-written line carries its values as `message` params next to the
// English content (task c37a7365). The params are redacted like every other
// string, and the message is kept only when every language's render of the
// redacted parts is itself clean: a translated template can put a label
// ("secret:") next to a value where English has none.
describe("an entry's message keys", () => {
  const systemEntry = (content: string, message: LogPart[]): LogEntry => ({
    id: "log-message-redaction",
    agentId: "redaction-agent",
    timestamp: 1,
    kind: "system",
    content,
    message,
  });

  it("redacts a secret in a message value and keeps the message", () => {
    const parts = [msg("systemEntries.pathRefusal.notFound", { path: secret })];
    const input = systemEntry(renderLogText(english, parts), parts);
    appendLog("redaction-agent", "message-session", input);
    const raw = readFileSync(
      join(STATE_ROOT, "logs", "redaction-agent", "message-session.jsonl"),
      "utf8",
    );
    expect(raw).not.toContain(secret);
    const [stored] = loadLog("redaction-agent", "message-session");
    const safeParts = [
      msg("systemEntries.pathRefusal.notFound", { path: safe }),
    ];
    expect(stored.content).toBe(renderLogText(english, safeParts));
    expect(stored.message).toEqual(safeParts);
  });

  it("drops the message when one language's render shows a secret shape English does not", () => {
    // A name that is no secret on its own, but follows "secret:" in Catalan.
    const name = "OPENAI_API_KEY_PROD_1";
    const KEY = "cards.secretRequest.title" as const;
    // The ENABLING CONDITIONS: English is clean, so a check of English alone
    // keeps the message; Catalan is not.
    const englishText = translatorFor("en").t(KEY, { name });
    expect(scanner.redactSecretText(englishText)).toBe(englishText);
    const catalan = translatorFor("ca").t(KEY, { name });
    expect(scanner.redactSecretText(catalan)).not.toBe(catalan);

    const parts = [msg(KEY, { name })];
    const prepared = prepareLogEntry(systemEntry(englishText, parts));
    expect(prepared.content).toBe(englishText);
    expect(prepared.message).toBeUndefined();
  });
});

// The /help body rides in metadata as helpContentMessage, next to its English
// in helpContent (task c37a7365, slice 2). It holds command descriptions the
// registry supplies, so it gets the same rule as `message`: kept only when
// every language's render is clean, and dropped alone otherwise.
describe("the help body's message keys", () => {
  const helpEntry = (helpContentMessage: LogPart[]): LogEntry => ({
    id: "log-help-redaction",
    agentId: "redaction-agent",
    timestamp: 1,
    kind: "system",
    content: renderLogText(english, [msg("commands.help.header")]),
    message: [msg("commands.help.header")],
    metadata: {
      helpContent: renderLogText(english, helpContentMessage),
      helpContentMessage,
    },
  });

  it("keeps a help body that is clean in every language", () => {
    const body = [msg("systemEntries.pathRefusal.notFound", { path: "/x" })];
    const prepared = prepareLogEntry(helpEntry(body));
    expect(prepared.metadata?.helpContentMessage).toEqual(body);
    expect(prepared.message).toEqual([msg("commands.help.header")]);
  });

  it("drops only the help body's keys when one language's render shows a secret shape", () => {
    const name = "OPENAI_API_KEY_PROD_1";
    const KEY = "cards.secretRequest.title" as const;
    // The ENABLING CONDITIONS, as for `message` above.
    const englishText = translatorFor("en").t(KEY, { name });
    expect(scanner.redactSecretText(englishText)).toBe(englishText);
    const catalan = translatorFor("ca").t(KEY, { name });
    expect(scanner.redactSecretText(catalan)).not.toBe(catalan);

    const prepared = prepareLogEntry(helpEntry([msg(KEY, { name })]));
    expect(prepared.metadata?.helpContentMessage).toBeUndefined();
    expect(prepared.metadata?.helpContent).toBe(englishText);
    // The entry's own message is clean, so it stays.
    expect(prepared.message).toEqual([msg("commands.help.header")]);
  });
});
