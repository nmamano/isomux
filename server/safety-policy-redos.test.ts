// The safety hook reads every shell command an agent runs, so a regex in it
// that backtracks exponentially on crafted text stalls the hook (task
// 0c5817c2, CodeQL js/redos). Each long command here must get the verdict
// its short form gets, and fast. JSC gives up a pathological match after
// about a second and treats it as no match, so a slow regex shows as time,
// not as a hang.

import { describe, expect, it } from "bun:test";
import { evaluateProposedAction } from "./safety-policy.ts";

// These commands are classified only; none of them execute.
const context = { cwd: "/tmp/safety-redos", shellHome: "/home/probe" };

function decide(command: string): string {
  return evaluateProposedAction({ kind: "shell", command }, context).decision;
}

// A path with many empty segments: "//////x/usr/bin/ls" names /x/usr/bin/ls.
const slashes = (n: number) => "/".repeat(n);

describe("the safety hook on crafted command text", () => {
  it.each([
    // An absolute command path that names neither rm nor git.
    [
      "a long path to another command",
      "/x/usr/bin/ls -la",
      `${slashes(30)}x/usr/bin/ls -la`,
    ],
    // An absolute git path: rm's pattern must fail fast before git's matches.
    [
      "a long path to git",
      "/x/usr/bin/git reset --hard",
      `${slashes(30)}x/usr/bin/git reset --hard`,
    ],
    // A command name of variables whose names end in a digit, then a
    // character no plain name has.
    ["a command name of many variables", "$A0$A0`", `${"$A0".repeat(30)}\``],
  ])(
    "%s gets its short form's verdict, fast",
    (_, short, long) => {
      const expected = decide(short);
      const started = performance.now();
      const verdict = decide(long);
      const elapsed = performance.now() - started;
      expect(verdict).toBe(expected);
      expect(elapsed).toBeLessThan(1000);
    },
    // Room for the slow regex to finish, so a regression reads as the time
    // assertion above, not as a test timeout.
    30_000,
  );

  it("still reads an absolute rm or git path as rm or git", () => {
    expect(decide(`${slashes(30)}x/bin/rm -rf /home/probe`)).toBe("deny");
    expect(decide("/usr/local/sbin/git reset --hard")).toBe("deny");
    expect(decide("/usr/local/sbin/git status")).toBe("allow");
  });
});
