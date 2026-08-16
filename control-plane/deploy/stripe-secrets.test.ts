import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawn } from "./fly-cli.ts";
import { BOOT_REQUIRED_NAMES, pushSecrets } from "./secrets.ts";
import {
  STRIPE_SECRET_NAME,
  STRIPE_SECRET_NAMES,
  readStripeFile,
} from "./stripe-secrets.ts";

const dirs: string[] = [];

function credentialFile(contents: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "isomux-stripe-secret-test-"));
  dirs.push(dir);
  const file = join(dir, "stripe.env");
  writeFileSync(file, contents, { mode });
  chmodSync(file, mode);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the Stripe source file", () => {
  test("reads exactly one test credential and preserves internal spaces", () => {
    const file = credentialFile(
      "STRIPE_TEST_SECRET_KEY='sk_test_public fixture value'\n",
    );
    expect(readStripeFile(file).get(STRIPE_SECRET_NAME)).toBe(
      "sk_test_public fixture value",
    );
  });

  test("refuses a live key", () => {
    const file = credentialFile("STRIPE_TEST_SECRET_KEY='sk_live_public'\n");
    expect(() => readStripeFile(file)).toThrow("not a test-mode key");
  });

  test("refuses a malformed, unknown, repeated, missing, or loose-mode file", () => {
    const cases = [
      credentialFile("export STRIPE_TEST_SECRET_KEY='sk_test_public'\n"),
      credentialFile("OTHER='sk_test_public'\n"),
      credentialFile(
        "STRIPE_TEST_SECRET_KEY='sk_test_one'\nSTRIPE_TEST_SECRET_KEY='sk_test_two'\n",
      ),
      credentialFile(""),
      credentialFile("STRIPE_TEST_SECRET_KEY='sk_test_public'\n", 0o640),
    ];
    for (const file of cases) expect(() => readStripeFile(file)).toThrow();
  });
});

describe("the Stripe importer allowlist", () => {
  test("contains only the runtime key", () => {
    expect([...STRIPE_SECRET_NAMES]).toEqual(["STRIPE_TEST_SECRET_KEY"]);
  });

  test("refuses every other boot secret before a child starts", async () => {
    for (const name of BOOT_REQUIRED_NAMES) {
      if (name === STRIPE_SECRET_NAME) continue;
      let spawned = false;
      const spawn: Spawn = async () => {
        spawned = true;
        return { code: 0, stdout: "", stderr: "" };
      };
      const outcome = await pushSecrets({
        pairs: [{ name, value: "public fixture" }],
        allowed: STRIPE_SECRET_NAMES,
        flyToken: "public-token",
        spawn,
      });
      expect({ name, spawned: outcome.spawned }).toEqual({
        name,
        spawned: false,
      });
      expect(spawned).toBe(false);
    }
  });

  test("passes the key on stdin, not argv, and drops child output", async () => {
    const value = "sk_test_public fixture value";
    const calls: { argv: string[]; stdin: string }[] = [];
    const spawn: Spawn = async (argv, _env, stdin) => {
      calls.push({ argv, stdin });
      return { code: 0, stdout: `echo ${value.slice(0, 10)}`, stderr: value };
    };
    const outcome = await pushSecrets({
      pairs: [{ name: STRIPE_SECRET_NAME, value }],
      allowed: STRIPE_SECRET_NAMES,
      flyToken: "public-token",
      spawn,
    });
    expect(calls[0].argv.join(" ")).not.toContain(value);
    expect(calls[0].stdin).toBe(`${STRIPE_SECRET_NAME}=${value}\n`);
    expect(JSON.stringify(outcome)).not.toContain(value);
    expect(outcome.valueInChildOutput).toBe(true);
  });
});
