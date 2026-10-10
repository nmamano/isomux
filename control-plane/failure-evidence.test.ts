import { describe, expect, test } from "bun:test";
import { failureEvidence, repeatedInstallerFailure } from "./failure-evidence.ts";
import { Reporter, redactLogText } from "./report.ts";

const token = "a".repeat(43);
const invite = "https://office.test/i/short-secret";
const pem = "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----";
const sensitive = `${pem}\n${invite}\n${token}\nstaging-secret\npassword=small\nHTTP 403 forbidden`;

test("failure tail redacts before clipping and strips terminal controls", () => {
  const evidence = failureEvidence("configure_public_access", 22, sensitive + "\n\u001b[31merror\u001b[0m\u0000", ["staging-secret"]);
  for (const secret of ["private material", invite, token, "staging-secret", "small", "\u001b", "\u0000"]) {
    expect(evidence.logTail).not.toContain(secret);
  }
  expect(evidence.logTail).toContain("HTTP 403");
  expect(evidence.logTail).not.toMatch(/\[31m|\[0m/);
  expect(evidence.exit).toBe(22);
  const longSecret = "lowercase".repeat(300);
  expect(failureEvidence("step", 1, `prefix ${longSecret}`, [longSecret]).logTail).not.toContain("lowercase");
});

test("failure tail bounds UTF-8 lines and total bytes, keeping the newest lines", () => {
  const ev = failureEvidence("step", 1, Array.from({ length: 100 }, (_, i) => `${i} ${"猫 ".repeat(600)}`).join("\n") + "\nlast");
  expect(Buffer.byteLength(ev.logTail)).toBeLessThanOrEqual(8192);
  expect(ev.logTail.split("\n").length).toBeLessThanOrEqual(40);
  expect(ev.logTail.split("\n").every((s) => Buffer.byteLength(s) <= 512)).toBe(true);
  expect(ev.logTail).toEndWith("last");
  expect(ev.logTail).not.toContain("\ufffd");
  const short = failureEvidence("step", 1, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  expect(short.logTail.split("\n")).toHaveLength(40);
  expect(short.logTail).toEndWith("line 99");
});

describe("repeated installer failure predicate", () => {
  const attempts = (n = 3) => Array.from({ length: n }, (_, i) => ({ runId: `run-${i}`, verdict: "exit 22", step: "configure_public_access" }));
  test("two runs do not raise; three do", () => {
    expect(repeatedInstallerFailure({ attempts: attempts(2) })).toBe(false);
    expect(repeatedInstallerFailure({ attempts: attempts() })).toBe(true);
  });
  for (const [name, patch] of Object.entries({
    "different step": { step: "download" },
    "different exit": { verdict: "exit 1" },
    "crash": { verdict: "crashed" },
    "success": { verdict: "exit 0" },
    "duplicate generation": { runId: "run-0" },
  })) {
    test(`${name} breaks the three-run window`, () => {
      const a = attempts(); a[1] = { ...a[1], ...patch };
      expect(repeatedInstallerFailure({ attempts: a })).toBe(false);
    });
  }
  test("an empty step counts", () => {
    expect(repeatedInstallerFailure({ attempts: attempts().map((a) => ({ ...a, step: "" })) })).toBe(true);
  });
  test("three crashes or three successes never count as nonzero exits", () => {
    for (const verdict of ["crashed", "exit 0", "exit NaN", "exit -1"]) {
      expect(repeatedInstallerFailure({ attempts: attempts().map((a) => ({ ...a, verdict })) })).toBe(false);
    }
  });
});

test("durable reporter redacts line, problem and invite at the write", () => {
  const lines: string[] = [];
  const reporter = new Reporter({ out: (s) => lines.push(s), err: (s) => lines.push(s) }, true);
  reporter.line(`${pem}\n${invite}\nBearer small-token`);
  reporter.problem("password=short"); reporter.invite(invite);
  expect(lines.join("\n")).not.toMatch(/private material|short|small-token|short-secret/);
  expect(redactLogText("diagnostic hidden-value", ["hidden-value"])).not.toContain("hidden-value");
});
