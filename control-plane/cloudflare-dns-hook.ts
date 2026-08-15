#!/usr/bin/env bun
import { CloudflareDns } from "./cloudflare-dns.ts";
import { certificateTargetFromEnv } from "./certificate-target.ts";

function normalizedFqdn(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

export function assertAuthorizedChallenge(
  fqdn: string,
  allowed: string | undefined,
): void {
  if (!allowed || normalizedFqdn(fqdn) !== normalizedFqdn(allowed)) {
    throw new Error("the DNS challenge name is not authorized for this office");
  }
}

async function main(): Promise<void> {
  const [verb, fqdn, value] = process.argv.slice(2);
  if ((verb !== "present" && verb !== "cleanup") || !fqdn || !value)
    process.exit(2);
  await runDnsHook(verb, fqdn, value, process.env);
}

export async function runDnsHook(
  verb: "present" | "cleanup",
  fqdn: string,
  value: string,
  env: NodeJS.ProcessEnv,
  fetchImpl?: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>,
): Promise<void> {
  // This is the load-bearing authorization gate. It runs before target or
  // Cloudflare setup, so a foreign name cannot cause any zone request.
  assertAuthorizedChallenge(fqdn, env.ISOMUX_DNS_ALLOWED_FQDN);
  const target = certificateTargetFromEnv(env);
  const token = env.ISOMUX_CF_TOKEN ?? "";
  if (!token) throw new Error("the DNS credential is missing");
  const dns = new CloudflareDns({
    baseUrl: target.cloudflareBaseUrl,
    zoneId: target.zoneId,
    apiToken: token,
    intentsDir: env.ISOMUX_DNS_INTENTS_DIR ?? "/data/certificate-dns-intents",
    fetch: fetchImpl,
  });
  if (verb === "present") await dns.present(fqdn, value);
  else await dns.cleanup(fqdn, value);
}

if (import.meta.main) await main();
