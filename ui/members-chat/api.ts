// REST calls for the human chats: the room chats
// (server/routes/handlers/members-chat.ts) and the 1:1 chats
// (server/routes/handlers/member-dms.ts). Everything JSON goes through
// apiFetch so the demo shim can answer it; the multipart upload is a raw
// fetch, like the agent chat's, because apiFetch only speaks JSON.

import { apiFetch, ApiError } from "../api.ts";
import type { Attachment, MembersChatMessage } from "../../shared/types.ts";
import type {
  MemberDmPageRes,
  MembersChatPageRes,
  MembersChatReadRes,
} from "../../shared/contract-shapes.ts";
import type { HumanChatKey } from "../human-chat.ts";

export const MEMBERS_CHAT_PAGE_LIMIT = 100;

// One chat's REST calls: a room chat, or a 1:1 chat with peerId (no pins).
export interface ChatApi {
  filesBase: string;
  fetchPage: (opts: {
    before?: string;
    limit?: number;
  }) => Promise<MembersChatPageRes | MemberDmPageRes>;
  post: (input: {
    text: string;
    replyTo?: string;
    attachments: Attachment[];
    device?: string;
  }) => Promise<MembersChatMessage>;
  edit: (id: string, text: string) => Promise<MembersChatMessage>;
  setThumbsUp: (id: string, active: boolean) => Promise<MembersChatMessage>;
  // Room chats only.
  setPinned?: (id: string, active: boolean) => Promise<MembersChatMessage>;
  remove: (id: string) => Promise<void>;
  markRead: (lastReadId: string) => Promise<MembersChatReadRes>;
  upload: (files: File[]) => Promise<Attachment[]>;
}

function apiAt<P>(base: string) {
  return {
    filesBase: `${base}/files`,
    fetchPage: (opts: { before?: string; limit?: number }): Promise<P> => {
      const q = new URLSearchParams();
      if (opts.before) q.set("before", opts.before);
      if (opts.limit) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return apiFetch<P>("GET", `${base}${qs ? `?${qs}` : ""}`);
    },
    post: (input: {
      text: string;
      replyTo?: string;
      attachments: Attachment[];
      device?: string;
    }): Promise<MembersChatMessage> => {
      return apiFetch<MembersChatMessage>("POST", base, input);
    },
    edit: (id: string, text: string): Promise<MembersChatMessage> => {
      return apiFetch<MembersChatMessage>("PATCH", `${base}/${id}`, { text });
    },
    setThumbsUp: (id: string, active: boolean): Promise<MembersChatMessage> => {
      return apiFetch<MembersChatMessage>("PUT", `${base}/${id}/thumbs-up`, {
        active,
      });
    },
    remove: (id: string): Promise<void> => {
      return apiFetch<void>("DELETE", `${base}/${id}`);
    },
    markRead: (lastReadId: string): Promise<MembersChatReadRes> => {
      return apiFetch<MembersChatReadRes>("POST", `${base}/read`, {
        lastReadId,
      });
    },
    upload: async (files: File[]): Promise<Attachment[]> => {
      const formData = new FormData();
      for (const f of files) formData.append("files", f);
      const res = await fetch(`${base}/uploads`, {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });
      if (!res.ok) throw new ApiError(res.status, "upload_failed", "");
      const data = (await res.json()) as { attachments: Attachment[] };
      return data.attachments;
    },
  };
}

interface RoomChatApi extends ChatApi {
  fetchPage: (opts: {
    before?: string;
    limit?: number;
  }) => Promise<MembersChatPageRes>;
  setPinned: (id: string, active: boolean) => Promise<MembersChatMessage>;
}

// A room's chat (the lobby's was the members chat).
export function roomChatApi(roomId: string): RoomChatApi {
  const base = `/api/rooms/${encodeURIComponent(roomId)}/chat`;
  return {
    ...apiAt<MembersChatPageRes>(base),
    setPinned: (id: string, active: boolean): Promise<MembersChatMessage> =>
      apiFetch<MembersChatMessage>("PUT", `${base}/${id}/pin`, { active }),
  };
}

// A 1:1 chat's calls go to the peer's id, never a name: a rename or a reused
// name never sends to someone else.
export function chatApiFor(chat: HumanChatKey): ChatApi {
  if (chat.kind === "room") return roomChatApi(chat.roomId);
  return apiAt<MemberDmPageRes>(
    `/api/users/${encodeURIComponent(chat.peerId)}/chat`,
  );
}
