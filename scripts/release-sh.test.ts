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
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync, spawnSync } from "child_process";
import { hasSecurityReleaseMarker } from "../server/update-checker.ts";

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
  cwd: string = repo,
): { code: number; out: string } {
  // A real release exports _ISOMUX_RELEASE_LOGGED (its log path) to its whole process
  // tree - including the pre-push CI that runs this suite - so an inherited
  // value makes every spawned release.sh skip the pointer line and the
  // log-file assertions fail exactly and only during an actual release.
  const { _ISOMUX_RELEASE_LOGGED: _drop, ...ambient } = process.env;
  const r = spawnSync("bash", [RELEASE_SH, ...args], {
    cwd,
    env: { ...ambient, TMPDIR: base, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

function releaseLogPath(out: string): string {
  const match = out.match(/^\[isomux-release\] full output: (.+)$/m);
  expect(match).not.toBeNull();
  return match![1];
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
if [[ $1 == release ]]; then
  prev=""
  for a in "$@"; do
    [[ $prev == --notes-file || $prev == -F ]] && cp "$a" "\${GH_STUB_NOTES:-/dev/null}"
    [[ $a == --notes-file=* ]] && cp "\${a#--notes-file=}" "\${GH_STUB_NOTES:-/dev/null}"
    prev=$a
  done
fi
[[ \${GH_STUB_MODE:-green} == release-fail && $1 == release ]] && exit 9
if [[ $1 == api ]]; then
  jqexpr=""
  while (($#)); do [[ $1 == --jq ]] && jqexpr=$2; shift; done
  case \${GH_STUB_MODE:-green} in
    green|release-fail) body='{"workflow_runs":[{"run_number":1,"status":"completed","conclusion":"success","path":".github/workflows/build.yml"},{"run_number":1,"status":"completed","conclusion":"success","display_title":"Install smoke (release set)","path":".github/workflows/install-smoke.yml"}]}' ;;
    unrelated) body='{"workflow_runs":[{"run_number":1,"status":"completed","conclusion":"success","path":".github/workflows/other.yml"}]}' ;;
    failed) body='{"workflow_runs":[{"run_number":2,"status":"completed","conclusion":"failure","path":".github/workflows/build.yml"}]}' ;;
    smoke-missing) body='{"workflow_runs":[{"run_number":1,"status":"completed","conclusion":"success","path":".github/workflows/build.yml"}]}' ;;
    smoke-scheduled) body='{"workflow_runs":[{"run_number":1,"status":"completed","conclusion":"success","path":".github/workflows/build.yml"},{"run_number":4,"status":"completed","conclusion":"success","event":"schedule","display_title":"Install smoke (weekly set)","path":".github/workflows/install-smoke.yml"}]}' ;;
    smoke-weekly-dispatched) body='{"workflow_runs":[{"run_number":1,"status":"completed","conclusion":"success","path":".github/workflows/build.yml"},{"run_number":5,"status":"completed","conclusion":"failure","event":"workflow_dispatch","display_title":"Install smoke (weekly set)","path":".github/workflows/install-smoke.yml"}]}' ;;
    smoke-failed) body='{"workflow_runs":[{"run_number":1,"status":"completed","conclusion":"success","path":".github/workflows/build.yml"},{"run_number":3,"status":"completed","conclusion":"failure","display_title":"Install smoke (release set)","path":".github/workflows/install-smoke.yml"},{"run_number":2,"status":"completed","conclusion":"success","display_title":"Install smoke (release set)","path":".github/workflows/install-smoke.yml"}]}' ;;
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
  ghLog?: string,
): { code: number; out: string } {
  return runRelease(args, {
    RELEASE_GH_REPO: "fake/fake",
    GH_STUB_MODE: mode,
    PATH: `${join(base, "bin")}:${process.env.PATH}`,
    ...(ghLog ? { GH_STUB_LOG: ghLog } : {}),
  });
}

