// The office while it moves (task 78733adf). The boot gate in
// server/isomux-office.ts starts this instead of the office when the move
// state is "move" (server/office-move.ts moveBootMode). Like
// server/locked-office.ts it imports nothing from server/isomux-office.ts or
// server/office-managers.ts: no auth state, no agent, schedule, bridge or
// provider key.
//
// GET /readyz answers 200 LOCKED_READY_BODY, so an update still lands.
// GET /api/move/status answers the move session. POST /api/move/cancel takes
// the move code (JSON {code}, or the MOVE page's form). Every other request
// gets the static 503 MOVE page with LOCKED_HEADER and a cancel form.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { languageFromAcceptLanguage } from "../shared/languages.ts";
import { translatorFor } from "../shared/i18n/translate.ts";
import {
  LOCKED_HEADER,
  LOCKED_READY_BODY,
  stopAppsForLock,
  type LockdownApps,
} from "./lockdown.ts";
import {
  cancelMoveByCode,
  checkMoveSession,
  readMoveBody,
} from "./office-move.ts";
import {
  MOVE_UNITS_FILE,
  stopRecordedUnits,
  type AgentUnit,
  type UnitRunner,
} from "./office-move-units.ts";

/** The cancel form's path. */
export const MOVE_CANCEL_PATH = "/api/move/cancel";
/** How long after a cancel's answer the process stops. */
const STOP_DELAY_MS = 250;

