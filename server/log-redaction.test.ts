import { describe, expect, it } from "bun:test";
import type { LogEntry } from "../shared/types.ts";
import { redactLogEntry } from "./log-redaction.ts";

function entry(
  content: string,
  kind: LogEntry["kind"] = "tool_result",
): LogEntry {
  return {
    id: "log-test",
    agentId: "agent-test",
    timestamp: 123,
    kind,
    content,
  };
}
// A bare key keeps its first eight characters; an assignment keeps its label
// and the first eight characters of the value.
const redacted = (value: string) => {
  const m = /^(.*?[=:]\s*['"]?)(.*)$/s.exec(value);
  return m
    ? m[1] + m[2].slice(0, 8) + "...REDACTED"
    : value.slice(0, 8) + "...REDACTED";
};

describe("log secret redaction", () => {
  const secrets = [
    "sk-proj-" + "a_".repeat(10),
    "sk-ant-api03-" + "a-".repeat(10),
    "sk-" + "A1".repeat(10),
    "m0-" + "a_".repeat(10),
    "ghp_" + "A1".repeat(18),
    "gho_" + "A1".repeat(18),
    "github_pat_" + "a_".repeat(41),
    "AKIA" + "A1".repeat(8),
    "api_key=" + "x".repeat(16),
    "api-key: '" + "a_".repeat(8),
    'apikey="' + "x".repeat(16),
    "secret = " + "x".repeat(16),
    "token:" + "x".repeat(16),
    "password=" + "x".repeat(16),
  ];
  for (const secret of secrets) {
    it("redacts exact pattern " + secret.split(/[=:]/)[0].slice(0, 12), () => {
      expect(redactLogEntry(entry("before " + secret + " after")).content).toBe(
        "before " + redacted(secret) + " after",
      );
    });
    it(
      "does not match one character below the minimum " + secret.slice(0, 12),
      () => {
        const short = secret.slice(0, -1);
        expect(redactLogEntry(entry(short)).content).toBe(short);
      },
    );
  }
  it("handles multiple and overlapping patterns in one pass and is idempotent", () => {
    const content = secrets.join(" ; ") + " token=" + secrets[0];
    const result = redactLogEntry(entry(content));
    expect(result.content).toBe(
      secrets.map(redacted).join(" ; ") + " " + redacted("token=" + secrets[0]),
    );
    expect(redactLogEntry(result)).toEqual(result);
  });
  it("scans all kinds, nested arrays, custom metadata and tool payloads without mutation", () => {
    const kinds: LogEntry["kind"][] = [
      "tool_result",
      "tool_call",
      "text",
      "thinking",
      "system",
      "error",
      "user_message",
      "api_token_outbound",
      "diff",
      "edit-request",
      "terminal-command",
      "file-view",
    ];
    for (const kind of kinds) {
      const input = {
        ...entry(secrets[0], kind),
        metadata: {
          payload: [{ command: secrets[1], count: 7, flag: false, nil: null }],
          [secrets[2]]: "key is structural",
        },
        terminal: { command: secrets[3] },
      };
      const result = redactLogEntry(input);
      expect(result.content).toBe(redacted(secrets[0]));
      expect(result.metadata).toEqual({
        payload: [
          { command: redacted(secrets[1]), count: 7, flag: false, nil: null },
        ],
        [secrets[2]]: "key is structural",
      });
      expect(result.terminal?.command).toBe(redacted(secrets[3]));
      expect(input.metadata.payload[0].command).toBe(secrets[1]);
      expect(result.id).toBe(input.id);
      expect(result.timestamp).toBe(123);
      expect(result.kind).toBe(kind);
    }
  });
  it("shows the exact generic false-positive surface", () => {
    const unchanged = [
      'curl -H "Authorization: Bearer $API_TOKEN" https://example.com',
      "OPENAI_API_KEY ANTHROPIC_API_KEY api_key token password",
      "https://example.com/docs/how-to-create-a-token",
      "the api_key is stored in the vault",
      "export ANTHROPIC_API_KEY  # no value",
    ];
    for (const value of unchanged)
      expect(redactLogEntry(entry(value)).content).toBe(value);
    expect(
      redactLogEntry(
        entry("https://example.com/?token=abcdefghijklmnop&next=docs"),
      ).content,
    ).toBe("https://example.com/?token=abcdefgh...REDACTED&next=docs");
    expect(
      redactLogEntry(
        entry('curl https://example.com -d "api_key=YOUR_API_KEY_HERE"'),
      ).content,
    ).toBe('curl https://example.com -d "api_key=YOUR_API...REDACTED"');
    for (const name of ["DATABASE_PASSWORD", "database_password"]) {
      expect(
        redactLogEntry(entry(name + "=hunter2hunter2hunter2")).content,
      ).toBe(name + "=hunter2h...REDACTED");
    }
    expect(
      redactLogEntry(entry("password=correct-horse-battery-staple")).content,
    ).toBe("password=correct-...REDACTED");
  });
  it("copies shared and cyclic metadata without an infinite walk", () => {
    const metadata: Record<string, unknown> = { value: secrets[0] };
    metadata.self = metadata;
    const result = redactLogEntry({ ...entry("ok"), metadata });
    expect(result.metadata?.self).toBe(result.metadata);
    expect(result.metadata?.value).toBe(redacted(secrets[0]));
  });
});

it("handles 20000 nested objects without call-stack overflow and preserves undefined", () => {
  let metadata: Record<string, unknown> = {
    value: "sk-" + "x".repeat(20),
    absent: undefined,
  };
  for (let i = 0; i < 20000; i++) metadata = { child: metadata };
  const result = redactLogEntry({ ...entry("ok"), metadata, ephemeral: true });
  let leaf = result.metadata!;
  for (let i = 0; i < 20000; i++) leaf = leaf.child as Record<string, unknown>;
  expect(leaf.value).toBe("sk-xxxxx...REDACTED");
  expect(Object.hasOwn(leaf, "absent")).toBe(true);
  expect(leaf.absent).toBeUndefined();
  expect(result.ephemeral).toBe(true);
});

it("pins the PM ruling and stays stable on a second pass for every case", () => {
  const cases = [
    [
      "Environment=OPENAI_API_KEY=sk-proj-" + "A".repeat(24),
      "Environment=OPENAI_API_KEY=sk-proj-...REDACTED",
    ],
    [
      "Environment=ANTHROPIC_API_KEY=sk-ant-api03-" + "A".repeat(24),
      "Environment=ANTHROPIC_API_KEY=sk-ant-a...REDACTED",
    ],
    [
      "DATABASE_PASSWORD=hunter2hunter2hunter2hunter2",
      "DATABASE_PASSWORD=hunter2h...REDACTED",
    ],
    [
      "database_password=hunter2hunter2hunter2hunter2",
      "database_password=hunter2h...REDACTED",
    ],
    ["api_key=YOUR_API_KEY_HERE_PLACEHOLDER", "api_key=YOUR_API...REDACTED"],
    [
      "https://example.com/v1/things?token=abcdefghijklmnopqrstuvwx",
      "https://example.com/v1/things?token=abcdefgh...REDACTED",
    ],
    ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSF...REDACTED"],
    ["ghp_" + "a".repeat(36), "ghp_aaaa...REDACTED"],
    [
      'curl -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"',
      'curl -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"',
    ],
    [
      "the api_key is stored in the vault, see docs/secrets.md",
      "the api_key is stored in the vault, see docs/secrets.md",
    ],
    [
      "export ANTHROPIC_API_KEY  # no value here",
      "export ANTHROPIC_API_KEY  # no value here",
    ],
    ["SK-PROJ-" + "A".repeat(24), "SK-PROJ-" + "A".repeat(24)],
    ["GHP_" + "a".repeat(36), "GHP_" + "a".repeat(36)],
    ["akiaIOSFODNN7EXAMPLE", "akiaIOSFODNN7EXAMPLE"],
  ];
  for (const [input, output] of cases) {
    const result = redactLogEntry(entry(input));
    expect(result.content).toBe(output);
    expect(redactLogEntry(result)).toEqual(result);
  }
});
