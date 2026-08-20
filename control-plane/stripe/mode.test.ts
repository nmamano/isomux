import { describe, expect, test } from "bun:test";
import {
  StripeModeRefused,
  resolveStripeMode,
  stripeKeyFromEnv,
  stripeKeyName,
  stripeWebhookSecretFromEnv,
  stripeWebhookSecretName,
} from "./mode.ts";

describe("Stripe mode configuration", () => {
  test("an absent setting and an explicit test setting resolve to test", () => {
    expect(resolveStripeMode({})).toBe("test");
    expect(resolveStripeMode({ CONTROL_PLANE_STRIPE_MODE: "test" })).toBe(
      "test",
    );
  });

  test("live refuses when the production runtime cannot be identified", () => {
    for (const env of [
      { CONTROL_PLANE_STRIPE_MODE: "live" },
      { CONTROL_PLANE_STRIPE_MODE: "live", FLY_APP_NAME: "other-app" },
      { CONTROL_PLANE_STRIPE_MODE: "live", VERCEL_ENV: "preview" },
    ]) {
      expect(() => resolveStripeMode(env)).toThrow(StripeModeRefused);
    }
  });

  test("an unknown setting refuses rather than choosing a mode", () => {
    expect(() =>
      resolveStripeMode({ CONTROL_PLANE_STRIPE_MODE: "production" }),
    ).toThrow(StripeModeRefused);
  });
});

describe("mode-selected secret names", () => {
  test("each mode reads only its own API and webhook secret", () => {
    const env = {
      STRIPE_TEST_SECRET_KEY: "test-key-shape",
      STRIPE_LIVE_SECRET_KEY: "live-key-shape",
      STRIPE_WEBHOOK_SECRET: "test-signing-shape",
      STRIPE_LIVE_WEBHOOK_SECRET: "live-signing-shape",
    };
    expect(stripeKeyName("test")).toBe("STRIPE_TEST_SECRET_KEY");
    expect(stripeKeyName("live")).toBe("STRIPE_LIVE_SECRET_KEY");
    expect(stripeWebhookSecretName("test")).toBe("STRIPE_WEBHOOK_SECRET");
    expect(stripeWebhookSecretName("live")).toBe("STRIPE_LIVE_WEBHOOK_SECRET");
    expect(stripeKeyFromEnv("test", env)).toBe("test-key-shape");
    expect(stripeKeyFromEnv("live", env)).toBe("live-key-shape");
    expect(stripeWebhookSecretFromEnv("test", env)).toBe("test-signing-shape");
    expect(stripeWebhookSecretFromEnv("live", env)).toBe("live-signing-shape");
  });

  test("a missing selected secret refuses even when the other mode is present", () => {
    expect(() =>
      stripeKeyFromEnv("test", { STRIPE_LIVE_SECRET_KEY: "live-key-shape" }),
    ).toThrow("STRIPE_TEST_SECRET_KEY is not set");
    expect(() =>
      stripeWebhookSecretFromEnv("live", {
        STRIPE_WEBHOOK_SECRET: "test-signing-shape",
      }),
    ).toThrow("STRIPE_LIVE_WEBHOOK_SECRET is not set");
  });
});
