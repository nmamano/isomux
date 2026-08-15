export const LETS_ENCRYPT_PRODUCTION =
  "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING =
  "https://acme-staging-v02.api.letsencrypt.org/directory";
export const CLOUDFLARE_PRODUCTION_API = "https://api.cloudflare.com/client/v4";

export type CertificateTargetKind = "production" | "staging" | "test";

export interface CertificateTarget {
  kind: CertificateTargetKind;
  caDirectory: string;
  cloudflareBaseUrl: string;
  zoneId: string;
  productionZoneId: string;
}

function loopback(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function automatedTestProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === "test" || env.BUN_ENV === "test";
}

/**
 * The production CA and production DNS zone are a matched, explicit target.
 * Every other target is structurally barred from both. Test processes are
 * barred even when a caller lies about the target kind.
 */
export function assertCertificateTarget(
  target: CertificateTarget,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const productionZone =
    target.productionZoneId.length > 0 &&
    target.zoneId === target.productionZoneId;
  const productionApi =
    target.cloudflareBaseUrl.replace(/\/$/, "") === CLOUDFLARE_PRODUCTION_API;
  const productionCa = target.caDirectory === LETS_ENCRYPT_PRODUCTION;

  if (
    automatedTestProcess(env) &&
    (productionZone || productionApi || productionCa)
  ) {
    throw new Error(
      "automated tests cannot reach the production CA or production Cloudflare zone",
    );
  }

  if (target.kind === "production") {
    if (env.ISOMUX_CERTIFICATE_LIVE !== "1") {
      throw new Error(
        "production certificate work needs ISOMUX_CERTIFICATE_LIVE=1",
      );
    }
    if (!productionCa || !productionApi || !productionZone) {
      throw new Error(
        "the production target must use the pinned CA, API, and zone together",
      );
    }
    return;
  }

  if (productionCa || productionZone) {
    throw new Error(
      "non-production certificate work cannot use a production CA or zone",
    );
  }
  if (target.kind === "test") {
    if (!loopback(target.caDirectory) || !loopback(target.cloudflareBaseUrl)) {
      throw new Error(
        "automated certificate tests require loopback CA and DNS APIs",
      );
    }
    return;
  }
  if (target.caDirectory !== LETS_ENCRYPT_STAGING) {
    throw new Error("live certificate exercises must use the staging CA");
  }
}

export function certificateTargetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CertificateTarget {
  const target: CertificateTarget = {
    kind: (env.ISOMUX_CERT_TARGET ?? "") as CertificateTargetKind,
    caDirectory: env.ISOMUX_ACME_DIRECTORY ?? "",
    cloudflareBaseUrl: env.ISOMUX_CF_API ?? "",
    zoneId: env.ISOMUX_CF_ZONE_ID ?? "",
    productionZoneId:
      env.ISOMUX_CF_PRODUCTION_ZONE_ID ??
      (env.ISOMUX_CERT_TARGET === "production"
        ? (env.ISOMUX_CF_ZONE_ID ?? "")
        : ""),
  };
  if (!(["production", "staging", "test"] as string[]).includes(target.kind)) {
    throw new Error("the certificate target is missing or invalid");
  }
  assertCertificateTarget(target, env);
  return target;
}
