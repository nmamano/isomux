// The authenticated fetch-once seam: one verb, on the provisioner.
//
// R-2026-08-10-1-AMENDED clause 4 overrides the loop's "no new HTTP surface"
// default for EXACTLY this: one authenticated fetch-once verb, by operation id,
// for an instance the caller owns and whose window is still open. There is no
// kind parameter, no host, no path and nothing else that reaches a remote seam.
// A compromised front end can ask for the result of a mint it already opened,
// and that is the whole of what it can do here.
//
// A DEPLOYED provisioner also answers one read verb, and only when a caller
// passes the reporter for it: GET /internal/health, behind the SAME bearer, is
// how an operator asks a machine they cannot log into whether it is working.
// Its answers are booleans - never an id, a host, a count or a duration - and a
// process started without a health reporter has no such route at all.
//
// TRANSPORT. HTTP request-response, bound to loopback in this loop because both
// processes are on one box. Deliberately NOT a unix socket: a socket path is
// same-box by construction, and the deployed shape is a web app on another
// machine calling a private provisioner surface. The interface is the same
// either way, which is the point (see control-plane/README.md).
//
// The decision function is separate from the server, so every rule below is
// tested without a port.

import * as crypto from "node:crypto";
import {
  CERTIFICATE_RENEW_PATH,
  CERTIFICATE_STATUS_PATH,
  MAX_CSR_BYTES,
  type CertificateService,
} from "./certificate-service.ts";
import { accessForInstance, windowIsOpen } from "./access.ts";
import type { InviteHold } from "./invite-hold.ts";
import { instanceOwnedBy } from "./signup.ts";
import type { Store } from "./store.ts";
import { handleWebhookRequest, WEBHOOK_PATH } from "./stripe/server.ts";
import type { WebhookProcessor } from "./stripe/webhook.ts";

export const MINT_SEAM_PATH = "/internal/invite";
export const HEALTH_PATH = "/internal/health";
/** A plain constant, like the webhook port. One local endpoint, one port. */
export const DEFAULT_MINT_SEAM_PORT = 4311;

/**
 * What the caller is told. NEVER any material, and never anything derived from
 * it - no length, no fragment, no timestamp of the value.
 *
 * `expired_or_lost` deliberately covers three different histories: already
 * taken, TTL expired, and the provisioner restarted. Which one it was is
 * information about how a credential was handled, and the customer's next
 * action is identical in all three, so the answer is one word.
 */
export type FetchStatus =
  | "ready"
  | "not_ready"
  | "expired_or_lost"
  | "window_closed"
  | "failed"
  | "forbidden";

export type FetchResult =
  | { status: "ready"; url: string }
  | { status: Exclude<FetchStatus, "ready">; reason: string };

export interface FetchRequest {
  accountId: string;
  instanceId: string;
  operationId: string;
}

/**
 * The one decision. Order is load-bearing:
 *
 *   1. ownership, from ROWS - the caller's claim about which account it is
 *      acting for is checked against the reservation, never believed;
 *   2. the operation belongs to that instance;
 *   3. THE WINDOW, before anything is handed over. A closed window empties the
 *      hold before the refusal returns, so a link nobody may collect stops
 *      existing rather than waiting for its TTL;
 *   4. only then, the one-shot take.
 */
