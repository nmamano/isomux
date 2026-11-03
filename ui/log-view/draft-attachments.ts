// The attachments of an unsent chat draft, per agent. They live in the store
// beside the draft text (store.draftAttachments), so they outlast the
// composer: a member who leaves an agent's chat and comes back finds them
// again, and the Inbox chat panel shows the same ones. An upload that ends
// after the composer is gone still lands in the draft.
import { MAX_UPLOAD_BYTES, type Attachment } from "../../shared/types.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";

export type DraftAttachment = Attachment & {
  id: string;
  uploading: boolean;
  // Language-independent: the words are chosen at render time, so a language
  // switch with a failed upload on screen re-reads it. `status` is Isomux's
  // own "upload failed" case; `raw` is whatever the browser threw, passed
  // through as delivered.
  error?:
    | { kind: "key"; key: PlainMessageKey }
    | { kind: "status"; status: number }
    | { kind: "raw"; text: string };
};

// The store actions on draft attachments. An empty list deletes the agent's
// entry.
export type DraftAttachmentAction =
  | { type: "add_draft_attachments"; agentId: string; items: DraftAttachment[] }
  // No-op when the id is gone (removed or sent meanwhile).
  | {
      type: "patch_draft_attachment";
      agentId: string;
      id: string;
      patch: Partial<DraftAttachment>;
    }
  | { type: "remove_draft_attachments"; agentId: string; ids: string[] }
  | { type: "clear_draft_attachments"; agentId: string };

// The one upload failure Isomux words itself. Thrown so the catch below can
// tell it apart from whatever the browser threw, and carrying the status
// rather than a sentence, because the draft holds it across renders and a
// language switch has to be able to re-word it.
class UploadStatusError extends Error {
  constructor(readonly status: number) {
    super(`upload failed with status ${status}`);
  }
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** Uploads `files` to the agent and tracks each one in its draft: added as
 * uploading (or as too large, without an upload), then patched with the
 * uploaded reference or the error. With `imagesOnly`, a file that is not an
 * image is dropped before any upload (the Inbox chat panel's picker and
 * paste path). */
export function uploadDraftFiles(
  dispatch: (action: DraftAttachmentAction) => void,
  agentId: string,
  files: readonly File[],
  opts?: { imagesOnly?: boolean },
): void {
  for (const file of files) {
    if (opts?.imagesOnly && !file.type.startsWith("image/")) continue;
    const id = newId();
    const base = {
      id,
      filename: "",
      originalName: file.name,
      mediaType: file.type || "application/octet-stream",
      size: file.size,
    };
    if (file.size > MAX_UPLOAD_BYTES) {
      dispatch({
        type: "add_draft_attachments",
        agentId,
        items: [
          {
            ...base,
            uploading: false,
            error: { kind: "key", key: "logView.attachTooLarge" },
          },
        ],
      });
      continue;
    }
    dispatch({
      type: "add_draft_attachments",
      agentId,
      items: [{ ...base, uploading: true }],
    });
    const formData = new FormData();
    formData.append("file", file);
    fetch(`/api/upload/${agentId}`, { method: "POST", body: formData })
      .then((res) => {
        if (!res.ok) throw new UploadStatusError(res.status);
        return res.json();
      })
      .then((data: { attachments: Attachment[] }) => {
        const att = data.attachments[0];
        if (!att) throw new UploadStatusError(500);
        dispatch({
          type: "patch_draft_attachment",
          agentId,
          id,
          patch: { ...att, uploading: false },
        });
      })
      .catch((err) => {
        dispatch({
          type: "patch_draft_attachment",
          agentId,
          id,
          patch: {
            uploading: false,
            error:
              err instanceof UploadStatusError
                ? { kind: "status", status: err.status }
                : { kind: "raw", text: (err as Error).message },
          },
        });
      });
  }
}

/** Draft items for references that are already uploaded: a restored draft,
 * or a not-sent message brought back into the composer. */
export function asDraftAttachments(
  attachments: readonly Attachment[],
): DraftAttachment[] {
  return attachments.map((att) => ({ ...att, id: newId(), uploading: false }));
}

/** The references a send carries: uploaded items only, without the draft
 * fields. In-flight and errored items are dropped. */
export function uploadedOnly(items: readonly DraftAttachment[]): Attachment[] {
  return items
    .filter((item) => !item.uploading && !item.error)
    .map(({ filename, originalName, mediaType, size }) => ({
      filename,
      originalName,
      mediaType,
      size,
    }));
}
