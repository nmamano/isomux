// Agents — browser editor resource handlers — Phase 3d slice 6b. The
// open/save/close file surface moves off the WS command bus to REST. EXPAND+CUT
// in one slice (like 6a): the rows were table-declared but never handler-
// registered.
//
// The editor is request/response, so it is REST (unlike the interactive
// terminal). It is also STATEFUL: openFile arms a per-tab watch (mtime poll) that pushes
// `editor_external_change` over that tab's socket; closeFile disarms it. Because
// an HTTP request has NO socket, open/close carry the X-Isomux-Connection-Id
// header (from session_context) and the server binds the watch to that
// connectionId (resolved to a socket by the connectionId emit projection). The
// handler VERIFIES the connection belongs to the caller's exact session before
// binding/unbinding, so a client cannot aim a watch / external-change push at
// another tab's socket — this restores the WS-era safety where the socket WAS
// the identity (see Conventions › Connection binding).
//
// Read-as-data: openFile returns { content, mtime, language, size } in the GET
// body (the retired editor_content event). saveFile returns { ok, mtime } or a
// 409 { code:"stale", currentMtime } conflict (the retired editor_save_response).
// editor_open_error reasons map to deliberate HTTP statuses below. The COMPOUND
// watch lifecycle lives in the injected EditorDeps closures (the index seam, where
// `browsers` / the watcher registry / liveEmit are in scope).

import {
  ok,
  noContent,
  fail,
  type RouteHandler,
  type HandlerErrorStatus,
} from "../executor.ts";
import type { EditorSaveReq } from "../../../shared/contract-shapes.ts";

// openFile result: the read-as-data payload on success, else a status+code+message
// the handler surfaces verbatim (the index closure maps the agent-manager
// OpenFileResult kinds — not_found/not_file/binary/too_large/io_error/bad_path —
// to these).
export type OpenFileOutcome =
  | {
      ok: true;
      // The RESOLVED absolute path (the client keys its tab by this).
      path: string;
      content: string;
      mtime: number;
      language: string;
      size: number;
    }
  | { ok: false; status: HandlerErrorStatus; code: string; message: string };

// saveFile result: ok(mtime), the 409 stale-conflict (carries currentMtime for the
// client banner), or an io error.
export type SaveFileOutcome =
  | { ok: true; mtime: number }
  | { ok: false; stale: true; currentMtime: number }
  | { ok: false; status: HandlerErrorStatus; code: string; message: string };

export interface EditorDeps {
  // True ONLY if `connectionId` names a live socket owned by the caller's EXACT
  // session (sessionIdHash match) — not merely the same user. A bearer caller has
  // no callerSessionIdHash and fails closed (editor:use is USER-only anyway).
  verifyConnection(
    connectionId: string,
    callerSessionIdHash: string | undefined,
  ): boolean;
  // Resolve + read the file AND arm a watch keyed by (connectionId, agentId, path)
  // that pushes editor_external_change to that connection's socket. Replaces a
  // duplicate open of the same key (collapses re-opens).
  openFile(
    agentId: string,
    path: string,
    connectionId: string,
  ): OpenFileOutcome;
  // Save with the mtime-conflict guard (force bypasses it).
  saveFile(
    agentId: string,
    path: string,
    content: string,
    expectedMtime: number,
    force: boolean,
  ): SaveFileOutcome;
  // Disarm the (connectionId, agentId, path) watch. No-op safe (an already-gone
  // watch — e.g. the socket closed and the WS-close swept it — is harmless).
  closeFile(agentId: string, path: string, connectionId: string): void;
}

// Shared guard for the two watch-binding routes (open/close): the path query and
// a connection-id header that must belong to the caller's session. Returns the
// validated pair, or an error result to surface.
function bindContext(
  ctx: Parameters<RouteHandler>[0],
  deps: EditorDeps,
):
  | { ok: true; path: string; connectionId: string }
  | { ok: false; result: ReturnType<typeof fail> } {
  const path = ctx.query.get("path");
  if (!path) {
    return {
      ok: false,
      result: fail(400, "invalid_path", "path query parameter is required"),
    };
  }
  const connectionId = ctx.req.headers.get("X-Isomux-Connection-Id");
  if (!connectionId) {
    return {
      ok: false,
      result: fail(
        400,
        "missing_connection",
        "X-Isomux-Connection-Id header is required",
      ),
    };
  }
  if (!deps.verifyConnection(connectionId, ctx.callerSessionIdHash)) {
    return {
      ok: false,
      result: fail(
        403,
        "bad_connection",
        "That connection does not belong to your session.",
      ),
    };
  }
  return { ok: true, path, connectionId };
}

export function editorHandlers(deps: EditorDeps): Record<string, RouteHandler> {
  return {
    "agents.openFile": (ctx) => {
      const bind = bindContext(ctx, deps);
      if (!bind.ok) return bind.result;
      const r = deps.openFile(ctx.params.id, bind.path, bind.connectionId);
      if (r.ok) {
        return ok({
          path: r.path,
          content: r.content,
          mtime: r.mtime,
          language: r.language,
          size: r.size,
        });
      }
      return fail(r.status, r.code, r.message);
    },

    "agents.saveFile": (ctx) => {
      const b = (ctx.body ?? {}) as Partial<EditorSaveReq>;
      if (typeof b.path !== "string" || b.path.length === 0) {
        return fail(400, "invalid_path", "path is required");
      }
      if (typeof b.content !== "string") {
        return fail(422, "invalid_request", "content must be a string");
      }
      // Number.isFinite, not just typeof: a hand-crafted body can deliver
      // `1e999` -> Infinity (or NaN), and `currentMtime > Infinity` is false, so a
      // non-finite expectedMtime would slip past the stale-write guard into an
      // overwrite. Likewise a present non-boolean `force` is truthy under `?? false`
      // and would force the overwrite — reject both at the boundary (422).
      if (
        typeof b.expectedMtime !== "number" ||
        !Number.isFinite(b.expectedMtime)
      ) {
        return fail(
          422,
          "invalid_request",
          "expectedMtime must be a finite number",
        );
      }
      if (b.force !== undefined && typeof b.force !== "boolean") {
        return fail(422, "invalid_request", "force must be a boolean");
      }
      const r = deps.saveFile(
        ctx.params.id,
        b.path,
        b.content,
        b.expectedMtime,
        b.force ?? false,
      );
      if (r.ok) return ok({ ok: true, mtime: r.mtime });
      if ("stale" in r) {
        // 409 Conflict — the disk changed since the client opened it. currentMtime
        // rides the error envelope (ApiError.detail) for the client's stale banner.
        return fail(409, "stale", "File changed on disk since you opened it.", {
          currentMtime: r.currentMtime,
        });
      }
      return fail(r.status, r.code, r.message);
    },

    "agents.closeFile": (ctx) => {
      const bind = bindContext(ctx, deps);
      if (!bind.ok) return bind.result;
      deps.closeFile(ctx.params.id, bind.path, bind.connectionId);
      return noContent();
    },
  };
}
