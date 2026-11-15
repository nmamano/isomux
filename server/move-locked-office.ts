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
  markMoveDone,
  markMoveServed,
  MOVE_STATE_FILE,
  moveOriginFrom,
  readMoveBody,
  readMoveState,
  type MoveState,
  type MoveStateMove,
  type MoveStateMoved,
} from "./office-move.ts";
import {
  MOVE_BATCH_BODY_MAX_BYTES,
  moveItemsHash,
  sealMoveStream,
  writeMoveBatch,
  type MoveBatchItem,
  type MoveBatchSource,
  type MoveManifestJobs,
} from "./office-move-pull.ts";
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

/** The pull (slice 2a): served only here, in "move". */
export interface MovePullDeps {
  manifests: MoveManifestJobs;
  batch: MoveBatchSource;
}

export interface MoveLockedOfficeOpts {
  stateRoot: string;
  /** The pull routes; without it they answer 404. */
  pull?: MovePullDeps;
  /** The two audit rows of the pull. Production opens the audit store only
   *  for the write. */
  audit?(input: {
    operation: "office.movePulled" | "office.moveDone";
    state: MoveState;
  }): void;
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
  opts: Pick<
    MoveLockedOfficeOpts,
    "stateRoot" | "requestStop" | "now" | "pull" | "audit"
  >,
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
  const pullRoute = pullRouteOf(req.method, path);
  if (pullRoute) return pullResponse(req, pullRoute, opts);
  return page(req, pageKind(opts), 503);
}

type PullRoute =
  | { kind: "manifest" }
  | { kind: "manifestStatus"; id: string }
  | { kind: "manifestData"; id: string }
  | { kind: "batch" }
  | { kind: "done" };

function pullRouteOf(method: string, path: string): PullRoute | null {
  if (path === "/api/move/manifest" && method === "POST")
    return { kind: "manifest" };
  if (path === "/api/move/batch" && method === "POST") return { kind: "batch" };
  if (path === "/api/move/done" && method === "POST") return { kind: "done" };
  const m = /^\/api\/move\/manifest\/([^/]+)(\/data)?$/.exec(path);
  if (m && method === "GET") {
    let id = "";
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      // A bad % sequence names no manifest.
    }
    return m[2] ? { kind: "manifestData", id } : { kind: "manifestStatus", id };
  }
  return null;
}

const SESSION_INVALID = {
  code: "move_session_invalid",
  message: "No move session, or it is wrong or expired.",
};

function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** The pull (slice 2a): every route takes the move session, then needs the
 *  state "move". */
async function pullResponse(
  req: Request,
  route: PullRoute,
  opts: Pick<MoveLockedOfficeOpts, "stateRoot" | "now" | "pull" | "audit">,
): Promise<Response> {
  const pull = opts.pull;
  if (!pull) return fail(404, "not_found", "No such move route.");
  const state = checkMoveSession(
    opts.stateRoot,
    req.headers.get("authorization"),
    opts.now(),
  );
  if (!state) return json({ error: SESSION_INVALID }, 401);
  if (state.state !== "move")
    return fail(409, "not_locked", "The office is not locked for the move.");
  const key = Buffer.from(state.key, "base64url");
  switch (route.kind) {
    case "manifest": {
      const started = pull.manifests.start(state.sessionHash);
      return started.ok
        ? json({ id: started.id }, 202)
        : fail(409, "manifest_running", started.message);
    }
    case "manifestStatus": {
      const status = route.id
        ? pull.manifests.status(route.id, state.sessionHash)
        : null;
      return status
        ? json(status, 200)
        : fail(404, "not_found", "No such manifest.");
    }
    case "manifestData": {
      const file = route.id
        ? pull.manifests.dataFile(route.id, state.sessionHash)
        : null;
      if (!file) return fail(404, "not_found", "No ready manifest of that id.");
      const id = route.id;
      async function* data(): AsyncGenerator<Uint8Array> {
        for await (const chunk of Bun.file(file!).stream()) yield chunk;
        pull!.manifests.markServed(id);
      }
      return sealed(
        sealMoveStream(
          key,
          { route: "manifest", manifestId: id, batch: 0, itemsHash: "" },
          data(),
        ),
      );
    }
    case "batch":
      return batch(req, state, key, pull, opts);
    case "done":
      return done(req, state, pull, opts);
  }
}

function sealed(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { ...MOVE_HEADERS, "Content-Type": "application/octet-stream" },
  });
}