// As the locked page's, plus the cancel form's own origin.
const MOVE_HEADERS: Record<string, string> = {
  [LOCKED_HEADER]: "1",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export interface MoveLockedOfficeOpts {
  stateRoot: string;
  port: number;
  hostname?: string;
  apps: LockdownApps;
  runUnits: UnitRunner;
  /** Stops the process after a cancel (production: SIGTERM self). */
  requestStop(): void;
  now(): Date;
}

export interface MoveLockedOfficeHandle {
  port: number;
  stop(): Promise<void>;
}

/** The answer to a request while the office moves. */
export async function moveLockedResponse(
  req: Request,
  opts: Pick<MoveLockedOfficeOpts, "stateRoot" | "requestStop" | "now">,
): Promise<Response> {
  let path = "";
  try {
    path = new URL(req.url).pathname;
  } catch {
    // Not a URL Bun would hand us; it gets the page.
  }
  if (path === "/readyz" && (req.method === "GET" || req.method === "HEAD"))
    return new Response(req.method === "HEAD" ? null : LOCKED_READY_BODY, {
      headers: { ...MOVE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  if (path === "/api/move/status" && req.method === "GET") {
    const state = checkMoveSession(
      opts.stateRoot,
      req.headers.get("authorization"),
      opts.now(),
    );
    return state
      ? json({ state: state.state }, 200)
      : json(
          {
            error: {
              code: "move_session_invalid",
              message: "No move session, or it is wrong or expired.",
            },
          },
          401,
        );
  }
  if (path === MOVE_CANCEL_PATH && req.method === "POST")
    return cancel(req, opts);
  return page(req, "moving", 503);
}

async function cancel(
  req: Request,
  opts: Pick<MoveLockedOfficeOpts, "stateRoot" | "requestStop" | "now">,
): Promise<Response> {
  const isJson = (req.headers.get("content-type") ?? "").includes(
    "application/json",
  );
  const text = await readMoveBody(req);
  if (text === null)
    return isJson
      ? json(
          {
            error: {
              code: "body_too_large",
              message: "The body is larger than 64 KB.",
            },
          },
          413,
        )
      : page(req, "wrongCode", 413);
  let code = "";
  try {
    if (isJson) {
      const body = JSON.parse(text) as { code?: unknown } | null;
      if (typeof body?.code === "string") code = body.code;
    } else {
      code = new URLSearchParams(text).get("code") ?? "";
    }
  } catch {
    // An unreadable body is a wrong code.
  }
  let cancelled = false;
  try {
    cancelled = cancelMoveByCode(opts.stateRoot, code, opts.now());
  } catch (err) {
    console.error("[move] could not cancel the move:", err);
    return isJson
      ? json(
          {
            error: {
              code: "cancel_failed",
              message: "The move could not be cancelled. Try again.",
            },
          },
          500,
        )
      : page(req, "moving", 500);
  }
  if (!cancelled)
    return isJson
      ? json(
          {
            error: {
              code: "move_code_invalid",
              message: "That is not the code of this move.",
            },
          },
          403,
        )
      : page(req, "wrongCode", 403);
  console.log("[move] cancelled by code; the office starts again");
  setTimeout(() => {
    try {
      opts.requestStop();
    } catch (err) {
      console.error("[move] could not stop:", err);
    }
  }, STOP_DELAY_MS);
  return isJson ? json({ cancelled: true }, 200) : page(req, "cancelled", 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...MOVE_HEADERS, "Content-Type": "application/json" },
  });
}

function page(
  req: Request,
  kind: "moving" | "wrongCode" | "cancelled",
  status: number,
): Response {
  const i18n = translatorFor(
    languageFromAcceptLanguage(req.headers.get("accept-language")),
  );
  const { t } = i18n;
  const content =
    kind === "cancelled"
      ? `<h1>${escapeHtml(t("moving.cancelledHeading"))}</h1>
<p>${escapeHtml(t("moving.cancelledBody"))}</p>`
      : `<h1>${escapeHtml(t("moving.heading"))}</h1>
<p>${escapeHtml(t("moving.body"))}</p>
${kind === "wrongCode" ? `<p class="error">${escapeHtml(t("moving.wrongCode"))}</p>\n` : ""}<form method="post" action="${MOVE_CANCEL_PATH}">
<p>${escapeHtml(t("moving.cancelHint"))}</p>
<label for="code">${escapeHtml(t("moving.codeLabel"))}</label>
<input id="code" name="code" type="password" autocomplete="off" required />
<button type="submit">${escapeHtml(t("moving.cancel"))}</button>
</form>`;
  const body = `<!doctype html>
<html lang="${i18n.language}">
<head>
<meta charset="utf-8" />
<title>Isomux - ${escapeHtml(t("moving.title"))}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 16px; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5em; }
  form { margin-top: 2em; }
  label { display: block; font-weight: 600; margin-bottom: 0.25em; }
  input { box-sizing: border-box; width: 100%; padding: 8px; margin-bottom: 0.75em; }
  .error { color: #c62828; }
</style>
</head>
<body>
${content}
</body>
</html>
`;
  return new Response(req.method === "HEAD" ? null : body, {
    status,
    headers: { ...MOVE_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Applies the move effects again (apps stopped, the recorded units stopped
 *  and disabled again: a safety net), and binds the listener. */
export async function startMoveLockedOffice(
  opts: MoveLockedOfficeOpts,
): Promise<MoveLockedOfficeHandle> {
  try {
    const stopped = stopAppsForLock(opts.stateRoot, opts.apps);
    if (stopped.length > 0)
      console.log(`[move] stopped apps: ${stopped.join(", ")}`);
  } catch (err) {
    console.error("[move] could not stop the apps:", err);
  }
  try {
    const units = readUnitsRecord(opts.stateRoot);
    // The record stays as the lock wrote it: it says how to restore.
    if (units.length > 0) stopRecordedUnits(opts.runUnits, units);
  } catch (err) {
    console.error("[move] could not stop the units again:", err);
  }
  const server = Bun.serve({
    port: opts.port,
    ...(opts.hostname ? { hostname: opts.hostname } : {}),
    development: false,
    fetch: (req) => moveLockedResponse(req, opts),
    error: () =>
      new Response("locked\n", { status: 503, headers: MOVE_HEADERS }),
  });
  console.log(
    `[move] this office is moving; serving the move page on port ${server.port}`,
  );
  return {
    port: server.port ?? opts.port,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function readUnitsRecord(stateRoot: string): AgentUnit[] {
  const path = join(stateRoot, MOVE_UNITS_FILE);
  if (!existsSync(path)) return [];
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(raw)
    ? raw.filter(
        (u): u is AgentUnit =>
          !!u &&
          typeof u === "object" &&
          typeof (u as AgentUnit).name === "string",
      )
    : [];
}
