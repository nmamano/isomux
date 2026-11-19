// The address of a human chat (task 019e4d7c): /chats/rooms/<roomId> (task
// 5b055cf3), /chats/members (the lobby's chat, from before room chats) and
// /chats/<userId> open a chat at boot; a web push opens /chats/<senderId>.

import { describe, it, expect } from "bun:test";
import { humanChatForPath } from "./human-chat.ts";

describe("humanChatForPath", () => {
  it("reads a room chat, the old members chat address and a 1:1 chat, with a trailing slash forgiven", () => {
    const lobby = { kind: "room", roomId: "lobby" } as const;
    expect(humanChatForPath("/chats/members")).toEqual(lobby);
    expect(humanChatForPath("/chats/members/")).toEqual(lobby);
    expect(humanChatForPath("/chats/rooms/lobby")).toEqual(lobby);
    expect(humanChatForPath("/chats/rooms/a1b2c3d4/")).toEqual({
      kind: "room",
      roomId: "a1b2c3d4",
    });
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
      "/chats/rooms/a/b",
      "/chats/rooms/%E0%A4%A",
      "/agents/a1",
      "/chatsmembers",
      "/x/chats/members",
      "/chats/%E0%A4%A",
    ])
      expect([path, humanChatForPath(path)]).toEqual([path, null]);
  });
});
