// One chat's REST calls (chatApiFor, task 019e4d7c): a 1:1 chat's calls all go
// to /api/users/<peer id>/chat (by id, never a name, so a rename or a reused
// name never sends to someone else), with no pin; Members chat keeps its own.

import { afterEach, describe, expect, it } from "bun:test";
import { setApiShim } from "../api.ts";
import { chatApiFor } from "./api.ts";

const calls: string[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  setApiShim(null);
  globalThis.fetch = realFetch;
  calls.length = 0;
});

function record() {
  setApiShim(async (method, path) => {
    calls.push(`${method} ${path}`);
    return { messages: [], hasMore: false, readPointer: null, unread: 0 };
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(JSON.stringify({ attachments: [] }), { status: 200 });
  }) as typeof fetch;
}

async function everyCall(api: ReturnType<typeof chatApiFor>) {
  await api.fetchPage({ before: "202611-00000001", limit: 50 });
  await api.post({ text: "hi", attachments: [] });
  await api.edit("202611-00000002", "edited");
  await api.setThumbsUp("202611-00000002", true);
  await api.remove("202611-00000002");
  await api.markRead("202611-00000002");
  await api.upload([new File(["x"], "x.txt")]);
}

describe("chatApiFor", () => {
  it("sends every call of a 1:1 chat to the peer's id, with no pin", async () => {
    record();
    const api = chatApiFor({ kind: "dm", peerId: "a-b_9" });
    expect(api.setPinned).toBeUndefined();
    expect(api.filesBase).toBe("/api/users/a-b_9/chat/files");
    await everyCall(api);
    expect(calls).toEqual([
      "GET /api/users/a-b_9/chat?before=202611-00000001&limit=50",
      "POST /api/users/a-b_9/chat",
      "PATCH /api/users/a-b_9/chat/202611-00000002",
      "PUT /api/users/a-b_9/chat/202611-00000002/thumbs-up",
      "DELETE /api/users/a-b_9/chat/202611-00000002",
      "POST /api/users/a-b_9/chat/read",
      "POST /api/users/a-b_9/chat/uploads",
    ]);
  });

  it("keeps Members chat on its own routes, with its pin", async () => {
    record();
    const api = chatApiFor({ kind: "members" });
    expect(typeof api.setPinned).toBe("function");
    expect(api.filesBase).toBe("/api/members-chat/files");
    await everyCall(api);
    await api.setPinned!("202611-00000002", true);
    expect(calls).toEqual([
      "GET /api/members-chat?before=202611-00000001&limit=50",
      "POST /api/members-chat",
      "PATCH /api/members-chat/202611-00000002",
      "PUT /api/members-chat/202611-00000002/thumbs-up",
      "DELETE /api/members-chat/202611-00000002",
      "POST /api/members-chat/read",
      "POST /api/members-chat/uploads",
      "PUT /api/members-chat/202611-00000002/pin",
    ]);
  });
});
