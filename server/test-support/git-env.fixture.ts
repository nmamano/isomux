// Run only by git-env.test.ts, in a nested `bun test` whose environment points
// GIT_DIR and related variables at a probe repository. The main suite does not
// collect it (no ".test." in the name). It runs git the way the temp-repo
// tests do: in a temp dir, with the inherited environment.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("git in a temp repo acts on that repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "isomux-git-env-fixture-"));
  const sh = (cmd: string) =>
    execSync(cmd, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  try {
    sh("git init -q && git config user.email t@t && git config user.name T");
    writeFileSync(join(dir, "f.txt"), "one\n");
    sh("git add . && git commit -qm one && git tag fixture-tag");
    expect(sh("git rev-parse --show-toplevel")).toBe(sh("pwd -P"));
    expect(sh("git tag")).toBe("fixture-tag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
