// The local webhook endpoint.
//
// Small on purpose: read the RAW body, hand it and the signature header to the
// processor, and turn the classified outcome into a status code. Every decision
// worth testing lives in webhook.ts, which needs no HTTP at all.
//
// It runs behind `stripe listen`, which is how a real signed Stripe delivery
// reaches a machine with no inbound route: the CLI holds a websocket to Stripe and
// forwards each event to this port, signing it with the session secret it prints.

import * as fs from "node:fs";
import * as path from "node:path";
import type { WebhookProcessor } from "./webhook.ts";

/** A plain constant, not configuration: one local endpoint, one port. */
export const DEFAULT_WEBHOOK_PORT = 4243;
export const WEBHOOK_PATH = "/stripe/webhook";

export interface WebhookServerOptions {
  processor: WebhookProcessor;
  port?: number;
  report?: (line: string) => void;
  /**
   * Where to write raw event bodies, for capturing fixtures.
   *
   * OUTSIDE the repo, always: a raw Stripe body carries customer details, and the
   * scrubbed copies are what land in `fixtures/`.
   */
  recordDir?: string;
}

export interface RunningWebhookServer {
  port: number;
  stop(): Promise<void>;
}

/**
 * Handle the public Stripe route on either the local listener or the deployed
 * provisioner listener. The processor owns every security-relevant decision;
 * this adapter preserves the raw body and maps its classified result to HTTP.
 */
export async function handleWebhookRequest(
  req: Request,
  processor: WebhookProcessor,
  report: (line: string) => void = () => {},
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed\n", { status: 405 });
  }

  const raw = await req.text();
  const signature = req.headers.get("stripe-signature");
  const outcome = await processor.handle(raw, signature);
  report(
    `${outcome.status} ${outcome.kind}` +
      `${outcome.subscriptionId ? ` ${outcome.subscriptionId}` : ""}: ${outcome.detail}`,
  );
  return Response.json(
    {
      outcome: outcome.kind,
      detail: outcome.detail,
      ...(outcome.subscriptionId
        ? { subscription: outcome.subscriptionId }
        : {}),
      ...(outcome.suspensionOpId
        ? { suspensionOperation: outcome.suspensionOpId }
        : {}),
    },
    { status: outcome.status },
  );
}

export function serveWebhooks(
  opts: WebhookServerOptions,
): RunningWebhookServer {
  const report = opts.report ?? (() => {});
  const port = opts.port ?? DEFAULT_WEBHOOK_PORT;
  if (opts.recordDir)
    fs.mkdirSync(opts.recordDir, { recursive: true, mode: 0o700 });

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response("ok\n", { status: 200 });
      }
      if (url.pathname !== WEBHOOK_PATH) {
        return new Response("not found\n", { status: 404 });
      }
      // The RAW bytes. The signature covers exactly these; a parse-and-reserialise
      // anywhere in this path would break every genuine delivery.
      const raw = await req.clone().text();
      const response = await handleWebhookRequest(req, opts.processor, report);
      if (opts.recordDir && response.ok) {
        const body = (await response.clone().json()) as { outcome?: unknown };
        if (body.outcome === "applied") recordRaw(opts.recordDir, raw, report);
      }
      return response;
    },
  });

  report(
    `webhook endpoint listening on http://localhost:${port}${WEBHOOK_PATH}`,
  );
  return {
    port,
    async stop() {
      await server.stop(true);
    },
  };
}

/** One file per event, named by its id, mode 0600. Never inside the repo. */
function recordRaw(
  dir: string,
  raw: string,
  report: (line: string) => void,
): void {
  let id = "unknown";
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; type?: unknown };
    if (typeof parsed.id === "string") id = parsed.id;
    const type = typeof parsed.type === "string" ? parsed.type : "event";
    fs.writeFileSync(path.join(dir, `${type}.${id}.json`), raw, {
      mode: 0o600,
    });
  } catch (err) {
    report(`could not record the raw event ${id}: ${messageOf(err)}`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
