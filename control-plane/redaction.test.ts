// Secrets must not reach anything we keep.
//
// An audit-file assertion alone cannot see a printer leak, so every stream the
// run produces is captured and asserted on: stdout, stderr, the transcript, and
// the audit JSONL bytes. The fixtures are synthetic and secret-SHAPED - no real
// credential appears here, and no assertion echoes a matched value.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLog } from "./audit.ts";
import { Reporter, redactForTranscript, type Sink } from "./report.ts";

const FAKE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "THIS-IS-NOT-A-REAL-KEY-ONLY-A-SHAPE",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const FAKE_INVITE = "https://cp1.test.isomux.app/i/NOTAREALTOKEN0123456789";

let dir = "";
let auditFile = "";
let stdout: string[] = [];
let stderr: string[] = [];
let sink: Sink;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-cp-redact-"));
  auditFile = path.join(dir, "audit.jsonl");
  stdout = [];
  stderr = [];
  sink = { out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function auditBytes(): string {
  return fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
}

describe("the audit log", () => {
  test("records that a mint happened, never the URL", () => {
    const audit = new AuditLog(auditFile, "isomuxer2");
    audit.record("mint_invite", "cp1.test.isomux.app", "succeeded");
    const bytes = auditBytes();
    expect(bytes).toContain("mint_invite");
    expect(bytes).not.toContain(FAKE_INVITE);
    expect(bytes).not.toContain("/i/");
  });

  test("has no field that accepts raw output, so key material cannot arrive", () => {
    const audit = new AuditLog(auditFile, "isomuxer2");
    // `detail` is the only free-ish field, and it takes a classified reason.
    // Even handed something secret-shaped, the log must not grow a key.
    audit.record("revoke_access", "169.0.0.1", "failed", "host key mismatch");
    const bytes = auditBytes();
    expect(bytes).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(bytes).toContain("host key mismatch");
  });

  test("is append-only across records", () => {
    const audit = new AuditLog(auditFile, "isomuxer2");
    audit.record("run_installer", "r1", "started");
    audit.record("run_installer", "r1", "succeeded");
    expect(auditBytes().trim().split("\n")).toHaveLength(2);
  });
});

describe("the operator transcript", () => {
  test("the operator sees the invite live; the transcript does not keep it", () => {
    const reporter = new Reporter(sink);
    reporter.invite(FAKE_INVITE);

    // Live output carries it - asserting this proves the redaction is not just
    // dropping everything on the floor.
    expect(stdout.join("\n")).toContain(FAKE_INVITE);
    // Anything we would write down does not.
    expect(reporter.transcript.join("\n")).not.toContain(FAKE_INVITE);
    expect(reporter.transcript.join("\n")).toContain("<invite url redacted>");
  });

  test("key material in an ordinary line is redacted from the transcript", () => {
    const reporter = new Reporter(sink);
    reporter.problem(`command failed, output was:\n${FAKE_KEY}`);
    expect(reporter.transcript.join("\n")).not.toContain(
      "THIS-IS-NOT-A-REAL-KEY",
    );
    expect(reporter.transcript.join("\n")).toContain(
      "<private key material redacted>",
    );
  });

  test("an invite anywhere in a line is caught, not just a bare one", () => {
    expect(redactForTranscript(`see ${FAKE_INVITE} now`)).not.toContain(
      "NOTAREALTOKEN",
    );
  });
});

describe("no stream leaks", () => {
  test("nothing secret-shaped reaches audit, stderr or the transcript", () => {
    const audit = new AuditLog(auditFile, "isomuxer2");
    const reporter = new Reporter(sink);

    reporter.step("first-contact", "expiry confirmed");
    audit.record("arm_revocation", "cp1.test.isomux.app", "succeeded");
    reporter.invite(FAKE_INVITE);
    reporter.problem(`ssh said:\n${FAKE_KEY}`);
    audit.record("revoke_access", "cp1.test.isomux.app", "succeeded");

    const written = [
      auditBytes(),
      stderr.join("\n"),
      reporter.transcript.join("\n"),
    ].join("\n");
    for (const marker of [
      "BEGIN OPENSSH PRIVATE KEY",
      "NOTAREALTOKEN",
      "THIS-IS-NOT-A-REAL-KEY",
    ]) {
      // Reported by name only; the assertion never echoes what it matched.
      expect(written.includes(marker)).toBe(false);
    }
  });
});
