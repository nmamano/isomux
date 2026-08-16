// Stage only the provisioner's Stripe test credential. The importer reads a
// strict file inside this process and cannot name any other Fly secret.

import * as os from "node:os";
import * as path from "node:path";
import { readAllowlistedEnvFile } from "./allowlisted-env-file.ts";
import { APP, FLY_TOKEN_FILE, readSecretFile, realSpawn } from "./fly-cli.ts";
import { STRIPE_SECRET_NAME, STRIPE_SECRET_NAMES } from "./secret-names.ts";
import { namesPresent, pushSecrets } from "./secrets.ts";

export { STRIPE_SECRET_NAME, STRIPE_SECRET_NAMES } from "./secret-names.ts";

export function readStripeFile(file: string): Map<string, string> {
  const values = readAllowlistedEnvFile(
    file,
    STRIPE_SECRET_NAMES,
    "the Stripe",
  );
  if (!/^(?:sk|rk)_test_.+$/.test(values.get(STRIPE_SECRET_NAME) ?? "")) {
    throw new Error("the Stripe credential is not a test-mode key");
  }
  return values;
}

async function main(): Promise<void> {
  const verify = process.argv.length === 3 && process.argv[2] === "--verify";
  if (process.argv.length > (verify ? 3 : 2)) {
    throw new Error("usage: stripe-secrets.ts [--verify]");
  }
  const flyToken = readSecretFile(FLY_TOKEN_FILE);
  if (verify) {
    const answer = await namesPresent({
      required: STRIPE_SECRET_NAMES,
      flyToken,
      spawn: realSpawn,
    });
    console.log(`listing_readable: ${answer.readable}`);
    console.log(`required_secret_names_present: ${answer.present}`);
    process.exitCode = answer.present ? 0 : 1;
    return;
  }
  const values = readStripeFile(
    path.join(os.homedir(), ".config", "isomux", "control-plane-stripe.env"),
  );
  const outcome = await pushSecrets({
    pairs: [
      { name: STRIPE_SECRET_NAME, value: values.get(STRIPE_SECRET_NAME)! },
    ],
    allowed: STRIPE_SECRET_NAMES,
    flyToken,
    spawn: realSpawn,
    app: APP,
  });
  console.log(`validated: ${outcome.problems.length === 0}`);
  console.log(`spawned: ${outcome.spawned}`);
  console.log(`flyctl_exit: ${outcome.exitCode}`);
  console.log(`value_in_child_output: ${outcome.valueInChildOutput}`);
  process.exitCode =
    outcome.spawned && outcome.exitCode === 0 && !outcome.valueInChildOutput
      ? 0
      : 1;
}

if (import.meta.main) await main();
