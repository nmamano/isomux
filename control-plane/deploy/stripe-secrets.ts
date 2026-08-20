// Stage only the provisioner's Stripe credentials for one explicit mode.

import * as os from "node:os";
import * as path from "node:path";
import { readAllowlistedEnvFile } from "./allowlisted-env-file.ts";
import { APP, FLY_TOKEN_FILE, readSecretFile, realSpawn } from "./fly-cli.ts";
import { STRIPE_MODE_NAME } from "./secret-names.ts";
import {
  stripeKeyName,
  stripeWebhookSecretName,
  type StripeMode,
} from "../stripe/mode.ts";
import { namesPresent, pushSecrets } from "./secrets.ts";

export {
  STRIPE_LIVE_SECRET_NAME,
  STRIPE_LIVE_WEBHOOK_SECRET_NAME,
  STRIPE_MODE_NAME,
  STRIPE_SECRET_NAMES,
  STRIPE_TEST_SECRET_NAME,
  STRIPE_TEST_WEBHOOK_SECRET_NAME,
  STRIPE_TEST_SECRET_NAME as STRIPE_SECRET_NAME,
  STRIPE_TEST_WEBHOOK_SECRET_NAME as STRIPE_WEBHOOK_SECRET_NAME,
} from "./secret-names.ts";

export function readStripeFile(
  file: string,
  mode: StripeMode,
): Map<string, string> {
  const names = [stripeKeyName(mode), stripeWebhookSecretName(mode)] as const;
  const values = readAllowlistedEnvFile(file, names, "the Stripe");
  const key = values.get(stripeKeyName(mode)) ?? "";
  if (
    (mode === "test" && !/^(?:sk|rk)_test_.+$/.test(key)) ||
    (mode === "live" && !/^rk_live_.+$/.test(key))
  ) {
    throw new Error(`the Stripe credential does not match ${mode} mode`);
  }
  if (
    !/^whsec_[A-Za-z0-9]+$/.test(
      values.get(stripeWebhookSecretName(mode)) ?? "",
    )
  ) {
    throw new Error("the Stripe webhook credential is not a signing secret");
  }
  return values;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const mode: StripeMode = args.includes("--live") ? "live" : "test";
  const allowedArgs = new Set(["--verify", "--live"]);
  if (
    args.some((arg) => !allowedArgs.has(arg)) ||
    new Set(args).size !== args.length ||
    args.length > 2
  ) {
    throw new Error("usage: stripe-secrets.ts [--verify] [--live]");
  }
  const required = [
    ...(mode === "live" ? [STRIPE_MODE_NAME] : []),
    stripeKeyName(mode),
    stripeWebhookSecretName(mode),
  ];
  const flyToken = readSecretFile(FLY_TOKEN_FILE);
  if (verify) {
    const answer = await namesPresent({
      required,
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
    mode,
  );
  const outcome = await pushSecrets({
    pairs: [
      { name: STRIPE_MODE_NAME, value: mode },
      { name: stripeKeyName(mode), value: values.get(stripeKeyName(mode))! },
      {
        name: stripeWebhookSecretName(mode),
        value: values.get(stripeWebhookSecretName(mode))!,
      },
    ],
    allowed: required,
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
