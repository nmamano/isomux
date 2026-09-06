import { expect, it, spyOn } from "bun:test";
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
    '[Service]\nEnvironment="OPENAI_API_KEY=...REDACTED"\nEnvironment="ANTHROPIC_API_KEY=...REDACTED"',
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
