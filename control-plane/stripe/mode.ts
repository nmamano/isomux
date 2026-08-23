export type StripeMode = "test" | "live";

export const STRIPE_MODE_NAME = "CONTROL_PLANE_STRIPE_MODE";
export const STRIPE_TEST_SECRET_NAME = "STRIPE_TEST_SECRET_KEY";
export const STRIPE_LIVE_SECRET_NAME = "STRIPE_LIVE_SECRET_KEY";
export const STRIPE_TEST_WEBHOOK_SECRET_NAME = "STRIPE_WEBHOOK_SECRET";
export const STRIPE_LIVE_WEBHOOK_SECRET_NAME = "STRIPE_LIVE_WEBHOOK_SECRET";

export const STRIPE_CONFIGURATION_NAMES = [
  STRIPE_MODE_NAME,
  STRIPE_TEST_SECRET_NAME,
  STRIPE_LIVE_SECRET_NAME,
  STRIPE_TEST_WEBHOOK_SECRET_NAME,
  STRIPE_LIVE_WEBHOOK_SECRET_NAME,
] as const;

export class StripeModeRefused extends Error {}

type Environment = Readonly<Record<string, string | undefined>>;

/** Resolve one explicit mode at a runtime boundary. An absent setting keeps an
 * unconfigured deployment in test mode. Live mode additionally needs the
 * identity supplied by one of the two production platforms. */
export function resolveStripeMode(env: Environment): StripeMode {
  const configured = env[STRIPE_MODE_NAME];
  if (configured === undefined || configured === "test") return "test";
  if (configured !== "live") {
    throw new StripeModeRefused(
      `${STRIPE_MODE_NAME} must be exactly test or live; refusing to guess`,
    );
  }
  if (
    env.VERCEL_ENV !== "production" &&
    env.FLY_APP_NAME !== "isomux-provisioner"
  ) {
    throw new StripeModeRefused(
      "live Stripe mode is allowed only in the production Vercel deployment or the pinned provisioner app",
    );
  }
  return "live";
}

export function stripeKeyName(mode: StripeMode): string {
  return mode === "live" ? STRIPE_LIVE_SECRET_NAME : STRIPE_TEST_SECRET_NAME;
}

export function stripeWebhookSecretName(mode: StripeMode): string {
  return mode === "live"
    ? STRIPE_LIVE_WEBHOOK_SECRET_NAME
    : STRIPE_TEST_WEBHOOK_SECRET_NAME;
}

export function stripeKeyFromEnv(mode: StripeMode, env: Environment): string {
  const name = stripeKeyName(mode);
  const value = env[name];
  if (!value) throw new StripeModeRefused(`${name} is not set`);
  return value;
}

export function stripeWebhookSecretFromEnv(
  mode: StripeMode,
  env: Environment,
): string {
  const name = stripeWebhookSecretName(mode);
  const value = env[name];
  if (!value) throw new StripeModeRefused(`${name} is not set`);
  return value;
}