export async function fetchInvite(
  store: Store,
  hold: InviteHold,
  req: FetchRequest,
): Promise<FetchResult> {
  if (!(await instanceOwnedBy(store, req.accountId, req.instanceId))) {
    // The same answer for "not yours" and "no such office", per 4a: which of
    // the two it was is not the asker's business.
    return { status: "forbidden", reason: "no such office" };
  }
  const op = await store.getOperation(req.operationId);
  if (!op || op.instance_id !== req.instanceId || op.kind !== "mint_invite") {
    return { status: "forbidden", reason: "no such request" };
  }

  const access = await accessForInstance(store, req.instanceId);
  if (!access || !windowIsOpen(access)) {
    // Ruled by the manager and confirmed by the reviewer: a fetch after the
    // window closes refuses AND deletes. The customer is already in - that is
    // what closing the window means - and the ceiling is a fail-closed
    // backstop rather than a technicality to work around.
    hold.drop(req.operationId);
    return {
      status: "window_closed",
      reason: "the access window for this office is closed",
    };
  }

  if (op.status === "pending" || op.status === "running") {
    return {
      status: "not_ready",
      reason: "the invite is still being prepared",
    };
  }
  if (op.status !== "succeeded") {
    // Classified from the ROW's status, never from its evidence: evidence is
    // where remote text would live if a future handler put it there.
    return {
      status: "failed",
      reason: `the invite request ended ${op.status}`,
    };
  }

  const taken = hold.take(req.operationId, req.instanceId);
  if (!taken.found) {
    return {
      status: "expired_or_lost",
      reason: "that invite is no longer available",
    };
  }
  return { status: "ready", url: taken.url };
}

export interface MintSeamOptions {
  store: Store;
  hold: InviteHold;
  /** From the environment. There is no default and no fallback: see below. */
  token: string;
  port?: number;
  /** Loopback in this loop. Exposed so a deployment can bind elsewhere without
   * the interface changing. */
  hostname?: string;
  /**
   * What a deployed process says about itself, as booleans.
   *
   * ABSENT BY DEFAULT: an operator run on a box somebody can log into has no
   * use for it, and a route that exists everywhere is a route to keep guarded
   * everywhere. Supplying it is what creates GET /internal/health, and the
   * bearer applies to it exactly as it does to the invite verb.
   */
  health?: () => Promise<Record<string, boolean>>;
  report?: (line: string) => void;
  certificates?: CertificateService;
  /** Present on the deployed provisioner. Stripe authenticates this public
   * route with its signature header, not with the private seam bearer. */
  webhook?: WebhookProcessor;
}

export interface RunningMintSeam {
  port: number;
  stop(): Promise<void>;
}

/** Shortest credential we will start with. Not a policy about entropy we can
 * measure - it is a floor that catches an empty string, a placeholder or a
 * truncated copy-paste before they become an open door. */
export const MIN_SEAM_TOKEN_LENGTH = 32;

/**
 * Constant-time comparison, and the length check comes first because
 * timingSafeEqual THROWS on a length mismatch rather than returning false.
 * Comparing lengths leaks the length of a credential the caller already had to
 * present, which is not the secret.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerOf(header: string | null): string {
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

async function boundedJson(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_CSR_BYTES + 4096) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

/**
 * Start the seam.
 *
 * A missing or short credential is a REFUSAL TO START, not a warning: a seam
 * that came up unauthenticated because an environment variable was misspelled
 * would be an open invite endpoint that looks like it is working.
 */
