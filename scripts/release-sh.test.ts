// scripts/release.sh - tagging gates and CalVer computation, driven against a
// local bare origin. Sandbox modes: RELEASE_SKIP_CI=1 bypasses the CI gate
// entirely; the CI-gate tests instead use RELEASE_GH_REPO plus a PATH-stubbed
// gh that emits canned /actions/runs JSON and applies the --jq expression
// with real jq, so the workflow-path filter itself is exercised (an
// unrelated-workflow green run must not count). Zero LLM.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync, spawnSync } from "child_process";

const RELEASE_SH = new URL("./release.sh", import.meta.url).pathname;
const UPDATE_CHECKER = new URL("../server/update-checker.ts", import.meta.url)
  .pathname;

let base: string;
let repo: string;

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function runRelease(
  args: string[],
  env: Record<string, string> = { RELEASE_SKIP_CI: "1" },
): { code: number; out: string } {
  const r = spawnSync("bash", [RELEASE_SH, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

// Today's base tag from the SAME date invocation release.sh uses - JS
// new Date() can disagree with bash date on timezone (bun defaults to UTC).
function todayTag(): string {
  return `v${sh(base, "date +%Y.%-m.%-d")}`;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "isomux-release-test-"));
  repo = join(base, "repo");
  sh(base, "mkdir repo");
  sh(repo, "git init -q -b main");
  sh(repo, "git config user.email t@t && git config user.name T");
  writeFileSync(join(repo, "f.txt"), "one\n");
  sh(repo, "git add . && git commit -qm one");
  sh(base, "git clone -q --bare repo origin.git");
  sh(repo, `git remote add origin ${join(base, "origin.git")}`);
  sh(repo, "git fetch -q origin");

  // gh stub for the CI-gate tests: canned /actions/runs bodies per
  // GH_STUB_MODE, with the caller's --jq expression applied by real jq -
  // the same filtering gh would do.
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
printf '%q ' "$@" >>"\${GH_STUB_LOG:-/dev/null}"
printf '\n' >>"\${GH_STUB_LOG:-/dev/null}"
[[ \${GH_STUB_MODE:-green} == release-fail && $1 == release ]] && exit 9
if [[ $1 == api ]]; then
  jqexpr=""
  while (($#)); do [[ $1 == --jq ]] && jqexpr=$2; shift; done
  case \${GH_STUB_MODE:-green} in
    green|release-fail) body='{"workflow_runs":[{"run_number":1,"status":"completed","conclusion":"success","path":".github/workflows/build.yml"}]}' ;;
    unrelated) body='{"workflow_runs":[{"run_number":1,"status":"completed","conclusion":"success","path":".github/workflows/other.yml"}]}' ;;
    failed) body='{"workflow_runs":[{"run_number":2,"status":"completed","conclusion":"failure","path":".github/workflows/build.yml"}]}' ;;
  esac
  if [[ -n $jqexpr ]]; then jq -c "$jqexpr" <<<"$body"; else printf '%s' "$body"; fi
  exit 0
fi
exit 0
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
});

