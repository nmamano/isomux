import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

// Vercel deploys every file under api/ as a public function, except a file
// whose name starts with "_" or "." or ends in ".d.ts". Fail-closed: the rule
// reads the basename only, so a file in an "_"-prefixed subdirectory counts as
// public, and every extension counts.
function publicFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .filter((path) => {
      const name = basename(path);
      return !(
        name.startsWith("_") ||
        name.startsWith(".") ||
        name.endsWith(".d.ts")
      );
    })
    .sort();
}

describe("api/ public files", () => {
  it("applies Vercel's exclusion rules to every file in the tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "api-public-files-"));
    try {
      const files = [
        "x.ts",
        "x.test.ts",
        "_x.ts",
        "_x.test.ts",
        ".x",
        "x.d.ts",
        "sub/y.ts",
        "sub/_y.ts",
        "_sub/z.ts",
      ];
      for (const file of files) {
        mkdirSync(join(dir, dirname(file)), { recursive: true });
        writeFileSync(join(dir, file), "");
      }
      expect(publicFiles(dir)).toEqual([
        "_sub/z.ts",
        "sub/y.ts",
        "x.test.ts",
        "x.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deploys only the intended functions", () => {
    // A helper or test added here needs a "_" prefix; a new endpoint goes in
    // this list.
    expect(publicFiles(import.meta.dir)).toEqual(["chat.ts", "not-found.ts"]);
  });
});