async function readJsonObject(
  req: Request,
  maxBytes?: number,
): Promise<Record<string, unknown> | "too_large" | null> {
  const text = await readMoveBody(req, maxBytes);
  if (text === null) return "too_large";
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asItems(v: unknown): MoveBatchItem[] | null {
  if (!Array.isArray(v)) return null;
  const items: MoveBatchItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const { path, offset, length } = raw as Record<string, unknown>;
    if (typeof path !== "string") return null;
    if (offset !== undefined && typeof offset !== "number") return null;
    if (length !== undefined && typeof length !== "number") return null;
    items.push({
      path,
      ...(offset !== undefined ? { offset } : {}),
      ...(length !== undefined ? { length } : {}),
    });
  }
  return items;
}

async function batch(
  req: Request,
  state: MoveStateMove,
  key: Buffer,
  pull: MovePullDeps,
  opts: Pick<MoveLockedOfficeOpts, "stateRoot" | "now" | "audit">,
): Promise<Response> {
  // Read only now, after the session check: the cap is larger here.
  const body = await readJsonObject(req, MOVE_BATCH_BODY_MAX_BYTES);
  if (body === "too_large")
    return fail(413, "body_too_large", "The body is larger than 1 MB.");
  const items = asItems(body?.items);
  const manifestId = body?.manifestId;
  const n = body?.batch;
  if (
    !body ||
    !items ||
    typeof manifestId !== "string" ||
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 0
  )
    return fail(
      400,
      "invalid_request",
      "The body must be {manifestId, batch, items: [{path, offset?, length?}]}.",
    );
  if (!pull.manifests.dataFile(manifestId, state.sessionHash))
    return fail(409, "manifest_unknown", "No ready manifest of that id.");
  try {
    if (markMoveServed(opts.stateRoot, opts.now()))
      opts.audit?.({
        operation: "office.movePulled",
        state: readMoveState(opts.stateRoot, opts.now()).current ?? state,
      });
  } catch (err) {
    console.error("[move] could not record the first batch:", err);
  }
  return sealed(
    sealMoveStream(
      key,
      {
        route: "batch",
        manifestId,
        batch: n,
        itemsHash: moveItemsHash(items),
      },
      writeMoveBatch(pull.batch, items),
    ),
  );
}

async function done(
  req: Request,
  state: MoveStateMove,
  pull: MovePullDeps,
  opts: Pick<MoveLockedOfficeOpts, "stateRoot" | "now" | "audit">,
): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === "too_large")
    return fail(413, "body_too_large", "The body is larger than 64 KB.");
  const manifestId = body?.manifestId;
  if (!body || typeof manifestId !== "string")
    return fail(
      400,
      "invalid_request",
      "The body must be {manifestId, newOrigin}.",
    );
  const newOrigin = moveOriginFrom(body.newOrigin);
  if (!newOrigin)
    return fail(400, "invalid_origin", "newOrigin must be an http(s) URL.");
  if (!pull.manifests.served(manifestId, state.sessionHash))
    return fail(
      409,
      "manifest_not_served",
      "The new office has not pulled that manifest.",
    );
  let moved: MoveStateMoved;
  try {
    moved = markMoveDone(opts.stateRoot, {
      manifestId,
      newOrigin,
      now: opts.now(),
    });
  } catch (err) {
    console.error("[move] could not record the end of the move:", err);
    return fail(500, "done_failed", "The office could not record the move.");
  }
  try {
    opts.audit?.({ operation: "office.moveDone", state: moved });
  } catch (err) {
    console.error("[move] could not write the audit row:", err);
  }
  console.log(`[move] the office moved to ${newOrigin}`);
  return json({ moved: true }, 200);
}

type PageKind =
  | { kind: "moving"; served: boolean }
  | { kind: "moved"; origin: string }
  | { kind: "unreadable" }
  | { kind: "cancelled" };

/** A line the page shows over the cancel form after a refused cancel. */
type PageError = "wrongCode" | "confirmMoved";

// The page for the state on disk. A state file that does not read (N1)
// gets a page without the cancel form: the code cannot be checked.
function pageKind(
  opts: Pick<MoveLockedOfficeOpts, "stateRoot" | "now">,
): PageKind {
  const current = currentState(opts);
  if (current?.state === "moved")
    return { kind: "moved", origin: current.newOrigin };
  if (current?.state === "move")
    return { kind: "moving", served: current.servedAt !== undefined };
  if (!current && existsSync(join(opts.stateRoot, MOVE_STATE_FILE)))
    return { kind: "unreadable" };
  return { kind: "moving", served: false };
}

