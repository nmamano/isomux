import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawn } from "./fly-cli.ts";
import { BOOT_REQUIRED_NAMES, pushSecrets, validatePairs } from "./secrets.ts";
import {
  STRIPE_MODE_NAME,
  STRIPE_SECRET_NAME,
  STRIPE_SECRET_NAMES,
  STRIPE_WEBHOOK_SECRET_NAME,
  readStripeFile,
  requiredStripeNames,
  stagedStripeNames,
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
  test("reads exactly the two Stripe credentials and preserves internal spaces", () => {
    const file = credentialFile(
      "STRIPE_TEST_SECRET_KEY='sk_test_public fixture value'\n" +
        "STRIPE_WEBHOOK_SECRET='whsec_public'\n",
    );
    expect(readStripeFile(file, "test").get(STRIPE_SECRET_NAME)).toBe(
      "sk_test_public fixture value",
    );
  });

  test("refuses a live key", () => {
    const file = credentialFile(
      "STRIPE_TEST_SECRET_KEY='sk_live_public'\n" +
        "STRIPE_WEBHOOK_SECRET='whsec_public'\n",
    );
    expect(() => readStripeFile(file, "test")).toThrow(
      "does not match test mode",
    );
  });

  test("refuses a value that is not a webhook signing secret", () => {
    const file = credentialFile(
      "STRIPE_TEST_SECRET_KEY='rk_test_public'\n" +
        "STRIPE_WEBHOOK_SECRET='not-a-webhook-secret'\n",
    );
    expect(() => readStripeFile(file, "test")).toThrow("not a signing secret");
  });

  test("live mode accepts only a restricted live key and its live signing name", () => {
    const restricted = credentialFile(
      "STRIPE_LIVE_SECRET_KEY='rk_live_public_shape'\n" +
        "STRIPE_LIVE_WEBHOOK_SECRET='whsec_public'\n",
    );
    expect(
      readStripeFile(restricted, "live").get("STRIPE_LIVE_SECRET_KEY"),
    ).toBe("rk_live_public_shape");

    const account = credentialFile(
      "STRIPE_LIVE_SECRET_KEY='sk_live_public_shape'\n" +
        "STRIPE_LIVE_WEBHOOK_SECRET='whsec_public'\n",
    );
    expect(() => readStripeFile(account, "live")).toThrow(
      "does not match live mode",
    );
  });

  test("refuses a malformed, unknown, repeated, missing, or loose-mode file", () => {
    const cases = [
      credentialFile(
        "export STRIPE_TEST_SECRET_KEY='sk_test_public'\n" +
          "STRIPE_WEBHOOK_SECRET='whsec_public'\n",
      ),
      credentialFile(
        "OTHER='sk_test_public'\nSTRIPE_WEBHOOK_SECRET='whsec_public'\n",
      ),
      credentialFile(
        "STRIPE_TEST_SECRET_KEY='sk_test_one'\n" +
          "STRIPE_TEST_SECRET_KEY='sk_test_two'\n" +
          "STRIPE_WEBHOOK_SECRET='whsec_public'\n",
      ),
      credentialFile(""),
      credentialFile(
        "STRIPE_TEST_SECRET_KEY='sk_test_public'\n" +
          "STRIPE_WEBHOOK_SECRET='whsec_public'\n",
        0o640,
      ),
    ];
    for (const file of cases)
      expect(() => readStripeFile(file, "test")).toThrow();
  });
});

describe("the Stripe importer allowlist", () => {
  test("contains only the runtime Stripe credentials", () => {
    expect([...STRIPE_SECRET_NAMES]).toEqual([
      "CONTROL_PLANE_STRIPE_MODE",
      "STRIPE_TEST_SECRET_KEY",
      "STRIPE_LIVE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_LIVE_WEBHOOK_SECRET",
    ]);
  });

  test("staging admits the explicit mode name in both modes; verify demands it only for live", () => {
    // The importer always stages the mode pair, so the allowed list it hands
    // pushSecrets must admit it - in test mode too. Broken on 2026-08-21: the
    // verify list stood in for the staging list, and every test-mode staging
    // was refused as "not an allowed secret name: CONTROL_PLANE_STRIPE_MODE".
    const pairs = [
      { name: STRIPE_MODE_NAME, value: "test" },
      { name: "STRIPE_TEST_SECRET_KEY", value: "rk_test_public_fixture" },
      { name: "STRIPE_WEBHOOK_SECRET", value: "whsec_public_fixture" },
    ];
    expect(validatePairs(pairs, stagedStripeNames("test"))).toEqual([]);
    expect(stagedStripeNames("live")).toContain(STRIPE_MODE_NAME);
    expect(requiredStripeNames("test")).not.toContain(STRIPE_MODE_NAME);
    expect(requiredStripeNames("live")).toContain(STRIPE_MODE_NAME);
  });

  test("refuses every other boot secret before a child starts", async () => {
    for (const name of BOOT_REQUIRED_NAMES) {
      if ((STRIPE_SECRET_NAMES as readonly string[]).includes(name)) continue;
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
      pairs: [
        { name: STRIPE_SECRET_NAME, value },
        { name: STRIPE_WEBHOOK_SECRET_NAME, value: "whsec_public" },
      ],
      allowed: STRIPE_SECRET_NAMES,
      flyToken: "public-token",
      spawn,
    });
    expect(calls[0].argv.join(" ")).not.toContain(value);
    expect(calls[0].stdin).toBe(
      `${STRIPE_SECRET_NAME}=${value}\n` +
        `${STRIPE_WEBHOOK_SECRET_NAME}=whsec_public\n`,
    );
    expect(JSON.stringify(outcome)).not.toContain(value);
    expect(outcome.valueInChildOutput).toBe(true);
  });
});
