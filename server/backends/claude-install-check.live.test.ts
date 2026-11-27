// The contract of the bundled `claude auth status`, live tier
// (ISOMUX_TEST_LIVE=1), task 8705a06f. The sign-in check on macOS reads its
// exit code and loggedIn field; the fake-CLI cases in
// claude-install-check.test.ts pin how they are read, and this checks the
// real CLI still answers that way after an SDK upgrade. No model is called.
// It starts a ~200 MB binary, whose time under parallel CI load reached the
// test budget, so it is not in CI.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLAUDE_NATIVE_BIN } from "../engine-binaries.ts";
import { LIVE } from "../test-support/live-gate.ts";
import { runClaudeAuthStatus } from "./claude-install-check.ts";

const root = mkdtempSync(join(tmpdir(), "isomux-claude-auth-live-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!LIVE)("bundled claude auth status", () => {
  it("reports an empty config dir as signed out", async () => {
    const env = {
      CLAUDE_CONFIG_DIR: root,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    };
    const started = Date.now();
    // Half the test budget: a slow start fails here, as "unknown".
    const state = await runClaudeAuthStatus(env, CLAUDE_NATIVE_BIN, 2_500);
    expect({ state, ms: Date.now() - started }).toEqual({
      state: "signed_out",
      ms: expect.any(Number),
    });
  });
});
