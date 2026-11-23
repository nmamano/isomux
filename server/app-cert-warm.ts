// The certificate warm-up for a newly registered app's hostname.
//
// On an office whose terminator gets app certificates on demand (the
// installer's Caddy: `tls { on_demand }` for `*.<domain>`), the first TLS
// handshake for a new name waits while the certificate is obtained - 4 to 7 s,
// measured. Without a warm-up, the first member who opens the app pays that
// wait. The register route calls this once, so the certificate exists before
// the route answers. On a terminator with a wildcard certificate (Hosted,
// Kubernetes, Render) it is one fast handshake that changes nothing.
//
// Only a handshake: no byte is sent after it, so whether the certificate is
// trusted does not matter, and it must not, because a terminator may serve one
// this process cannot verify. Caddy holds an on-demand handshake until the
// certificate is obtained, so a completed handshake means it exists. Closing
// early does not cancel the obtain - certmagic runs it inside the handshake,
// under the server's own context, not the peer's (measured: a warm-up cut at
// 0.5 s still left a certificate 20 s later) - so the deadline only bounds how
// long registration waits.

import { connect, type TLSSocket } from "node:tls";

export interface WarmTarget {
  host: string;
  port: number;
}

export interface WarmOptions {
  // Where to open the handshake, in order. Default: the loopback terminator,
  // then the public name.
  targets?: WarmTarget[];
  // One deadline for all targets.
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Loopback first: it reaches a terminator on this machine without DNS, and
// without a router that must send the box's own public address back to it.
// The public name second: it reaches a terminator outside this process's
// network, as in the container install, where Caddy runs on the host.
function defaultTargets(hostname: string): WarmTarget[] {
  return [
    { host: "127.0.0.1", port: 443 },
    { host: hostname, port: 443 },
  ];
}

// One handshake attempt, settled by the first of: handshake done, socket error
// or close, or the deadline. Never rejects.
function handshake(
  hostname: string,
  target: WarmTarget,
  remainingMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: TLSSocket | null = null;
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      socket?.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), remainingMs);
    try {
      socket = connect({
        host: target.host,
        port: target.port,
        servername: hostname,
        rejectUnauthorized: false,
      });
    } catch {
      finish(false);
      return;
    }
    socket.once("secureConnect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

// True when a handshake with SNI `hostname` completed. Never rejects.
export async function warmAppCertificate(
  hostname: string,
  opts: WarmOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (const target of opts.targets ?? defaultTargets(hostname)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (await handshake(hostname, target, remaining)) return true;
  }
  console.warn(
    `[apps] could not get the certificate of ${hostname} before its first ` +
      `visit; the first visit waits for it`,
  );
  return false;
}
