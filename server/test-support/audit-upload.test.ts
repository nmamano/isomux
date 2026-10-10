import { expect, it } from "bun:test";
import { uploadsHandlers } from "../routes/handlers/uploads.ts";
import { withAuditContext } from "../audit-context.ts";
import { officeAuditStore } from "../audit-store.ts";
import type { RouteHandlerContext } from "../routes/executor.ts";
it("a partial multipart upload records only files already saved", async () => {
  const actor = {
    kind: "member" as const,
    id: "partial-upload",
    name: "Uploader",
  };
  let saved = 0;
  const handlers = uploadsHandlers({
    contentTypeFor: () => "text/plain",
    untrustedFileHeaders: () => ({}),
    saveFile: () => ({
      filename: `saved-${++saved}`,
      originalName: "first",
      size: 1,
      mediaType: "text/plain",
    }),
    getFilePath: () => null,
  });
  const first = new File(["x"], "first");
  const second = new File(["y"], "second");
  Object.defineProperty(second, "size", { value: 201 * 1024 * 1024 });
  const request = {
    formData: async () => [
      ["file", first],
      ["file", second],
    ],
  } as unknown as Request;
  const ctx = {
    params: { id: "a" },
    req: request,
  } as unknown as RouteHandlerContext;
  const result = await withAuditContext(actor, "agents.upload", () =>
    handlers["agents.upload"](ctx),
  );
  expect(result.kind).toBe("error");
  expect(saved).toBe(1);
  const rows = officeAuditStore().list({ actorId: actor.id }).items;
  expect(rows).toHaveLength(1);
  expect(rows[0].targets).toEqual(["a/saved-1"]);
  expect(rows[0].fields).toEqual([]);
});
