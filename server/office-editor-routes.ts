// The editor routes: open, save and close of a file in an agent's folder, and
// the watch that pushes an external change to the editor that opened it. Moved
// out of buildExecutorDeps in server/isomux-office.ts, which registers them.
import type { ServerWebSocket } from "bun";
import { CREDENTIAL_PATH_MESSAGE } from "./credential-store-paths.ts";
import type { EmitContext } from "./events/emit.ts";
import type { EventId, EventPayloads } from "./events/registry.ts";
import { stopWatch, watchFile, type FileWatcher } from "./file-editor.ts";
import type { OfficeWsData } from "./isomux-office.ts";
import { agentManager } from "./office-managers.ts";
import type { RouteHandler } from "./routes/executor.ts";
import { editorHandlers } from "./routes/handlers/editor.ts";

// What the editor routes read from server/isomux-office.ts.
export interface EditorRoutesDeps {
  browsers: Set<ServerWebSocket<OfficeWsData>>;
  editorWatchers: Map<string, Map<string, FileWatcher>>;
  liveEmit: <K extends EventId>(
    id: K,
    payload: EventPayloads[K],
    ctx?: EmitContext,
  ) => void;
}

function editorKey(agentId: string, absPath: string): string {
  return `${agentId}\0${absPath}`;
}

export function createEditorRoutes(
  deps: EditorRoutesDeps,
): Record<string, RouteHandler> {
  const { browsers, editorWatchers, liveEmit } = deps;
  // Editor (open/save/close). EMIT/CALL-IN-DEP closures own the stateful
  // watch lifecycle (the seam has `browsers` + the editorWatchers registry +
  // liveEmit in scope). openFile arms a watch bound to the caller's connectionId
  // that pushes editor_external_change to that socket; closeFile disarms it; the
  // connection is verified to belong to the caller's EXACT session first.
  return editorHandlers({
    verifyConnection: (connectionId, callerSessionIdHash) => {
      // Exact-session match (not just same-user): a client can't aim a watch /
      // external-change push at another tab's socket. A bearer caller has no
      // callerSessionIdHash and fails closed (editor:use is USER-only).
      if (!callerSessionIdHash) return false;
      for (const ws of browsers) {
        if (ws.data.connectionId === connectionId)
          return ws.data.session.sessionIdHash === callerSessionIdHash;
      }
      return false;
    },
    openFile: (agentId, path, connectionId) => {
      const probe = agentManager.openEditorFile(agentId, path);
      if (!probe.ok) {
        // not_agent is normally pre-empted by the agentParam guard (403); a miss
        // here is a post-guard race. bad_path -> 400.
        return probe.error === "not_agent"
          ? {
              ok: false as const,
              status: 404,
              code: "agent_not_found",
              message: "Agent not found.",
            }
          : {
              ok: false as const,
              status: 400,
              code: "bad_path",
              message: "Invalid path.",
            };
      }
      const r = probe.result;
      if (r.kind === "not_found")
        return {
          ok: false,
          status: 404,
          code: "not_found",
          message: "File not found.",
        };
      if (r.kind === "not_file")
        return {
          ok: false,
          status: 422,
          code: "not_a_file",
          message: "Not a file.",
        };
      if (r.kind === "binary")
        return {
          ok: false,
          status: 422,
          code: "binary",
          message: "Binary file (text only).",
        };
      if (r.kind === "too_large")
        return {
          ok: false,
          status: 422,
          code: "too_large",
          message: `File is too large (${(r.size / 1024).toFixed(1)} KB, 1 MB limit).`,
        };
      if (r.kind === "io_error")
        return {
          ok: false,
          status: 500,
          code: "io_error",
          message: r.message,
        };
      if (r.kind === "credential")
        return {
          ok: false,
          status: 403,
          code: "credential_path",
          message: CREDENTIAL_PATH_MESSAGE,
        };
      // r.kind === "ok": install (or replace) the watch for this connection; the
      // callback pushes editor_external_change (or editor_file_deleted, on a
      // confirmed deletion) to the connection's socket.
      const map =
        editorWatchers.get(connectionId) ?? new Map<string, FileWatcher>();
      editorWatchers.set(connectionId, map);
      const key = editorKey(agentId, r.path);
      const old = map.get(key);
      if (old) stopWatch(old);
      // watchFile always installs (mtime poll - no fs.watch handle that
      // could fail on a vanished file; a vanished file just emits on the
      // poll that sees it back).
      const watcher = watchFile(
        r.path,
        (ev) => {
          if (ev.kind === "deleted") {
            liveEmit(
              "editor_file_deleted",
              { agentId, path: r.path },
              { connectionId },
            );
          } else {
            liveEmit(
              "editor_external_change",
              { agentId, path: r.path, mtime: ev.mtime, rev: ev.rev },
              { connectionId },
            );
          }
        },
        r.sig,
      );
      map.set(key, watcher);
      return {
        ok: true,
        path: r.path,
        content: r.content,
        mtime: r.mtime,
        language: r.language,
        size: r.size,
        rev: r.rev,
      };
    },
    saveFile: (agentId, path, content, expectedMtime, expectedRev, force) => {
      const abs = agentManager.resolveEditorPathForAgent(agentId, path);
      if (!abs)
        return {
          ok: false,
          status: 404,
          code: "agent_not_found",
          message: "Agent not found.",
        };
      const result = agentManager.saveEditorFile(
        abs,
        content,
        expectedMtime,
        expectedRev,
        force,
      );
      if (result.kind === "ok")
        return { ok: true, mtime: result.mtime, rev: result.rev };
      if (result.kind === "deleted") return { ok: false, deleted: true };
      if (result.kind === "stale")
        return {
          ok: false,
          stale: true,
          currentMtime: result.currentMtime,
          currentRev: result.currentRev,
        };
      if (result.kind === "credential")
        return {
          ok: false,
          status: 403,
          code: "credential_path",
          message: CREDENTIAL_PATH_MESSAGE,
        };
      return {
        ok: false,
        status: 500,
        code: "io_error",
        message: result.message,
      };
    },
    closeFile: (agentId, path, connectionId) => {
      const abs = agentManager.resolveEditorPathForAgent(agentId, path);
      if (!abs) return;
      const map = editorWatchers.get(connectionId);
      if (!map) return;
      const key = editorKey(agentId, abs);
      const w = map.get(key);
      if (w) {
        stopWatch(w);
        map.delete(key);
      }
      if (map.size === 0) editorWatchers.delete(connectionId);
    },
  });
}
