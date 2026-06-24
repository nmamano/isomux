// Source hygiene: no raw NUL (0x00) bytes in tracked TypeScript source.
//
// A literal NUL byte inside a string/template literal compiles fine (Bun and
// tsc accept it) and runs correctly, but it flips the WHOLE file to "binary"
// for text tooling: grep then silently matches NOTHING (exit 1, no output),
// and ripgrep stops searching at the first NUL. Agents and humans searching
// the file get false negatives and draw wrong conclusions ("this isn't wired"),
// while the build and server stay green. A silent navigation hazard.
//
// Regression guard for the collision-proof composite keys in server/index.ts
// and server/transport/idempotency.ts: the NUL delimiter MUST be written as a
// JS escape (the six characters backslash u 0 0 0 0), never as a raw 0x00 byte.
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
