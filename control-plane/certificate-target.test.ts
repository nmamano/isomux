import { describe, expect, test } from "bun:test";
import {
  assertCertificateTarget,
  CLOUDFLARE_PRODUCTION_API,
  LETS_ENCRYPT_PRODUCTION,
  LETS_ENCRYPT_STAGING,
} from "./certificate-target.ts";

describe("certificate test rails", () => {
  const production = {
    kind: "production" as const,
    caDirectory: LETS_ENCRYPT_PRODUCTION,
    cloudflareBaseUrl: CLOUDFLARE_PRODUCTION_API,
    zoneId: "prod-zone",
    productionZoneId: "prod-zone",
  };

  test("an automated process cannot opt itself into production", () => {
    expect(() =>
      assertCertificateTarget(production, {
        NODE_ENV: "test",
        ISOMUX_CERTIFICATE_LIVE: "1",
      }),
    ).toThrow("automated tests cannot reach");
  });

  test("test targets require local fake services and a non-production zone", () => {
    expect(() =>
      assertCertificateTarget(
        {
          kind: "test",
          caDirectory: "http://127.0.0.1:14000/directory",
          cloudflareBaseUrl: "http://localhost:14001/client/v4",
          zoneId: "fake-zone",
          productionZoneId: "prod-zone",
        },
        { NODE_ENV: "test" },
      ),
    ).not.toThrow();
    expect(() =>
      assertCertificateTarget(
        {
          kind: "test",
          caDirectory: LETS_ENCRYPT_STAGING,
          cloudflareBaseUrl: "http://localhost:14001/client/v4",
          zoneId: "fake-zone",
          productionZoneId: "prod-zone",
        },
        { NODE_ENV: "test" },
      ),
    ).toThrow("loopback");
  });

  test("a live exercise is staging-only", () => {
    expect(() =>
      assertCertificateTarget(
        {
          kind: "staging",
          caDirectory: LETS_ENCRYPT_STAGING,
          cloudflareBaseUrl: CLOUDFLARE_PRODUCTION_API,
          zoneId: "staging-exercise-zone",
          productionZoneId: "prod-zone",
        },
        {},
      ),
    ).not.toThrow();
  });
});
