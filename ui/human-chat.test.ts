// The address of a human chat (task 019e4d7c): /chats/members and
// /chats/<userId> open a chat at boot; a web push opens /chats/<senderId>.

import { describe, it, expect } from "bun:test";
import { humanChatForPath } from "./human-chat.ts";

describe("humanChatForPath", () => {
  it("reads Members chat and a 1:1 chat, with a trailing slash forgiven", () => {
    expect(humanChatForPath("/chats/members")).toEqual({ kind: "members" });
    expect(humanChatForPath("/chats/members/")).toEqual({ kind: "members" });
    expect(humanChatForPath("/chats/0a1b2c3d")).toEqual({
      kind: "dm",
      peerId: "0a1b2c3d",
    });
    expect(humanChatForPath("/chats/0a1b2c3d/")).toEqual({
      kind: "dm",
      peerId: "0a1b2c3d",
    });
    // The push link encodes the id.
    expect(humanChatForPath("/chats/a%2Db")).toEqual({
      kind: "dm",
      peerId: "a-b",
    });
  });

  it("names no chat for any other path", () => {
    for (const path of [
      "/",
      "/chats",
      "/chats/",
      "/chats/a/b",
      "/agents/a1",
      "/chatsmembers",
      "/x/chats/members",
      "/chats/%E0%A4%A",
    ])
      expect([path, humanChatForPath(path)]).toEqual([path, null]);
  });
});
