import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAuthorizedChallenge,
  runDnsHook,
} from "./cloudflare-dns-hook.ts";

describe("the DNS hook authorization gate", () => {
  test("permits only the one challenge name bound to the office", () => {
    expect(() =>
      assertAuthorizedChallenge(
        "_acme-challenge.office.example.",
        "_acme-challenge.office.example",
      ),
    ).not.toThrow();
    expect(() =>
      assertAuthorizedChallenge(
        "_ACME-CHALLENGE.OFFICE.EXAMPLE",
        "_acme-challenge.office.example",
      ),
    ).not.toThrow();
    for (const name of [
      "_acme-challenge.victim.example",
      "_acme-challenge.child.office.example",
      "office.example",
    ]) {
      expect(() =>
        assertAuthorizedChallenge(name, "_acme-challenge.office.example"),
      ).toThrow("not authorized");
    }
    expect(() =>
      assertAuthorizedChallenge("_acme-challenge.office.example", undefined),
    ).toThrow("not authorized");
  });

  test("a forged foreign challenge cannot reach the production write seam", async () => {
    let writes = 0;
    const intents = mkdtempSync(join(tmpdir(), "isomux-hook-"));
    const production = {
      NODE_ENV: "production",
      ISOMUX_CERT_TARGET: "production",
      ISOMUX_CERTIFICATE_LIVE: "1",
      ISOMUX_ACME_DIRECTORY: "https://acme-v02.api.letsencrypt.org/directory",
      ISOMUX_CF_API: "https://api.cloudflare.com/client/v4",
      ISOMUX_CF_ZONE_ID: "production-zone",
      ISOMUX_CF_PRODUCTION_ZONE_ID: "production-zone",
      ISOMUX_CF_TOKEN: "production-shaped-but-fake",
      ISOMUX_DNS_ALLOWED_FQDN: "_acme-challenge.office.example",
      ISOMUX_DNS_INTENTS_DIR: intents,
    };
    try {
      const failed = await runDnsHook(
        "present",
        "_acme-challenge.victim.example",
        "forged-challenge",
        production,
        async () => {
          writes++;
          return Response.json({ success: true, result: [] });
        },
      ).catch((reason: unknown) => reason);
      expect((failed as Error).message).toContain("not authorized");
      expect(writes).toBe(0);
    } finally {
      rmSync(intents, { recursive: true, force: true });
    }
  });
});
