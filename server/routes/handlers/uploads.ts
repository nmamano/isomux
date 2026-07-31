// Upload + file-serving handlers - Phase 3a slice 3a.3b. The two browser-facing
// file routes on the unified REST surface (opIds agents.upload / agents.getFile).
//
// agents.upload  POST /api/agents/:id/uploads  - `file:upload` + requiresRoomAccess(:id)
// agents.getFile GET  /api/agents/:id/files/:filename - `office:read` + requiresRoomAccess(:id)
//
// Both are USER surfaces (the agent-identity capabilities omit file:upload /
// office:read), gated by room access. agents.getFile is a [behavior-change]: it is
// room-ACL-gated, where the legacy /api/files was public-to-authenticated. The
// legacy /api/upload/:agentId + /api/files + /api/images stay byte-identical and
// untrimmed until the post-3a UI migration; these new routes don't collide
// (distinct path shapes) and delegate to the SAME persistence helpers.
//
// Limits (Nil-confirmed, behavior-preserving): 5 files / 200MB each / 400MB total
// - matching the legacy route + the saveFile MAX_FILE_BYTES storage backstop.
//
// Multipart: the executor skips JSON body-parse for multipart/form-data and passes
// `req`, so the upload handler reads `ctx.req.formData()` directly (the edge the
// executor was designed for). Idempotency is N/A for multipart (the executor
// neither reads nor hashes the body), which is the right call for uploads here.
//
// LEAF over the executor + shared types. UploadsDeps is narrow: the persistence
// helpers only. The guard owns access; getFilePath owns path-traversal safety. No
// agent/room state reaches the handler.

import { ok, fail, file, type RouteHandler } from "../executor.ts";
import type { Attachment } from "../../../shared/types.ts";

const MAX_FILES = 5;
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const MAX_TOTAL = 400 * 1024 * 1024; // 400MB

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export interface UploadsDeps {
  saveFile(
    agentId: string,
    data: Buffer,
    mediaType: string,
    originalName: string,
  ): Attachment | null;
  getFilePath(agentId: string, filename: string): string | null;
  contentTypeFor(filename: string): string;
}

export function uploadsHandlers(
  deps: UploadsDeps,
): Record<string, RouteHandler> {
  return {
    "agents.upload": async (ctx) => {
      // Agent existence is covered by requiresRoomAccess(:id): an unknown agent
      // resolves to a null room and denies as a generic 403, so the handler needs
      // no agent lookup - it only enforces limits + persists.
      let formData: FormData;
      try {
        formData = await ctx.req.formData();
      } catch {
        return fail(400, "invalid_request", "expected multipart/form-data");
      }
      const attachments: Attachment[] = [];
      let fileCount = 0;
      let totalSize = 0;
      for (const [, value] of formData) {
        if (!(value instanceof File)) continue;
        fileCount++;
        if (fileCount > MAX_FILES) {
          return fail(
            400,
            "too_many_files",
            `Maximum ${MAX_FILES} files per upload`,
          );
        }
        if (value.size > MAX_FILE_SIZE) {
          return fail(
            400,
            "file_too_large",
            `File "${value.name}" exceeds 200MB limit`,
          );
        }
        totalSize += value.size;
        if (totalSize > MAX_TOTAL) {
          return fail(
            400,
            "upload_too_large",
            "Total upload exceeds 400MB limit",
          );
        }
        const buffer = Buffer.from(await value.arrayBuffer());
        const att = deps.saveFile(
          ctx.params.id,
          buffer,
          value.type || "application/octet-stream",
          value.name,
        );
        if (att) attachments.push(att);
      }
      return ok({ attachments });
    },

    "agents.getFile": (ctx) => {
      // getFilePath is the ONLY resolver: it blocks path traversal and serves
      // both the files/ dir and the legacy images/ fallback. A miss is a 404.
      const filePath = deps.getFilePath(ctx.params.id, ctx.params.filename);
      if (!filePath) return fail(404, "not_found");
      return file(filePath, deps.contentTypeFor(ctx.params.filename), {
        "Cache-Control": IMMUTABLE_CACHE,
      });
    },
  };
}
