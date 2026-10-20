import { describe, expect, it } from "bun:test";
import type { LogEntry } from "../shared/types.ts";
import { afterEach } from "bun:test";
import {
  redactLogEntry,
  setSecretValuesForRedaction,
  redactSecretText,
  createRedactingTextStream,
} from "./log-redaction.ts";

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
    "sk_live_" + "A1".repeat(10),
    "sk_test_" + "A1".repeat(10),
    "rk_live_" + "A1".repeat(10),
    "rk_test_" + "A1".repeat(10),
    "whsec_" + "A1".repeat(10),
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
  it("leaves Stripe-like values outside the secret and webhook prefixes", () => {
    const unchanged = [
      // A publishable key is public by design.
      "pk_live_" + "A1".repeat(10),
      "pk_test_" + "A1".repeat(10),
      "sk_prod_" + "A1".repeat(10),
      "rk_dev_" + "A1".repeat(10),
      "whsec" + "A1".repeat(10),
      "Sk_live_" + "A1".repeat(10),
    ];
    for (const value of unchanged)
      expect(redactLogEntry(entry(value)).content).toBe(value);
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
  let leaf = result.metadata;
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

describe("secret values", () => {
  afterEach(() => setSecretValuesForRedaction([]));

  it("masks a current secret value whatever its shape, also URL-encoded and in Basic", () => {
    const value = "plain words/that+look=harmless";
    setSecretValuesForRedaction([value]);
    const basic = Buffer.from(`user:${value}`).toString("base64");
    const out = redactLogEntry(
      entry(`a ${value} b ${encodeURIComponent(value)} c Basic ${basic}`),
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain(value);
    expect(text).not.toContain(encodeURIComponent(value));
    expect(text).not.toContain(basic);
  });

  it("leaves a value under the minimum length alone", () => {
    setSecretValuesForRedaction(["abc"]);
    expect(redactLogEntry(entry("abcdef tabcount")).content).toBe(
      "abcdef tabcount",
    );
  });
});

// Terminal recordings redact a stream of output chunks (task 749cb7fd): the
// result must not depend on where the PTY happened to split the text.
describe("redacting a text stream", () => {
  afterEach(() => setSecretValuesForRedaction([]));
  const stored = "plain words/that+look=harmless";
  const shaped = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
  // An assignment split after its label must still be caught.
  const text = `$ cat .env\r\nX=${stored}\r\nKEY ${shaped} done\r\nexport password = 'Zq8wLmN3vB7xKp2Rt9'\r\n`;

  it("is the string redaction log entries get", () => {
    setSecretValuesForRedaction([stored]);
    for (const sample of [
      text,
      "nothing secret here",
      `token=${"q".repeat(20)}`,
    ])
      expect(redactSecretText(sample)).toBe(
        redactLogEntry(entry(sample)).content,
      );
    expect(redactSecretText(text)).not.toContain(stored);
    expect(redactSecretText(text)).not.toContain(shaped);
  });

  it("gives the same text at every split point, the held tail included", () => {
    setSecretValuesForRedaction([stored]);
    const whole = redactSecretText(text);
    for (let cut = 0; cut <= text.length; cut++) {
      const stream = createRedactingTextStream();
      const out =
        stream.push(text.slice(0, cut)) +
        stream.push(text.slice(cut)) +
        stream.end();
      expect(out, `cut at ${cut}`).toBe(whole);
    }
    // One character per chunk, as a slow PTY can deliver it.
    const stream = createRedactingTextStream();
    let out = "";
    for (const ch of text) out += stream.push(ch);
    expect(out + stream.end()).toBe(whole);
  });

  it("does not hold an endless key run, and masks it as the whole string would", () => {
    // `cat` of a one-line file: 256 KB of key characters in 4 KB chunks.
    // The end: each kind of key keeps its own characters, so the batch masks
    // "-b.c" whole, in part, or not at all.
    const end = "-b.c\r\n";
    for (const start of ["x", "sk-", "sk-proj-", "password="]) {
      const run = start + "A".repeat(256 * 1024);
      const stream = createRedactingTextStream();
      let released = "";
      for (let i = 0; i < run.length; i += 4096)
        released += stream.push(run.slice(i, i + 4096));
      // Written before the run ends: the stream did not hold the whole run.
      expect(released.length, start).toBeGreaterThan(0);
      if (start === "x")
        expect(released.length, start).toBeGreaterThan(run.length - 64 * 1024);
      // After the run, the stream is back to normal: "ok" is not dropped.
      const out =
        released + stream.push(end) + stream.push("ok\r\n") + stream.end();
      expect(out, start).toBe(redactSecretText(run + end + "ok\r\n"));
    }
  });
});