function currentState(
  opts: Pick<MoveLockedOfficeOpts, "stateRoot" | "now">,
): MoveState | null {
  try {
    return readMoveState(opts.stateRoot, opts.now()).current;
  } catch {
    return null;
  }
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
      : page(req, pageKind(opts), 413, "wrongCode");
  let code = "";
  let confirmMoved = false;
  try {
    if (isJson) {
      const body = JSON.parse(text) as {
        code?: unknown;
        confirmMoved?: unknown;
      } | null;
      if (typeof body?.code === "string") code = body.code;
      confirmMoved = body?.confirmMoved === true;
    } else {
      const form = new URLSearchParams(text);
      code = form.get("code") ?? "";
      confirmMoved = !!form.get("confirmMoved");
    }
  } catch {
    // An unreadable body is a wrong code.
  }
  // MOVED: the office runs on the new machine. Ending the move here starts
  // it on both, so the owner must say they know.
  const current = currentState(opts);
  if (current?.state === "moved" && !confirmMoved)
    return isJson
      ? json(
          {
            error: {
              code: "moved_confirm_required",
              message:
                "The office already moved. Send confirmMoved: true to start it here again too.",
            },
          },
          409,
        )
      : page(req, pageKind(opts), 409, "confirmMoved");
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
      : page(req, pageKind(opts), 500);
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
      : page(req, pageKind(opts), 403, "wrongCode");
  console.log("[move] cancelled by code; the office starts again");
  setTimeout(() => {
    try {
      opts.requestStop();
    } catch (err) {
      console.error("[move] could not stop:", err);
    }
  }, STOP_DELAY_MS);
  return isJson
    ? json({ cancelled: true }, 200)
    : page(req, { kind: "cancelled" }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...MOVE_HEADERS, "Content-Type": "application/json" },
  });
}

function page(
  req: Request,
  kind: PageKind,
  status: number,
  error?: PageError,
): Response {
  const i18n = translatorFor(
    languageFromAcceptLanguage(req.headers.get("accept-language")),
  );
  const { t } = i18n;
  const p = (text: string, cls?: string) =>
    `<p${cls ? ` class="${cls}"` : ""}>${escapeHtml(text)}</p>\n`;
  const errorLine =
    error === "wrongCode"
      ? p(t("moving.wrongCode"), "error")
      : error === "confirmMoved"
        ? p(t("moving.confirmMovedRequired"), "error")
        : "";
  const codeField = `<label for="code">${escapeHtml(t("moving.codeLabel"))}</label>
<input id="code" name="code" type="password" autocomplete="off" required />\n`;
  let content: string;
  switch (kind.kind) {
    case "cancelled":
      content = `<h1>${escapeHtml(t("moving.cancelledHeading"))}</h1>\n${p(t("moving.cancelledBody"))}`;
      break;
    case "unreadable":
      content = `<h1>${escapeHtml(t("moving.heading"))}</h1>\n${p(t("moving.unreadableBody"))}`;
      break;
    case "moved":
      // The origin is text, never a link: it comes from the new office.
      content = `<h1>${escapeHtml(t("moving.movedHeading"))}</h1>
${p(t("moving.movedBody", { origin: kind.origin }))}${errorLine}<form method="post" action="${MOVE_CANCEL_PATH}">
${p(t("moving.movedCancelHint"))}${p(t("moving.movedWarning"), "warning")}${codeField}<label class="check"><input name="confirmMoved" type="checkbox" value="yes" required /> ${escapeHtml(t("moving.confirmMovedLabel"))}</label>
<button type="submit">${escapeHtml(t("moving.cancel"))}</button>
</form>`;
      break;
    case "moving":
      content = `<h1>${escapeHtml(t("moving.heading"))}</h1>
${p(t("moving.body"))}${errorLine}<form method="post" action="${MOVE_CANCEL_PATH}">
${p(t("moving.cancelHint"))}${kind.served ? p(t("moving.servedWarning"), "warning") : ""}${codeField}<button type="submit">${escapeHtml(t("moving.cancel"))}</button>
</form>`;
      break;
  }
  const title =
    kind.kind === "moved" ? t("moving.movedTitle") : t("moving.title");
  const body = `<!doctype html>
<html lang="${i18n.language}">
<head>
<meta charset="utf-8" />
<title>Isomux - ${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 16px; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5em; }
  form { margin-top: 2em; }
  label { display: block; font-weight: 600; margin-bottom: 0.25em; }
  label.check { font-weight: normal; margin-bottom: 0.75em; }
  input { box-sizing: border-box; width: 100%; padding: 8px; margin-bottom: 0.75em; }
  input[type="checkbox"] { width: auto; margin: 0 0.5em 0 0; }
  .error { color: #c62828; }
  .warning { font-weight: 600; }
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

/** The units the lock recorded (move-units.json); [] without a record. */
export function readUnitsRecord(stateRoot: string): AgentUnit[] {
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