function runWithCiStub(
  mode: string,
  args: string[] = [],
): { code: number; out: string } {
  return runRelease(args, {
    RELEASE_GH_REPO: "fake/fake",
    GH_STUB_MODE: mode,
    PATH: `${join(base, "bin")}:${process.env.PATH}`,
  });
}

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("release.sh", () => {
  it("tags today's CalVer, annotated, and pushes it to origin", () => {
    const r = runRelease([]);
    expect(r.out).toContain("tagged and pushed");
    expect(r.code).toBe(0);
    const tag = todayTag();
    expect(sh(repo, `git cat-file -t refs/tags/${tag}`)).toBe("tag");
    expect(sh(base, `git -C origin.git tag -l ${tag}`)).toBe(tag);
  });

  it("second release the same day gets the .2 suffix", () => {
    expect(runRelease([]).code).toBe(0);
    const r = runRelease([]);
    expect(r.code).toBe(0);
    expect(sh(base, `git -C origin.git tag -l ${todayTag()}.2`)).toBe(
      `${todayTag()}.2`,
    );
  });

  it("refuses an explicit tag that already exists", () => {
    expect(runRelease(["v2026.7.19"]).code).toBe(0);
    const r = runRelease(["v2026.7.19"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("already exists");
  });

  it("refuses a non-CalVer tag", () => {
    const r = runRelease(["1.0"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("CalVer");
  });

  it("refuses a dirty checkout", () => {
    writeFileSync(join(repo, "f.txt"), "dirty\n");
    const r = runRelease([]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("dirty");
  });

  it("refuses a HEAD that is not on origin/main", () => {
    writeFileSync(join(repo, "f.txt"), "two\n");
    sh(repo, "git add . && git commit -qm two"); // not pushed
    const r = runRelease([]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("push first");
  });

  it("without RELEASE_SKIP_CI, refuses a non-GitHub origin", () => {
    const r = runRelease([], {});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not a github.com repo");
  });

  it("CI gate: a green Build workflow run passes and the tag lands", () => {
    const r = runWithCiStub("green");
    expect(r.out).toContain("CI green");
    expect(r.code).toBe(0);
    expect(sh(base, `git -C origin.git tag -l ${todayTag()}`)).toBe(todayTag());
  });

  it("CI gate: an unrelated green workflow does not count", () => {
    const r = runWithCiStub("unrelated");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no Build workflow run");
  });

  it("CI gate: a failed Build workflow refuses", () => {
    const r = runWithCiStub("failed");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not green");
  });

  it("--security creates the release with the exact machine-readable marker", () => {
    const log = join(base, "gh.log");
    const r = runRelease(["--security", "v2026.8.13"], {
      RELEASE_GH_REPO: "fake/fake",
      GH_STUB_MODE: "green",
      GH_STUB_LOG: log,
      PATH: `${join(base, "bin")}:${process.env.PATH}`,
    });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(
      "release create v2026.8.13 --verify-tag --generate-notes --title v2026.8.13 --notes isomux-severity:\\ security",
    );
  });

  it("an ordinary release has no security marker", () => {
    const log = join(base, "gh.log");
    const r = runRelease(["v2026.8.13"], {
      RELEASE_GH_REPO: "fake/fake",
      GH_STUB_MODE: "green",
      GH_STUB_LOG: log,
      PATH: `${join(base, "bin")}:${process.env.PATH}`,
    });
    expect(r.code).toBe(0);
    const releaseCall = readFileSync(log, "utf8")
      .split("\n")
      .find((line) => line.startsWith("release create "));
    expect(releaseCall).toBeDefined();
    expect(releaseCall).not.toContain("isomux-severity");
    expect(releaseCall).not.toContain("--notes");
  });

  it("the release writer and checker use the same marker literal", () => {
    const shell = readFileSync(RELEASE_SH, "utf8").match(
      /^SECURITY_MARKER='([^']+)'$/m,
    );
    const checker = readFileSync(UPDATE_CHECKER, "utf8").match(
      /^export const SECURITY_RELEASE_MARKER = "([^"]+)";$/m,
    );
    expect(shell?.[1]).toBe("isomux-severity: security");
    expect(checker?.[1]).toBe(shell?.[1]);
  });

  it("--security refuses sandbox mode before creating a tag", () => {
    const r = runRelease(["--security", "v2026.8.13"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("cannot be used with RELEASE_SKIP_CI");
    expect(sh(base, "git -C origin.git tag -l v2026.8.13")).toBe("");
  });

  it("a failed security Release creation prints a recovery command that preserves the marker", () => {
    const r = runRelease(["--security", "v2026.8.13"], {
      RELEASE_GH_REPO: "fake/fake",
      GH_STUB_MODE: "release-fail",
      PATH: `${join(base, "bin")}:${process.env.PATH}`,
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(
      "gh release create v2026.8.13 --verify-tag --generate-notes --title v2026.8.13 --notes 'isomux-severity: security'",
    );
    expect(sh(base, "git -C origin.git tag -l v2026.8.13")).toBe("v2026.8.13");
  });

  it("refuses extra arguments before it creates a tag", () => {
    const r = runRelease(["--security", "v2026.8.13", "extra"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("usage:");
    expect(sh(base, "git -C origin.git tag -l")).toBe("");
  });

  it("bun-pin gate: a pin change since the previous release refuses without the override", () => {
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fake", packageManager: "bun@1.0.0" }),
    );
    sh(repo, "git add . && git commit -qm pin1 && git push -q origin main");
    expect(runRelease(["v2026.7.1"]).code).toBe(0);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fake", packageManager: "bun@2.0.0" }),
    );
    sh(repo, "git add . && git commit -qm pin2 && git push -q origin main");
    const refused = runRelease(["v2026.7.2"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("bun pin changed");
    const allowed = runRelease(["v2026.7.2"], {
      RELEASE_SKIP_CI: "1",
      RELEASE_ALLOW_BUN_CHANGE: "1",
    });
    expect(allowed.code).toBe(0);
  });

  it("bun-pin gate: a locally planted higher tag is not the comparison baseline", () => {
    // Reviewer regression: prev-release selection must come from origin's
    // tag namespace. The planted v2099.1.1 points at the pin-less first
    // commit; if it were treated as the previous release, the unchanged-pin
    // release below would be refused.
    const firstCommit = sh(repo, "git rev-parse HEAD");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fake", packageManager: "bun@1.0.0" }),
    );
    sh(repo, "git add . && git commit -qm pin1 && git push -q origin main");
    expect(runRelease(["v2026.7.1"]).code).toBe(0);
    sh(repo, `git tag v2099.1.1 ${firstCommit}`);
    const r = runRelease(["v2026.7.2"]);
    expect(r.code).toBe(0);
  });
});
