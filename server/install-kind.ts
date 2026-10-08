import { normalizePublicOrigin } from "../shared/public-origin.ts";
import { readFileSync } from "fs";

export const INSTALL_KIND_FILE = "/etc/isomux/install-kind";

export type InstallKind = "hosted" | "self-hosted";

// The marker is root-written during a hosted install. Every failure and every
// value except the exact hosted line is the backward-compatible self-hosted
// case. Never expose marker bytes to a prompt.
export function readInstallKind(path = INSTALL_KIND_FILE): InstallKind {
  try {
    const value = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    return value === "hosted" ? "hosted" : "self-hosted";
  } catch {
    return "self-hosted";
  }
}

export const INSTALL_KIND = readInstallKind();

function hostedUrl(configuredOrigin: string | null): URL | null {
  const origin = configuredOrigin
    ? normalizePublicOrigin(configuredOrigin)
    : null;
  if (!origin) return null;
  const url = new URL(origin);
  return url.protocol === "https:" &&
    (url.hostname === "isomux.app" || url.hostname.endsWith(".isomux.app"))
    ? url
    : null;
}

// Access policy also recognizes hosted addresses on offices installed before
// the marker existed. Inspect configured origins, never a request Host header.
export function isHostedAccess(
  markerKind: InstallKind = INSTALL_KIND,
  configuredOrigin: string | null = null,
): boolean {
  return markerKind === "hosted" || hostedUrl(configuredOrigin) !== null;
}

// A hosted office is enrolled under exactly one label on isomux.app, no port.
export function isHostedOfficeOrigin(origin: string | null): boolean {
  const url = hostedUrl(origin);
  return url !== null && /^[^.]+\.isomux\.app$/.test(url.host);
}
