// REST calls for the members chat (server/routes/handlers/members-chat.ts).
// Everything JSON goes through apiFetch so the demo shim can answer it; the
// multipart upload is a raw fetch, like the agent chat's, because apiFetch only
// speaks JSON.

import { apiFetch, ApiError } from "../api.ts";
import type { Attachment, MembersChatMessage } from "../../shared/types.ts";
import type {
  MembersChatPageRes,
  MembersChatReadRes,
} from "../../shared/contract-shapes.ts";

// Where a message's attachments are served from (the card builds
// `${base}/${filename}`).
export const MEMBERS_CHAT_FILES_BASE = "/api/members-chat/files";

export const MEMBERS_CHAT_PAGE_LIMIT = 100;

export function fetchPage(opts: {
  before?: string;
  limit?: number;
}): Promise<MembersChatPageRes> {
  const q = new URLSearchParams();
  if (opts.before) q.set("before", opts.before);
  if (opts.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return apiFetch<MembersChatPageRes>(
    "GET",
    `/api/members-chat${qs ? `?${qs}` : ""}`,
  );
}

export function post(input: {
  text: string;
  attachments: Attachment[];
  device?: string;
}): Promise<MembersChatMessage> {
  return apiFetch<MembersChatMessage>("POST", "/api/members-chat", input);
}

export function edit(id: string, text: string): Promise<MembersChatMessage> {
  return apiFetch<MembersChatMessage>("PATCH", `/api/members-chat/${id}`, {
    text,
  });
}

export function setThumbsUp(id: string, active: boolean): Promise<MembersChatMessage> {
  return apiFetch<MembersChatMessage>("PUT", `/api/members-chat/${id}/thumbs-up`, { active });
}

export function remove(id: string): Promise<void> {
  return apiFetch<void>("DELETE", `/api/members-chat/${id}`);
}

export function markRead(lastReadId: string): Promise<MembersChatReadRes> {
  return apiFetch<MembersChatReadRes>("POST", "/api/members-chat/read", {
    lastReadId,
  });
}

export async function upload(files: File[]): Promise<Attachment[]> {
  const formData = new FormData();
  for (const f of files) formData.append("files", f);
  const res = await fetch("/api/members-chat/uploads", {
    method: "POST",
    body: formData,
    credentials: "same-origin",
  });
  if (!res.ok) throw new ApiError(res.status, "upload_failed", "");
  const data = (await res.json()) as { attachments: Attachment[] };
  return data.attachments;
}
