// The check for `<writer> | grep -q` in shell scripts (task 8e6cd05d). grep
// -q, -m, -l and -L stop reading at the first match; under pipefail the
// writer then dies of SIGPIPE and the pipeline reads as "no match". The
// rescue-root and auto-deploy tests show the failure itself; this file pins
// the scanner and keeps the shape out of every tracked shell script.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPipedEarlyExitGreps, shellScripts } from "./shell-pipe-grep.ts";

const REPO = join(import.meta.dir, "..");

describe("findPipedEarlyExitGreps", () => {
  test.each<[string, string]>([
    ["-q", "a | grep -q x"],
    ["a cluster with q", "a | grep -Fxq x"],
    ["--quiet", "a | grep --quiet x"],
    ["--silent", "a | grep --silent x"],
    ["-m with a separate count", "a | grep -m 1 x"],
    ["-m with an attached count", "a | grep -m1 x"],
    ["--max-count=N", "a | grep --max-count=1 x"],
    ["-l", "a | grep -l x"],
    ["-L", "a | grep -L x"],
    ["--files-with-matches", "a | grep --files-with-matches x"],
    ["--files-without-match", "a | grep --files-without-match x"],
    ["an option after the pattern", "a | grep -e x -q"],
    [
      "an option after a quoted pattern that holds a pipe",
      "a | grep -E 'x|y' -q",
    ],
    ["egrep", "a | egrep -q x"],
    ["fgrep", "a | fgrep -q x"],
    ["|&", "a |& grep -q x"],
    ["a variable assignment before grep", "a | LC_ALL=C grep -q x"],
    ["command before grep", "a | command grep -q x"],
    ["env before grep", "a | env LC_ALL=C grep -q x"],
    ["env with an option before grep", "a | env -i LC_ALL=C grep -q x"],
    ["an option after a 2>&1 redirection", "a | grep x 2>&1 -q"],
    ["a backslash before grep", "a | \\grep -q x"],
    ["in an if", "if a | grep -q x; then b; fi"],
    ["in a command substitution", "y=$(a | grep -q x && echo 1)"],
    ["in an || list", "a | grep -q x || continue"],
  ])("flags %s", (_what, source) => {
    expect(findPipedEarlyExitGreps(source)).toEqual([1]);
  });

  test.each<[string, string]>([
    ["||", "a || grep -q x f"],
    ["a here-string", 'grep -q x <<<"$v"'],
    ["a process substitution", "grep -q x < <(a)"],
    ["a file argument", "grep -q x f"],
    ["a comment line", "  # a | grep -q x"],
    ["a piped grep that reads all of its input", "a | grep -c x"],
    ["a piped grep with output to /dev/null", "a | grep -E x >/dev/null"],
    ["-s, which is not --silent", "a | grep -s x"],
    ["a grep -q after the pipeline ends with ;", "a | b; grep -q x f"],
    ["a grep -q after the pipeline ends with &&", "a | b && grep -q x f"],
    ["a grep -q after the pipeline ends with ||", "a | b || grep -q x f"],
    ["a -q of the next command, not the piped grep", "a | grep x; grep -q y f"],
    ["a piped command other than grep", "a | sort -q"],
    ["a -q after --, which is the pattern", "a | grep -- -q"],
    ["a -q that is the argument of -e", "a | grep -e -q x"],
  ])("does not flag %s", (_what, source) => {
    expect(findPipedEarlyExitGreps(source)).toEqual([]);
  });

  test("a pipe continued on the next line reports the grep's line", () => {
    expect(
      findPipedEarlyExitGreps("x=1\nif a |\n  grep -qx y; then\n  b\nfi\n"),
    ).toEqual([3]);
    expect(findPipedEarlyExitGreps("a \\\n  | grep -q y\n")).toEqual([2]);
    expect(findPipedEarlyExitGreps("a | \\\n  grep -q y\n")).toEqual([2]);
  });

  test("scans heredoc text, which install.sh uses to embed scripts", () => {
    const source = [
      "cat >/x <<'EOF'",
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "a | grep -q y",
      "EOF",
    ].join("\n");
    expect(findPipedEarlyExitGreps(source)).toEqual([4]);
  });

  test("reports every site, in line order", () => {
    const source = [
      "a | grep -q x",
      "grep -q x f",
      "b | grep -m1 y",
      "c || grep -q z",
      "d | grep --quiet w",
    ].join("\n");
    expect(findPipedEarlyExitGreps(source)).toEqual([1, 3, 5]);
  });
});

describe("shellScripts", () => {
  test("lists tracked *.sh files and sh or bash shebang files, as paths relative to the root, and no other files", () => {
    const scripts = shellScripts(REPO);
    expect({
      sh: scripts.includes("scripts/rescue-root.sh"),
      // Sourced, so it has no shebang: it runs under its caller's pipefail.
      shNoShebang: scripts.includes("scripts/load-test/lib.sh"),
      installer: scripts.includes("deploy/install.sh"),
      bashShebang: scripts.includes(
        "control-plane/deploy/vps/support/hosted-support-read",
      ),
      shShebang: scripts.includes(
        "control-plane/deploy/vps/support/hosted-support-ssh",
      ),
      gitHook: scripts.includes(".githooks/pre-push"),
      python: scripts.includes("deploy/container/supervisor.py"),
      typescript: scripts.includes("scripts/shell-pipe-grep.ts"),
      markdown: scripts.includes("README.md"),
    }).toEqual({
      sh: true,
      shNoShebang: true,
      installer: true,
      bashShebang: true,
      shShebang: true,
      gitHook: true,
      python: false,
      typescript: false,
      markdown: false,
    });
  });

  test("no tracked shell script pipes into a grep that stops early", () => {
    const sites: Record<string, number[]> = {};
    for (const file of shellScripts(REPO)) {
      const lines = findPipedEarlyExitGreps(
        readFileSync(join(REPO, file), "utf8"),
      );
      if (lines.length > 0) sites[file] = lines;
    }
    // Fix: grep -q pat <<<"$var", grep -q pat < <(writer), or a grep that
    // reads all of its input (no -q, output to /dev/null).
    expect(sites).toEqual({});
  });
});
