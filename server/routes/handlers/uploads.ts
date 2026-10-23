import { savedFileAudit } from "../audit.ts";
// Upload + file-serving handlers for chat attachments. Two route pairs share
// the same bodies and differ in their guards (server/routes/table.ts):
//
// chatFiles.upload  POST /api/upload/:id, chatFiles.get / chatFiles.getImage
// GET /api/files|images/:id/:filename - the paths the chat UI links. Any office
// identity but apps and API tokens; agentFilesUpload / agentFilesRead decide
// by room (killed agents and cronjob run streams included for reads).
//
// agents.upload  POST /api/agents/:id/uploads - `file:upload` + room access
// agents.getFile GET  /api/agents/:id/files/:filename - `office:read` + room
// access. Live agents only; no caller in the UI.
//
// Limits: 5 files / 200MB each / 400MB total
// - matching the legacy route + the saveFile MAX_UPLOAD_BYTES storage backstop.
//
// Multipart: the executor skips JSON body-parse for multipart/form-data and passes
// `req`, so the upload handler reads `ctx.req.formData()` directly (the edge the
// executor was designed for). Idempotency is N/A for multipart (the executor
// neither reads nor hashes the body), which is the right call for uploads here.
//
// LEAF over the executor + shared types. UploadsDeps is narrow: the persistence
// helpers only. The guards own access; getFilePath owns path-traversal safety.
// No agent/room state reaches the handler.

import { ok, fail, file, type RouteHandler } from "../executor.ts";
import { downloadHeader } from "../../mime-types.ts";
import type { Attachment } from "../../../shared/types.ts";
import { MAX_UPLOAD_BYTES } from "../../../shared/types.ts";

const MAX_FILES = 5;
const MAX_TOTAL = 400 * 1024 * 1024; // 400MB

export interface UploadsDeps {
  saveFile(
    agentId: string,
    data: Buffer,
    mediaType: string,
    originalName: string,
  ): Attachment | null;
  getFilePath(agentId: string, filename: string): string | null;
  contentTypeFor(filename: string): string;
  // Sandbox and private-cache headers: an opened file must not run as office
  // content, and a shared cache must not store it.
  untrustedFileHeaders(): Record<string, string>;
}

export function uploadsHandlers(
  deps: UploadsDeps,
): Record<string, RouteHandler> {
  const upload: RouteHandler = async (ctx) => {
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
      if (value.size > MAX_UPLOAD_BYTES) {
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
      if (att) {
        savedFileAudit(`${ctx.params.id}/${att.filename}`);
        attachments.push(att);
      }
    }
    return ok({ attachments });
  };

  const getFile: RouteHandler = (ctx) => {
    // getFilePath is the ONLY resolver: it blocks path traversal and serves
    // both the files/ dir and the legacy images/ fallback. A miss is a 404.
    const filePath = deps.getFilePath(ctx.params.id, ctx.params.filename);
    if (!filePath) return fail(404, "not_found");
    return file(filePath, deps.contentTypeFor(ctx.params.filename), {
      ...deps.untrustedFileHeaders(),
      ...downloadHeader(ctx.query, ctx.params.filename),
    });
  };

  return {
    "agents.upload": upload,
    "agents.getFile": getFile,
    // The paths the chat UI links. Same bodies; the guards differ (see the
    // route table).
    "chatFiles.upload": upload,
    "chatFiles.get": getFile,
    "chatFiles.getImage": getFile,
  };
}
