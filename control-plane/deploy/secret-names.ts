export const CERTIFICATE_SECRET_NAMES = [
  "ISOMUX_CF_ZONE_ID",
  "ISOMUX_CF_TOKEN",
  "ISOMUX_ACME_EMAIL",
] as const;

export {
  STRIPE_LIVE_SECRET_NAME,
  STRIPE_LIVE_WEBHOOK_SECRET_NAME,
  STRIPE_MODE_NAME,
  STRIPE_CONFIGURATION_NAMES,
  STRIPE_TEST_SECRET_NAME,
  STRIPE_TEST_WEBHOOK_SECRET_NAME,
} from "../stripe/mode.ts";

// Backward-compatible aliases for callers that are explicitly test-only.
export { STRIPE_TEST_SECRET_NAME as STRIPE_SECRET_NAME } from "../stripe/mode.ts";
export { STRIPE_TEST_WEBHOOK_SECRET_NAME as STRIPE_WEBHOOK_SECRET_NAME } from "../stripe/mode.ts";
