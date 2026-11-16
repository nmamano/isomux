// The swap-failed server (task 78733adf, slice 2c-1; design:
// internal-docs/office-move-design.md "The swap"). When the boot swap of a
// move-in fails, the state root holds parts of two offices: a normal boot
// would read and write it (users, sessions, SQLite migrations, a backup) and
// make the damage last. This server loads no state module. It serves
// /readyz, a page with the error (the log line names the failed step), and a
// retry that ends
// the process: the service manager (Restart=always) starts it again, and the
// swap resumes.

import { languageFromAcceptLanguage } from "../shared/languages.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import { LOCKED_HEADER } from "./lockdown.ts";

/** How often the retry may end the process. */
export const SWAP_RETRY_MIN_INTERVAL_MS = 30_000;

export const SWAP_RETRY_PATH = "/move-in/retry";

export interface SwapFailedOpts {
  failure: { step: string; message: string };
  /** Ends the process (production: SIGTERM after the answer is out). */
  requestRestart(): void;
  now(): Date;
}

const HEADERS: Record<string, string> = {
  [LOCKED_HEADER]: "1",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/** The last retry, per server. */
const lastRetry = new WeakMap<SwapFailedOpts, number>();

/** One request to the swap-failed server. */
export function swapFailedResponse(
  req: Request,
  opts: SwapFailedOpts,
): Response {
  const path = new URL(req.url).pathname;
  if (path === "/readyz")
    return new Response("swap failed\n", {
      status: 200,
      headers: { ...HEADERS, "Content-Type": "text/plain" },
    });
  if (path === SWAP_RETRY_PATH) {
    if (req.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { ...HEADERS, Allow: "POST" },
      });
    const now = opts.now().getTime();
    const last = lastRetry.get(opts);
    if (last !== undefined && now - last < SWAP_RETRY_MIN_INTERVAL_MS)
      return page(req, opts, "wait", 429);
    lastRetry.set(opts, now);
    opts.requestRestart();
    return page(req, opts, "restarting", 202);
  }
  return page(req, opts, "failed", 503);
}

function page(
  req: Request,
  opts: SwapFailedOpts,
  kind: "failed" | "wait" | "restarting",
  status: number,
): Response {
  const i18n = translatorFor(
    languageFromAcceptLanguage(req.headers.get("accept-language")),
  );
  const { t } = i18n;
  const p = (text: string, cls?: string) =>
    `<p${cls ? ` class="${cls}"` : ""}>${escapeHtml(text)}</p>\n`;
  const content =
    kind === "restarting"
      ? p(t("moveSwap.restarting"))
      : `${p(t("moveSwap.body"))}<dl>
<dt>${escapeHtml(t("moveSwap.errorLabel"))}</dt><dd><code>${escapeHtml(opts.failure.message)}</code></dd>
</dl>
${kind === "wait" ? p(t("moveSwap.wait"), "error") : ""}<form method="post" action="${SWAP_RETRY_PATH}">
<button type="submit">${escapeHtml(t("moveSwap.retry"))}</button>
</form>`;
  const body = `<!doctype html>
<html lang="${i18n.language}">
<head>
<meta charset="utf-8" />
<title>Isomux - ${escapeHtml(t("moveSwap.title"))}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 560px; margin: 64px auto; padding: 0 16px; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5em; }
  dt { font-weight: 600; margin-top: 0.75em; }
  dd { margin: 0; overflow-wrap: anywhere; }
  form { margin-top: 2em; }
  .error { color: #c62828; }
</style>
</head>
<body>
<h1>${escapeHtml(t("moveSwap.heading"))}</h1>
${content}
</body>
</html>
`;
  return new Response(req.method === "HEAD" ? null : body, {
    status,
    headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Serves the swap-failed page until the retry ends the process. */
export function startSwapFailedOffice(
  opts: SwapFailedOpts & { port: number; hostname?: string },
): void {
  const server = Bun.serve({
    port: opts.port,
    ...(opts.hostname ? { hostname: opts.hostname } : {}),
    development: false,
    fetch: (req) => swapFailedResponse(req, opts),
    error: () =>
      new Response("swap failed\n", { status: 503, headers: HEADERS }),
  });
  console.error(
    `[move-in] the swap failed at "${opts.failure.step}": ${opts.failure.message}; serving the swap-failed page on port ${server.port}`,
  );
}
