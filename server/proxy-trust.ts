// Where a request comes from, decided once per request
// (internal-docs/proxy-trust-design.md).
//
// The server sees only the TCP peer. Behind a same-host proxy every request
// has a loopback peer, and behind a load balancer every request has the load
// balancer as peer. The deployment declares its proxy in
// office-config.json#trustedProxy, which the server reads once at boot.
//
//   onBox  - the peer is loopback and the request has no forwarding header.
//            The same rule in every mode. A proxy can add a header but a
//            client cannot remove the one the proxy adds, so a header can only
//            make a request off-box. Agent, cron-run and app tokens work only
//            on-box.
//   client - the rate-limit key. The peer, except for a request that came
//            through the declared proxy: then the rightmost X-Forwarded-For
//            entry, which that proxy wrote. X-Real-IP and Forwarded are never
//            read as an address.

export type TrustedProxy = "none" | "same-host" | "load-balancer";

export const TRUSTED_PROXY_VALUES: readonly TrustedProxy[] = [
  "none",
  "same-host",
  "load-balancer",
];

const FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"];

export interface RequestSource {
  onBox: boolean;
  client: string;
}

function isLoopbackAddress(addr: string | null): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

function rightmostForwardedFor(req: Request): string | null {
  // Headers.get joins repeated headers with ", ", so the last entry of the
  // joined value is the last entry of the last header line.
  const value = req.headers.get("x-forwarded-for");
  if (value === null) return null;
  return value.split(",").at(-1)?.trim() || null;
}

export function classifyRequest(
  req: Request,
  peer: string | null,
  mode: TrustedProxy,
): RequestSource {
  const loopback = isLoopbackAddress(peer);
  const onBox =
    loopback && !FORWARDING_HEADERS.some((name) => req.headers.has(name));
  const viaProxy =
    (mode === "same-host" && loopback) ||
    (mode === "load-balancer" && peer !== null && !loopback);
  const forwarded = viaProxy ? rightmostForwardedFor(req) : null;
  return { onBox, client: forwarded ?? peer ?? "unknown" };
}

let bootTrustedProxy: TrustedProxy = "none";

// Set once at boot from office-config.json, next to networkBind.
export function setTrustedProxy(mode: TrustedProxy): void {
  bootTrustedProxy = mode;
}

export function trustedProxy(): TrustedProxy {
  return bootTrustedProxy;
}