const SMOKE_DISPATCH =
  "workflow run install-smoke.yml --repo fake/fake --ref main";

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("release.sh", () => {
  it("is directly executable as its operator runbook says", () => {
    expect(statSync(RELEASE_SH).mode & 0o111).not.toBe(0);
  });

  it("tags today's CalVer, annotated, and pushes it to origin", () => {
    const r = runRelease([]);
    expect(r.out).toContain("tagged and pushed");
    expect(r.code).toBe(0);
    const tag = todayTag();
    expect(sh(repo, `git cat-file -t refs/tags/${tag}`)).toBe("tag");
    expect(sh(base, `git -C origin.git tag -l ${tag}`)).toBe(tag);
  });

  it("refuses extra arguments before it creates a tag, and keeps the failure in the printed log file", () => {
    const r = runRelease(["--security", "v2026.7.18", "extra"]);
    expect(r.code).not.toBe(0);
    const log = readFileSync(releaseLogPath(r.out), "utf8");
    expect(log).toContain("usage: scripts/release.sh");
    expect(sh(base, "git -C origin.git tag -l")).toBe("");
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

  it("smoke gate: a commit with no Install smoke run starts one and is not tagged", () => {
    const log = join(base, "gh.log");
    const r = runWithCiStub("smoke-missing", [], log);
    expect(r.code).not.toBe(0);
    expect(readFileSync(log, "utf8")).toContain(SMOKE_DISPATCH);
    expect(sh(base, "git -C origin.git tag -l")).toBe("");
  });

  it("smoke gate: a green scheduled weekly set does not count, so a release-set run is started", () => {
    const log = join(base, "gh.log");
    const r = runWithCiStub("smoke-scheduled", [], log);
    expect(r.code).not.toBe(0);
    expect(readFileSync(log, "utf8")).toContain(SMOKE_DISPATCH);
    expect(sh(base, "git -C origin.git tag -l")).toBe("");
  });

  it("smoke gate: the title suffix it counts is the one the workflow gives a release-set run", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../.github/workflows/install-smoke.yml"),
      "utf8",
    );
    const runName = workflow.match(/^run-name: >-\n {2}(.+)$/m)?.[1];
    expect(runName).toContain("Install smoke (${{");
    expect(runName).toContain("'release set' }})");
    expect(readFileSync(RELEASE_SH, "utf8")).toContain(
      'latest_run .github/workflows/install-smoke.yml "(release set)"',
    );
  });

  it("smoke gate: a red weekly set started by hand does not count either", () => {
    const log = join(base, "gh.log");
    const r = runWithCiStub("smoke-weekly-dispatched", [], log);
    expect(r.code).not.toBe(0);
    expect(readFileSync(log, "utf8")).toContain(SMOKE_DISPATCH);
    expect(sh(base, "git -C origin.git tag -l")).toBe("");
  });

  it("smoke gate: the latest Install smoke run decides, and a red one refuses", () => {
    const log = join(base, "gh.log");
    const r = runWithCiStub("smoke-failed", [], log);
    expect(r.code).not.toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("workflow run");
    expect(sh(base, "git -C origin.git tag -l")).toBe("");
  });

  it("smoke gate: a commit behind the tip of main is not dispatched", () => {
    writeFileSync(join(repo, "f.txt"), "two\n");
    sh(repo, "git add . && git commit -qm two && git push -q origin main");
    sh(repo, "git checkout -q --detach HEAD~1");
    const log = join(base, "gh.log");
    const r = runWithCiStub("smoke-missing", [], log);
    expect(r.code).not.toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("workflow run");
    expect(sh(base, "git -C origin.git tag -l")).toBe("");
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
});

describe("release.sh --notes-file", () => {
  const MARKER = "isomux-severity: security";
  // Shell-active text and an inline mention of the marker: the body must be
  // the note verbatim, and only a whole marker line makes a security release.
  const NOTE =
    "OpenCode agents now run `opencode` 2 ($HOME, \"quotes\", 'single', \\ and $(echo x)).\n\n" +
    "- Releases marked isomux-severity: security still need the flag.\n\n\n";

  function writeNote(name: string, text: string = NOTE): string {
    const dir = join(base, "notes");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  }

  function runNotes(
    args: string[],
    extra: { mode?: string; cwd?: string; path?: string } = {},
  ): { code: number; out: string; ghLog: string; body: string | null } {
    const ghLog = join(base, "gh.log");
    const notesCopy = join(base, "gh-notes-copy.md");
    const r = runRelease(
      args,
      {
        RELEASE_GH_REPO: "fake/fake",
        GH_STUB_MODE: extra.mode ?? "green",
        GH_STUB_LOG: ghLog,
        GH_STUB_NOTES: notesCopy,
        PATH: `${extra.path ? `${extra.path}:` : ""}${join(base, "bin")}:${process.env.PATH}`,
      },
      extra.cwd ?? repo,
    );
    let log = "";
    try {
      log = readFileSync(ghLog, "utf8");
    } catch {}
    let body: string | null = null;
    try {
      body = readFileSync(notesCopy, "utf8");
    } catch {}
    return { ...r, ghLog: log, body };
  }

  function releaseCall(ghLog: string): string[] {
    const line = ghLog.split("\n").find((l) => l.startsWith("release create "));
    expect(line).toBeDefined();
    return line!.trim().split(" ");
  }

  function expectNoTag(ghLog: string) {
    expect(sh(repo, "git tag -l")).toBe("");
    expect(sh(base, "git -C origin.git tag -l")).toBe("");
    expect(ghLog).not.toContain("release create");
  }

  it("an ordinary release puts the note verbatim above the generated notes, with no marker", () => {
    const note = writeNote("note.md");
    const r = runNotes(["--notes-file", note, "v2026.8.13"]);
    expect(r.code).toBe(0);
    expect(sh(base, "git -C origin.git tag -l v2026.8.13")).toBe("v2026.8.13");
    const call = releaseCall(r.ghLog);
    expect(call).toContain("--generate-notes");
    expect(call).not.toContain("--notes");
    expect(call).not.toContain("-n");
    expect(r.body).not.toBeNull();
    expect(r.body!.trimEnd()).toBe(NOTE.trimEnd());
    expect(hasSecurityReleaseMarker(r.body)).toBe(false);
  });

  it("a security release puts the note first and the marker line after it, flags in either order", () => {
    const note = writeNote("note.md");
    const r = runNotes(["--notes-file", note, "--security", "v2026.8.13"]);
    expect(r.code).toBe(0);
    const call = releaseCall(r.ghLog);
    expect(call).toContain("--generate-notes");
    expect(call).not.toContain("--notes");
    expect(r.body!.trimEnd()).toBe(`${NOTE.trimEnd()}\n\n${MARKER}`);
    expect(hasSecurityReleaseMarker(r.body)).toBe(true);
  });

  it("a relative path resolves from the caller's directory, not the checkout root", () => {
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "note.md"), NOTE);
    writeFileSync(join(repo, "note.md"), "decoy at the checkout root\n");
    sh(repo, "git add . && git commit -qm notes && git push -q origin main");
    const r = runNotes(["--notes-file", "note.md", "v2026.8.13"], {
      cwd: join(repo, "docs"),
    });
    expect(r.code).toBe(0);
    expect(r.body!.trimEnd()).toBe(NOTE.trimEnd());
  });

  // Each case would otherwise release (valid tag, green CI); the refusal must
  // come before the tag, and the output names what was wrong.
  const refusals: [
    string,
    () => { args: string[]; env?: Record<string, string> },
    string[],
  ][] = [
    [
      "a file that does not exist",
      () => ({
        args: ["--notes-file", join(base, "absent-note.md"), "v2026.8.13"],
      }),
      ["absent-note.md"],
    ],
    [
      "a directory",
      () => {
        mkdirSync(join(base, "note-dir.md"));
        return {
          args: ["--notes-file", join(base, "note-dir.md"), "v2026.8.13"],
        };
      },
      ["note-dir.md"],
    ],
    [
      "a whitespace-only file",
      () => ({
        args: [
          "--notes-file",
          writeNote("blank-note.md", " \n\t\n\n"),
          "v2026.8.13",
        ],
      }),
      ["blank-note.md"],
    ],
    [
      "a note with a marker line, ordinary release",
      () => ({
        args: [
          "--notes-file",
          writeNote("marker-note.md", `Intro.\n${MARKER}\nMore.\n`),
          "v2026.8.13",
        ],
      }),
      ["marker-note.md"],
    ],
    [
      "a note with an indented marker line, security release",
      () => ({
        args: [
          "--security",
          "--notes-file",
          writeNote("indented-note.md", `Intro.\n\t ${MARKER}  \nMore.\n`),
          "v2026.8.13",
        ],
      }),
      ["indented-note.md"],
    ],
    [
      "a note with a CRLF marker line",
      () => ({
        args: [
          "--notes-file",
          writeNote("crlf-note.md", `Intro.\r\n${MARKER}\r\nMore.\r\n`),
          "v2026.8.13",
        ],
      }),
      ["crlf-note.md"],
    ],
    [
      "sandbox mode",
      () => ({
        args: ["--notes-file", writeNote("note.md"), "v2026.8.13"],
        env: { RELEASE_SKIP_CI: "1" },
      }),
      ["RELEASE_SKIP_CI"],
    ],
    [
      "a repeated --notes-file",
      () => ({
        args: [
          "--notes-file",
          writeNote("one.md"),
          "--notes-file",
          writeNote("two.md"),
          "v2026.8.13",
        ],
      }),
      ["usage: scripts/release.sh", "--notes-file"],
    ],
    [
      "--notes-file without a path",
      () => ({ args: ["--notes-file"] }),
      ["usage: scripts/release.sh", "--notes-file"],
    ],
    [
      "an unknown flag",
      () => ({ args: ["--bogus", "v2026.8.13"] }),
      ["usage: scripts/release.sh", "--notes-file"],
    ],
  ];

  it.each(refusals)(
    "refuses %s before it creates a tag",
    (_name, setup, said) => {
      const { args, env } = setup();
      const r = env ? { ...runRelease(args, env), ghLog: "" } : runNotes(args);
      expect(r.code).not.toBe(0);
      for (const s of said) expect(r.out).toContain(s);
      expectNoTag(r.ghLog);
    },
  );

  it("a failed Release creation prints a recovery command whose notes file still holds the note and the marker", () => {
    const note = writeNote("note.md");
    const r = runNotes(["--security", "--notes-file", note, "v2026.8.13"], {
      mode: "release-fail",
    });
    expect(r.code).not.toBe(0);
    expect(sh(base, "git -C origin.git tag -l v2026.8.13")).toBe("v2026.8.13");
    const recovery = r.out.match(/(gh release create v2026\.8\.13 .*)$/m)?.[1];
    expect(recovery).toBeDefined();
    const tokens = recovery!.trim().split(" ");
    expect(tokens).toContain("--generate-notes");
    expect(tokens).not.toContain("--notes");
    const i = tokens.findIndex((t) => t === "--notes-file" || t === "-F");
    expect(i).toBeGreaterThan(-1);
    const body = readFileSync(tokens[i + 1], "utf8");
    expect(body.trimEnd()).toBe(`${NOTE.trimEnd()}\n\n${MARKER}`);
  });

  it("names the body file after the printed run log, even when the inner run's clock has moved on", () => {
    // A date stub that returns a new stamp on each call: the outer and the
    // inner run get different stamps, as they do across a second boundary.
    const clockBin = join(base, "clock-bin");
    mkdirSync(clockBin);
    const realDate = sh(base, "command -v date");
    writeFileSync(
      join(clockBin, "date"),
      `#!/usr/bin/env bash
if [[ \${1:-} == +%Y%m%dT%H%M%S ]]; then
  n=$(( $(cat "${join(base, "clock-count")}" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"${join(base, "clock-count")}"
  printf '20260101T0000%02d\\n' "$n"
  exit 0
fi
exec ${realDate} "$@"
`,
    );
    chmodSync(join(clockBin, "date"), 0o755);
    const note = writeNote("note.md");
    const r = runNotes(["--notes-file", note, "v2026.8.13"], {
      path: clockBin,
    });
    expect(r.code).toBe(0);
    // The stub ran in both runs, so the stamps differed.
    expect(
      Number(readFileSync(join(base, "clock-count"), "utf8")),
    ).toBeGreaterThan(1);
    const call = releaseCall(r.ghLog);
    const i = call.findIndex((t) => t === "--notes-file" || t === "-F");
    expect(i).toBeGreaterThan(-1);
    expect(call[i + 1]).toBe(
      releaseLogPath(r.out).replace(/\.log$/, "-notes.md"),
    );
  });
});
