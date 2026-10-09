// Skills page handlers (opIds skills.catalog / readFile / saveFile / deleteFile / create).
// The catalog is per caller: user skills follow the caller's user (an agent or
// API token resolves to its owning user), and project skills come only from
// agents in rooms the caller can access. Read, save and delete accept only a path that
// the caller's catalog lists, so these routes never reach other files. Save, delete and
// create are gated in the route table by editor:use, the capability behind the
// editor panel's save.
//
// LEAF over the executor + injected SkillsDeps. No manager/store imports.

import { skillFileProblem } from "../../../shared/skill-validation.ts";
import { translatorFor } from "../../../shared/i18n/translate.ts";
import {
  created,
  fail,
  ok,
  noContent,
  type RouteHandler,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type {
  SkillCatalogRes,
  SkillCatalogEntry,
  SkillDeleteReq,
  SkillCreateReq,
  SkillFileRes,
  SkillSaveReq,
} from "../../../shared/contract-shapes.ts";
import {
  findCatalogEntry,
  MAX_SKILL_BYTES,
  type CreateSkillResult,
  type DeleteSkillResult,
} from "../../skill-catalog.ts";
import type { OpenFileResult, SaveFileResult } from "../../file-editor.ts";

export interface SkillsDeps {
  catalogFor(identity: Identity): SkillCatalogRes;
  readFile(path: string): OpenFileResult;
  saveFile(path: string, content: string, expectedRev: number): SaveFileResult;
  deleteFile(
    entry: SkillCatalogEntry,
    expectedRev: number,
    identity: Identity,
  ): Promise<DeleteSkillResult>;
  createSkill(
    newSkillDir: string,
    input: { name: unknown; description: unknown; instructions?: unknown },
  ): CreateSkillResult;
  // Re-read every agent's skills so the Sk menus show the change now.
  refreshMenus(): void;
}

function readResult(
  r: OpenFileResult,
  editable: boolean,
): ReturnType<RouteHandler> {
  if (r.kind === "ok") {
    const body: SkillFileRes = {
      path: r.path,
      content: r.content,
      rev: r.rev,
      mtime: r.mtime,
      editable,
    };
    return ok(body);
  }
  if (r.kind === "not_found" || r.kind === "not_file")
    return fail(404, "skill_not_found", "The skill file is gone.");
  if (r.kind === "too_large")
    return fail(413, "too_large", "The skill file is larger than 1 MB.");
  if (r.kind === "binary")
    return fail(415, "binary", "The skill file is not text.");
  return fail(500, "io_error", r.message);
}

export function skillsHandlers(deps: SkillsDeps): Record<string, RouteHandler> {
  return {
    "skills.catalog": (ctx) => ok(deps.catalogFor(ctx.identity)),

    "skills.readFile": (ctx) => {
      const path = ctx.query.get("path");
      if (!path) return fail(400, "invalid_path", "path is required");
      const entry = findCatalogEntry(deps.catalogFor(ctx.identity), path);
      if (!entry)
        return fail(404, "skill_not_found", "No skill has that path.");
      return readResult(deps.readFile(path), entry.editable);
    },

    "skills.saveFile": (ctx) => {
      const b = (ctx.body ?? {}) as Partial<SkillSaveReq>;
      if (typeof b.path !== "string" || b.path.length === 0)
        return fail(400, "invalid_path", "path is required");
      if (typeof b.content !== "string")
        return fail(422, "invalid_request", "content must be a string");
      if (typeof b.expectedRev !== "number" || !Number.isFinite(b.expectedRev))
        return fail(
          422,
          "invalid_request",
          "expectedRev must be a finite number",
        );
      if (Buffer.byteLength(b.content, "utf8") > MAX_SKILL_BYTES)
        return fail(413, "too_large", "A skill file is at most 1 MB.");
      const entry = findCatalogEntry(deps.catalogFor(ctx.identity), b.path);
      if (!entry)
        return fail(404, "skill_not_found", "No skill has that path.");
      if (!entry.editable)
        return fail(403, "read_only", "This skill is read-only.");
      const problem =
        entry.kind === "skill" ? skillFileProblem(b.content) : null;
      if (problem)
        return fail(422, "invalid_skill", translatorFor("en").t(problem));
      const r = deps.saveFile(b.path, b.content, b.expectedRev);
      if (r.kind === "ok") {
        deps.refreshMenus();
        return ok({ path: r.path, rev: r.rev, mtime: r.mtime });
      }
      if (r.kind === "deleted")
        return fail(409, "deleted", "The skill file was deleted on disk.");
      if (r.kind === "stale")
        return fail(
          409,
          "stale",
          "The skill file changed on disk since you opened it.",
          { currentRev: r.currentRev, currentMtime: r.currentMtime },
        );
      return fail(500, "io_error", r.message);
    },

    "skills.deleteFile": async (ctx) => {
      const b = (ctx.body ?? {}) as Partial<SkillDeleteReq>;
      if (typeof b.path !== "string" || b.path.length === 0)
        return fail(400, "invalid_path", "path is required");
      if (typeof b.expectedRev !== "number" || !Number.isFinite(b.expectedRev))
        return fail(
          422,
          "invalid_request",
          "expectedRev must be a finite number",
        );
      const entry = findCatalogEntry(deps.catalogFor(ctx.identity), b.path);
      if (!entry)
        return fail(404, "skill_not_found", "No skill has that path.");
      if (!entry.editable)
        return fail(403, "read_only", "This skill is read-only.");
      const result = await deps.deleteFile(entry, b.expectedRev, ctx.identity);
      if (result.kind === "ok") {
        deps.refreshMenus();
        return noContent();
      }
      if (result.kind === "read_only")
        return fail(403, "read_only", "This skill is read-only.");
      if (result.kind === "deleted")
        return fail(409, "deleted", "The skill file was deleted on disk.");
      if (result.kind === "stale")
        return fail(
          409,
          "stale",
          "The skill file changed on disk since you opened it.",
          { currentRev: result.currentRev, currentMtime: result.currentMtime },
        );
      return fail(500, "io_error", result.message);
    },

    "skills.create": (ctx) => {
      const b = (ctx.body ?? {}) as Partial<SkillCreateReq>;
      const catalog = deps.catalogFor(ctx.identity);
      const r = deps.createSkill(catalog.newSkillDir, {
        name: b.name,
        description: b.description,
        instructions: b.instructions,
      });
      if (r.kind === "invalid") {
        const message =
          r.field === "name"
            ? "name must be 1-64 lowercase letters, digits and single hyphens"
            : r.field === "description"
              ? "description must be one line of 1-1024 characters"
              : "instructions must be a string, and the file at most 1 MB";
        return fail(422, `invalid_${r.field}`, message);
      }
      if (r.kind === "exists")
        return fail(409, "skill_exists", "A skill with that name exists.", {
          path: r.path,
        });
      if (r.kind === "io_error") return fail(500, "io_error", r.message);
      deps.refreshMenus();
      const file = deps.readFile(r.path);
      if (file.kind !== "ok") return readResult(file, true);
      const body: SkillFileRes = {
        path: file.path,
        content: file.content,
        rev: file.rev,
        mtime: file.mtime,
        editable: true,
      };
      return created(body);
    },
  };
}