export function startMintSeam(opts: MintSeamOptions): RunningMintSeam {
  const report = opts.report ?? (() => {});
  if (!opts.token || opts.token.length < MIN_SEAM_TOKEN_LENGTH) {
    throw new Error(
      `the invite seam needs a credential of at least ${MIN_SEAM_TOKEN_LENGTH} ` +
        `characters in the environment; refusing to start an unauthenticated ` +
        `invite endpoint`,
    );
  }
  const port = opts.port ?? DEFAULT_MINT_SEAM_PORT;
  const hostname = opts.hostname ?? "127.0.0.1";

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);
      // No detail on a refusal, on either route. An unauthenticated caller
      // learns nothing beyond "no".
      const authorized = () =>
        tokenMatches(bearerOf(req.headers.get("authorization")), opts.token);

      // This is deliberately before the bearer gate: Stripe cannot present the
      // private seam token. The processor verifies the signature over the raw
      // body before it parses, fetches or writes anything.
      if (opts.webhook && url.pathname === WEBHOOK_PATH) {
        return handleWebhookRequest(req, opts.webhook, (line) =>
          report(`stripe webhook: ${line}`),
        );
      }

      if (opts.certificates && url.pathname === CERTIFICATE_RENEW_PATH) {
        if (req.method !== "POST")
          return new Response("method not allowed\n", { status: 405 });
        let csr = "";
        try {
          const body = (await boundedJson(req)) as { csr?: unknown };
          csr = typeof body?.csr === "string" ? body.csr : "";
        } catch {
          return new Response("bad request\n", { status: 400 });
        }
        const result = await opts.certificates.renew(
          bearerOf(req.headers.get("authorization")),
          csr,
        );
        report(`certificate renewal: ${result.status}`);
        if (result.status === "ok")
          return Response.json({ certificate: result.certificatePem });
        const status =
          result.status === "unauthorized"
            ? 401
            : result.status === "busy"
              ? 409
              : result.status === "bad_request"
                ? 400
                : 503;
        return new Response(
          result.status === "unauthorized"
            ? "unauthorized\n"
            : "certificate unavailable\n",
          { status },
        );
      }

      if (opts.certificates && url.pathname === CERTIFICATE_STATUS_PATH) {
        if (req.method !== "POST")
          return new Response("method not allowed\n", { status: 405 });
        let status: "ok" | "failed" | null = null;
        try {
          const body = (await boundedJson(req)) as { status?: unknown };
          status =
            body?.status === "ok" || body?.status === "failed"
              ? body.status
              : null;
        } catch {}
        if (!status) return new Response("bad request\n", { status: 400 });
        const result = await opts.certificates.reportStatus(
          bearerOf(req.headers.get("authorization")),
          status,
        );
        return result === "ok"
          ? new Response("ok\n")
          : new Response("unauthorized\n", { status: 401 });
      }

      if (opts.health && url.pathname === HEALTH_PATH) {
        if (req.method !== "GET") {
          return new Response("method not allowed\n", { status: 405 });
        }
        if (!authorized()) {
          return new Response("unauthorized\n", { status: 401 });
        }
        // ALWAYS 200 while the process is serving. The booleans carry the
        // degraded state, so a database that blinked is reported rather than
        // turned into a dead machine by whatever restarts unhealthy ones.
        return Response.json(await opts.health());
      }

      if (url.pathname !== MINT_SEAM_PATH) {
        return new Response("not found\n", { status: 404 });
      }
      if (req.method !== "POST") {
        return new Response("method not allowed\n", { status: 405 });
      }
      if (!authorized()) {
        return new Response("unauthorized\n", { status: 401 });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response("bad request\n", { status: 400 });
      }
      const field = (name: string): string => {
        const value = (body as Record<string, unknown> | null)?.[name];
        return typeof value === "string" ? value : "";
      };
      const request: FetchRequest = {
        accountId: field("accountId"),
        instanceId: field("instanceId"),
        operationId: field("operationId"),
      };
      if (!request.accountId || !request.instanceId || !request.operationId) {
        return new Response("bad request\n", { status: 400 });
      }

      const result = await fetchInvite(opts.store, opts.hold, request);
      // The STATUS is logged, never the result. This line is the only thing
      // this endpoint ever writes anywhere, and a URL cannot reach it.
      report(`invite fetch ${request.operationId}: ${result.status}`);
      return Response.json(result, {
        status: result.status === "forbidden" ? 404 : 200,
      });
    },
  });

  // The port the server ACTUALLY bound, not the one we asked for: passing 0
  // means "pick one", and a caller told 0 could not reach it. Bun types it as
  // optional because a unix-socket server has none; this one always binds a
  // port, and falling back to the requested value keeps the type honest.
  const bound = server.port ?? port;
  report(
    `invite seam listening on http://${hostname}:${bound}${MINT_SEAM_PATH}`,
  );
  return {
    port: bound,
    async stop() {
      await server.stop(true);
    },
  };
}
