// The derivation this program is not allowed to trust, and the shape check on
// what it prints.
//
// `pooledHostFor` is a GUESS about a provider's naming convention, which is why
// the program that uses it never acts on the result without `liveBranchId`
// proving the derived host answers for the branch we asked about - the same
// gate `targetFor` puts on its own fallback. These tests pin the derivation and
// pin that a host never reaches the transcript.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pooledHostFor, pooledVariantOf } from "./endpoint-posture.ts";

const DIRECT = "ep-cool-thing-12345678.eu-central-1.aws.neon.tech";
const POOLED = "ep-cool-thing-12345678-pooler.eu-central-1.aws.neon.tech";

describe("deriving the pooled host", () => {
  test("the label goes on the endpoint id and nothing else moves", () => {
    expect(pooledHostFor(DIRECT)).toBe(POOLED);
  });

  test("an already-pooled host is not pooled twice", () => {
    expect(pooledHostFor(POOLED)).toBeNull();
  });

  test("a host with no label to attach is refused rather than mangled", () => {
    expect(pooledHostFor("localhost")).toBeNull();
    expect(pooledHostFor("")).toBeNull();
    expect(pooledHostFor(".starts-with-a-dot")).toBeNull();
  });

  test("only the host moves - credentials, database and parameters survive", () => {
    const dsn = `postgresql://role:pw@${DIRECT}/db?sslmode=verify-full`;
    const pooled = pooledVariantOf(dsn);
    expect(pooled).not.toBeNull();
    const before = new URL(dsn);
    const after = new URL(pooled!);
    expect(after.hostname).toBe(POOLED);
    expect(after.username).toBe(before.username);
    expect(after.password).toBe(before.password);
    expect(after.pathname).toBe(before.pathname);
    expect(after.searchParams.get("sslmode")).toBe("verify-full");
  });

  test("a string that is not a URL yields null, and quotes nothing", () => {
    // Node's URL error carries the offending string on `input`, and that string
    // is the whole DSN. The contract is a value or null, never a message.
    expect(pooledVariantOf("not a dsn")).toBeNull();
  });
});

describe("what the program may print", () => {
  test("NO HOST, ROLE, DATABASE OR BRANCH ID IS EVER PRINTED", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "endpoint-posture.ts"),
      "utf8",
    );
    // An ALLOWLIST of every expression this file is allowed to interpolate into
    // a printed line, rather than a blocklist of dangerous-looking ones. A
    // blocklist passes anything nobody thought of; this fails until a human
    // adds the new expression and says what it carries. Each one below is a
    // boolean, a small integer, a fixed label, or a value that already passed
    // SETTING_SHAPE - `target.hostFromApi` is a BOOLEAN about where the host
    // came from, not the host.
    const allowed = new Set([
      "BRANCH",
      "target.hostFromApi",
      "label",
      "name",
      "seen",
      "expected",
      "reading.opens",
      "reading.boundsGoverned",
      "reading.failure",
      "reading.branchProved",
      'reading.maxConnections ?? "unreadable"',
      "pooledDsn !== null",
      "pooledEligible",
      "direct.boundsGoverned && direct.branchProved",
    ]);
    const logs = source.match(/console\.log\((?:[^\n]|\n\s+)*?\);/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    const interpolations = new Set<string>();
    for (const line of logs) {
      for (const hit of line.matchAll(/\$\{([^}]*)\}/g)) {
        interpolations.add(hit[1]);
      }
    }
    expect(interpolations.size).toBeGreaterThan(0);
    for (const expression of interpolations) {
      expect({ expression, allowed: allowed.has(expression) }).toEqual({
        expression,
        allowed: true,
      });
    }
  });

  test("the branch is a constant, so no argument can move it", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "endpoint-posture.ts"),
      "utf8",
    );
    expect(source).not.toContain("process.argv");
  });
});
