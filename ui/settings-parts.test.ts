// The part lists of Settings drill-in (task 1f79f2e3): which parts each
// viewer gets for a member and a room, in order. A part with nothing for the
// viewer is not listed. The DOM side (each listed part shows its fields) is
// in ui/components/UserSettingsView.drill-in.dom.test.tsx.

import { describe, expect, it } from "bun:test";
import { memberParts, roomParts, type MemberPart } from "./settings-parts.ts";

describe("memberParts", () => {
  const cases: {
    who: string;
    v: Parameters<typeof memberParts>[0];
    parts: MemberPart[];
  }[] = [
    {
      who: "an owner on a member",
      v: {
        viewerIsOwner: true,
        isMe: false,
        creating: false,
        targetIsOwner: false,
      },
      parts: [
        "profile",
        "access",
        "osUser",
        "signIn",
        "rooms",
        "instructions",
        "chat",
      ],
    },
    {
      // An owner reaches every room and runs as the office: no OS user.
      who: "an owner on another owner",
      v: {
        viewerIsOwner: true,
        isMe: false,
        creating: false,
        targetIsOwner: true,
      },
      parts: ["profile", "access", "signIn", "rooms", "instructions", "chat"],
    },
    {
      who: "an owner on themself",
      v: {
        viewerIsOwner: true,
        isMe: true,
        creating: false,
        targetIsOwner: true,
      },
      parts: ["profile", "access", "rooms", "instructions"],
    },
    {
      who: "an owner creating a member",
      v: {
        viewerIsOwner: true,
        isMe: false,
        creating: true,
        targetIsOwner: false,
      },
      parts: ["profile", "access", "rooms", "instructions", "chat"],
    },
    {
      // No rooms table (an owner reaches all) and no pins before the record.
      who: "an owner creating an owner",
      v: {
        viewerIsOwner: true,
        isMe: false,
        creating: true,
        targetIsOwner: true,
      },
      parts: ["profile", "access", "instructions", "chat"],
    },
    {
      who: "a member on themself",
      v: {
        viewerIsOwner: false,
        isMe: true,
        creating: false,
        targetIsOwner: false,
      },
      parts: ["profile", "rooms", "instructions"],
    },
  ];
  for (const c of cases)
    it(c.who, () => {
      expect(memberParts(c.v)).toStrictEqual(c.parts);
    });
});

describe("roomParts", () => {
  it("a room with the viewer's view row has all four; the lobby has no look; no view row, no Your view", () => {
    expect({
      room: roomParts({ lobby: false, hasView: true }),
      lobby: roomParts({ lobby: true, hasView: false }),
      noView: roomParts({ lobby: false, hasView: false }),
    }).toStrictEqual({
      room: ["general", "instructions", "appearance", "view"],
      lobby: ["general", "instructions"],
      noView: ["general", "instructions", "appearance"],
    });
  });
});
