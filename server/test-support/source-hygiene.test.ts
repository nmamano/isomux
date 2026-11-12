// Source hygiene: properties of every tracked file that no build or type
// check sees.
//
// 1. No raw NUL (0x00) bytes in tracked TypeScript source.
//
// A literal NUL byte inside a string/template literal compiles fine (Bun and
// tsc accept it) and runs correctly, but it flips the WHOLE file to "binary"
// for text tooling: grep then silently matches NOTHING (exit 1, no output),
// and ripgrep stops searching at the first NUL. Agents and humans searching
// the file get false negatives and draw wrong conclusions ("this isn't wired"),
// while the build and server stay green. A silent navigation hazard.
//
// Regression guard for the collision-proof composite keys in server/isomux-office.ts
// and server/transport/idempotency.ts: the NUL delimiter MUST be written as a
// JS escape (the six characters backslash u 0 0 0 0), never as a raw 0x00 byte.
//
// 2. No literal Stripe live key or webhook signing secret in any tracked text
// file. GitHub push protection refuses a push that carries one, fake or real
// (task 985873a9), so a test fixture builds the string at run time
// ("sk_live_" + "..."), which leaves the value the same and the source clean.
//
// Pure T0: reads tracked files, no server, no FS writes, no LLM.

import { describe, it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const NUL = String.fromCharCode(0);

describe("source hygiene: no raw NUL bytes in tracked TS source", () => {
  it("every tracked .ts/.tsx/.mts/.cts file is free of 0x00 bytes", () => {
    // `git ls-files -z` separates paths with NUL (so names with spaces or
    // newlines survive); split on that same NUL.
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    const tracked = out.toString("utf8").split(NUL).filter(Boolean);
    // Fail closed: no listing (no git, an exported tree) checks nothing.
    expect(tracked.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const rel of tracked) {
      if (!/\.(ts|tsx|mts|cts)$/.test(rel)) continue;
      if (readFileSync(join(REPO_ROOT, rel)).includes(0)) offenders.push(rel);
    }

    if (offenders.length > 0) {
      throw new Error(
        "Raw NUL (0x00) byte in tracked source (write the NUL delimiter as a " +
          "JS escape, not a literal byte; a raw NUL makes grep/ripgrep skip " +
          "the file): " +
          offenders.join(", "),
      );
    }
    expect(offenders).toEqual([]);
  });
});

describe("source hygiene: no literal Stripe live credential in a tracked file", () => {
  it("git grep finds no live key or signing secret shape", () => {
    // The guard must name the prefixes, so it looks for a credential-shaped
    // BODY after them (GitHub's Stripe pattern has no checksum, so a fake
    // body is refused as a real one is). -I skips binary files.
    const pattern =
      "\\b(sk|rk)_live_[A-Za-z0-9]{20,}|\\bwhsec_[A-Za-z0-9]{20,}";
    const run = Bun.spawnSync(
      ["git", "grep", "-z", "-n", "-I", "-E", "-e", pattern],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    // Exit 1 is no match. Any exit but 0 or 1 is a failed scan: fail closed.
    if (run.exitCode !== 0 && run.exitCode !== 1) {
      throw new Error(
        `git grep failed (exit ${run.exitCode}): ${run.stderr.toString()}`,
      );
    }
    // With -z each hit is path NUL line NUL text. Report path:line only: a
    // real key must not reach the test log.
    const offenders = run.stdout
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((hit) => hit.split(NUL).slice(0, 2).join(":"));
    expect(offenders).toEqual([]);
    expect(run.exitCode).toBe(1);
  });
});
