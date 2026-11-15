import { describe, expect, test } from "bun:test";
import {
  diagnosticLine,
  failureEvidence,
  repeatedInstallerFailure,
} from "./failure-evidence.ts";
import {
  INVITE_REDACTION,
  KEY_REDACTION,
  Reporter,
  SECRET_REDACTION,
  redactLogText,
} from "./report.ts";

const token = "a".repeat(43);
const invite = "https://office.test/i/short-secret";
const pem =
  "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----";
const sensitive = `${pem}\n${invite}\n${token}\nstaging-secret\npassword=small\nHTTP 403 forbidden`;

test("failure tail redacts before clipping and strips terminal controls", () => {
  const evidence = failureEvidence(
    "configure_public_access",
    22,
    sensitive + "\n\u001b[31merror\u001b[0m\u0000",
    ["staging-secret"],
  );
  for (const secret of [
    "private material",
    invite,
    token,
    "staging-secret",
    "small",
    "\u001b",
    "\u0000",
  ]) {
    expect(evidence.logTail).not.toContain(secret);
  }
  expect(evidence.logTail).toContain("HTTP 403");
  expect(evidence.logTail).not.toMatch(/\[31m|\[0m/);
  expect(evidence.exit).toBe(22);
  // Spaces keep the secret out of the long-token shape, so only redacting the
  // whole value before the 512-byte line clip removes it.
  const longSecret = "low case. ".repeat(300);
  expect(
    failureEvidence("step", 1, `prefix ${longSecret}`, [longSecret]).logTail,
  ).not.toContain("low case");
});

test("failure tail bounds UTF-8 lines and total bytes, keeping the newest lines", () => {
  const ev = failureEvidence(
    "step",
    1,
    Array.from({ length: 100 }, (_, i) => `${i} ${"猫 ".repeat(600)}`).join(
      "\n",
    ) + "\nlast",
  );
  expect(Buffer.byteLength(ev.logTail)).toBeLessThanOrEqual(8192);
  expect(ev.logTail.split("\n").length).toBeLessThanOrEqual(40);
  expect(ev.logTail.split("\n").every((s) => Buffer.byteLength(s) <= 512)).toBe(
    true,
  );
  expect(ev.logTail).toEndWith("last");
  expect(ev.logTail).not.toContain("\ufffd");
  const short = failureEvidence(
    "step",
    1,
    Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
  );
  expect(short.logTail.split("\n")).toHaveLength(40);
  expect(short.logTail).toEndWith("line 99");
});

describe("repeated installer failure predicate", () => {
  const attempts = (n = 3) =>
    Array.from({ length: n }, (_, i) => ({
      runId: `run-${i}`,
      verdict: "exit 22",
      step: "configure_public_access",
    }));
  test("two runs do not raise; three do, also with an empty step", () => {
    expect(repeatedInstallerFailure({ attempts: attempts(2) })).toBe(false);
    expect(repeatedInstallerFailure({ attempts: attempts() })).toBe(true);
    expect(
      repeatedInstallerFailure({
        attempts: attempts().map((a) => ({ ...a, step: "" })),
      }),
    ).toBe(true);
  });
  for (const [name, patch] of Object.entries({
    "different step": { step: "download" },
    "different exit": { verdict: "exit 1" },
    "duplicate generation": { runId: "run-0" },
  })) {
    test(`${name} breaks the three-run window`, () => {
      const a = attempts();
      a[1] = { ...a[1], ...patch };
      expect(repeatedInstallerFailure({ attempts: a })).toBe(false);
    });
  }
  test("three crashes or three successes never count as nonzero exits", () => {
    for (const verdict of ["crashed", "exit 0", "exit NaN", "exit -1"]) {
      expect(
        repeatedInstallerFailure({
          attempts: attempts().map((a) => ({ ...a, verdict })),
        }),
      ).toBe(false);
    }
  });
});

test("durable reporter redacts line, problem and invite at the write", () => {
  const lines: string[] = [];
  const reporter = new Reporter(
    { out: (s) => lines.push(s), err: (s) => lines.push(s) },
    true,
  );
  reporter.line(`${pem}\n${invite}\nBearer small-token`);
  reporter.problem("password=short");
  reporter.invite(invite);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain(KEY_REDACTION);
  expect(lines[0]).toContain(INVITE_REDACTION);
  expect(lines[2]).toBe(`OWNER INVITE: ${INVITE_REDACTION}`);
  expect(lines.join("\n")).not.toMatch(
    /private material|short|small-token|short-secret/,
  );
  expect(redactLogText("diagnostic hidden-value", ["hidden-value"])).toBe(
    `diagnostic ${SECRET_REDACTION}`,
  );
});

describe("diagnosticLine", () => {
  test("one trimmed line with values, shapes, emails and controls removed", () => {
    const line = diagnosticLine(
      `  first\n\tsecond   ${token}\r\nmail ops@example.com password=small \u001b[31mhidden-value\u0000  `,
      ["hidden-value"],
    );
    expect(line).not.toMatch(/[\n\r\t]|\s{2}/);
    expect(line).toBe(line.trim());
    expect(line).toContain("first second");
    expect(line).toContain("mail");
    for (const s of [
      token,
      "ops@",
      "example.com",
      "small",
      "hidden-value",
      "\u001b",
      "\u0000",
    ])
      expect(line).not.toContain(s);
  });

  test("cuts to the byte limit after redaction, never inside a character", () => {
    // Spaces keep the secret out of every shape, so only the value pass
    // removes it, and only when it runs before the cut.
    const secret = "low case. ".repeat(10);
    const line = diagnosticLine(
      `${"😀".repeat(3)} ${secret}${"猫😀".repeat(200)}`,
      [secret],
      64,
    );
    expect(line).not.toContain("low case");
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(line)).toBeGreaterThan(56);
    expect(line.isWellFormed()).toBe(true);
    expect(line).not.toContain("�");
    const byDefault = diagnosticLine("word ".repeat(1000));
    expect(Buffer.byteLength(byDefault)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(byDefault)).toBeGreaterThan(500);
  });

  test("a large input is redacted in bounded time", () => {
    // A provider body or a remote error can be any size. Uncut, an email
    // pattern that rescans a dotted run took 3.7 s on the first input, and the
    // invite pattern about 2 s on the second.
    for (const text of ["a.".repeat(50_000), "http://".repeat(15_000)]) {
      const start = performance.now();
      const line = diagnosticLine(text);
      expect(performance.now() - start).toBeLessThan(500);
      expect(line.length).toBeGreaterThan(0);
    }
    expect(diagnosticLine("a.".repeat(50_000)).startsWith("a.a.")).toBe(true);
  });

  // The input is cut before the shape passes (16 KB). Leading whitespace
  // collapses, so text at the cut can reach the output.
  const CUT = 16_384;

  test("a known value across the input cut leaves no fragment", () => {
    const secret = "low case. ".repeat(10);
    const text = " ".repeat(CUT - 50) + secret + " tail".repeat(10);
    const line = diagnosticLine(text, [secret]);
    expect(line).toContain("tail");
    expect(line).not.toContain("low case");
  });

  test("a shape-redacted token split by the input cut leaves no fragment", () => {
    // Lowercase and digits only: whole, only the long-run pass catches it.
    const secret = "k7m2x4p8w3".repeat(6);
    expect(diagnosticLine(`x ${secret} y`)).not.toContain(secret.slice(0, 10));
    // No delimiter in the 300 characters before the cut, which lands 30
    // characters into the token.
    const text = " ".repeat(CUT - 330) + "q.".repeat(150) + secret + " end";
    const line = diagnosticLine(text);
    expect(Buffer.byteLength(line)).toBeLessThan(512);
    expect(line).not.toContain(secret.slice(0, 10));
  });
});
