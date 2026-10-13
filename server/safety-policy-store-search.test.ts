// A recursive search rooted at the secret store or above it reads the store
// (secrets loop, B4). The hooks refuse it unless it excludes secrets/.
// Accident protection, as for the direct reads of the store.

import { describe, expect, it } from "bun:test";
import { dirname, join } from "path";

import { STATE_ROOT } from "./config.ts";
import { evaluateProposedAction } from "./safety-policy.ts";

const ABOVE = dirname(STATE_ROOT);
const OUTSIDE = "/tmp/probe-project";

const bash = (command: string, cwd: string = OUTSIDE) =>
  evaluateProposedAction({ kind: "shell", command }, { cwd }).decision;
const grep = (input: Record<string, unknown>, cwd: string = OUTSIDE) =>
  evaluateProposedAction(
    { kind: "read-files", toolName: "Grep", input },
    { cwd },
  ).decision;

describe("a search that reaches the secret store", () => {
  it("is refused for grep -r, rg and ag rooted at the state root or above", () => {
    for (const command of [
      `grep -r token ${STATE_ROOT}`,
      `grep -rn token ${ABOVE}`,
      `grep --recursive token ${STATE_ROOT}/`,
      `grep -R -i token ${join(STATE_ROOT, "secrets")}`,
      `egrep -d recurse token ${STATE_ROOT}`,
      `rg token ${STATE_ROOT}`,
      `rg -g '*.json' token ${ABOVE}`,
      `ag token ${STATE_ROOT}`,
      `sudo grep -r token ${STATE_ROOT}`,
      `bash -c "grep -r token ${STATE_ROOT}"`,
    ])
      expect(bash(command), command).toBe("deny");
  });

  it("is refused when the working directory is the root and no path is given", () => {
    expect(bash("grep -r token", ABOVE)).toBe("deny");
    expect(bash("rg token", STATE_ROOT)).toBe("deny");
    expect(grep({ pattern: "token" }, ABOVE)).toBe("deny");
  });

  it("is refused for the Grep tool rooted at the state root or above", () => {
    expect(grep({ pattern: "token", path: STATE_ROOT })).toBe("deny");
    expect(grep({ pattern: "token", path: ABOVE, glob: "*.json" })).toBe(
      "deny",
    );
  });
});

describe("what stays allowed", () => {
  it("a search that excludes secrets/", () => {
    expect(bash(`grep -r --exclude-dir=secrets token ${STATE_ROOT}`)).toBe(
      "allow",
    );
    expect(bash(`grep -rn --exclude-dir secrets token ${ABOVE}`)).toBe("allow");
    expect(bash(`rg -g '!secrets/**' token ${STATE_ROOT}`)).toBe("allow");
    expect(bash(`rg --glob='!**/secrets/**' token ${ABOVE}`)).toBe("allow");
    expect(bash(`ag --ignore-dir secrets token ${STATE_ROOT}`)).toBe("allow");
    expect(
      grep({ pattern: "token", path: ABOVE, glob: "!**/secrets/**" }),
    ).toBe("allow");
  });

  it("a search beside the store or below it elsewhere, and a plain grep of one file", () => {
    expect(bash(`grep -r token ${join(STATE_ROOT, "logs")}`)).toBe("allow");
    expect(bash(`grep -r token ${OUTSIDE}`)).toBe("allow");
    expect(bash("grep -r token .")).toBe("allow");
    expect(bash("rg token")).toBe("allow");
    expect(bash(`grep token ${join(STATE_ROOT, "agents.json")}`)).toBe("allow");
    // Not recursive: grep reads only the named file.
    expect(bash(`grep -n token ${ABOVE}/notes.txt`)).toBe("allow");
    expect(bash(`grep -e r token ${ABOVE}/notes.txt`)).toBe("allow");
    expect(grep({ pattern: "token" })).toBe("allow");
    expect(grep({ pattern: "token", path: join(STATE_ROOT, "logs") })).toBe(
      "allow",
    );
  });
});
