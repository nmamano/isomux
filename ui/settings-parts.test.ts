// The part lists of Settings drill-in (task 1f79f2e3): which parts each
// viewer gets for a member and a room, in order. A part with nothing for the
// viewer is not listed. One rule for every type (Nil, 2026-11-17, task
// 03ffafc1): General first, then Access, then Instructions and memory, then
// the parts only that type has; a member's Rooms stays its own part after
// Access. The DOM side (each listed part shows its fields) is in
// ui/components/UserSettingsView.drill-in.dom.test.tsx.

import { describe, expect, it } from "bun:test";
import {
  AGENT_FIELD_PART,
  MEMBER_FIELD_PART,
  ROOM_FIELD_PART,
  memberParts,
  roomParts,
  type MemberPart,
} from "./settings-parts.ts";

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
        "general",
        "access",
        "rooms",
        "instructions",
        "osUser",
        "signIn",
        "chat",
      ],
    },
    {
      // Task 12c796b2: an owner may have their own OS user too.
      who: "an owner on another owner",
      v: {
        viewerIsOwner: true,
        isMe: false,
        creating: false,
        targetIsOwner: true,
      },
      parts: [
        "general",
        "access",
        "rooms",
        "instructions",
        "osUser",
        "signIn",
        "chat",
      ],
    },
    {
      who: "an owner on themself",
      v: {
        viewerIsOwner: true,
        isMe: true,
        creating: false,
        targetIsOwner: true,
      },
      parts: ["general", "access", "rooms", "instructions", "osUser"],
    },
    {
      who: "an owner creating a member",
      v: {
        viewerIsOwner: true,
        isMe: false,
        creating: true,
        targetIsOwner: false,
      },
      parts: ["general", "access", "rooms", "instructions", "chat"],
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
      parts: ["general", "access", "instructions", "chat"],
    },
    {
      who: "a member on themself",
      v: {
        viewerIsOwner: false,
        isMe: true,
        creating: false,
        targetIsOwner: false,
      },
      parts: ["general", "rooms", "instructions"],
    },
  ];
  for (const c of cases)
    it(c.who, () => {
      expect(memberParts(c.v)).toStrictEqual(c.parts);
    });
});

describe("roomParts", () => {
  it("a room with the viewer's view row has all three; no view row, no Your view", () => {
    expect({
      room: roomParts({ hasView: true }),
      noView: roomParts({ hasView: false }),
    }).toStrictEqual({
      room: ["general", "instructions", "view"],
      noView: ["general", "instructions"],
    });
  });
});

// The fields that moved into General (task 03ffafc1): the part a refused save
// opens and the part that shows the dot both read these tables.
describe("the field tables", () => {
  it("name and look and folder are General's for every type; an agent's manager and access level stay Access's", () => {
    expect({
      member: [MEMBER_FIELD_PART.name, MEMBER_FIELD_PART.avatar],
      room: [ROOM_FIELD_PART.name, ROOM_FIELD_PART.look, ROOM_FIELD_PART.cwd],
      agent: [
        AGENT_FIELD_PART.name,
        AGENT_FIELD_PART.outfit,
        AGENT_FIELD_PART.cwd,
      ],
      agentAccess: [
        AGENT_FIELD_PART.manager,
        AGENT_FIELD_PART.access,
        AGENT_FIELD_PART.privileged,
      ],
    }).toStrictEqual({
      member: ["general", "general"],
      room: ["general", "general", "general"],
      agent: ["general", "general", "general"],
      agentAccess: ["access", "access", "access"],
    });
  });

  it("every part a field maps to is a listed part, so its dot and its refused save have a row", () => {
    const listed = {
      member: new Set<string>(
        memberParts({
          viewerIsOwner: true,
          isMe: false,
          creating: false,
          targetIsOwner: false,
        }),
      ),
      room: new Set<string>(roomParts({ hasView: true })),
    };
    expect({
      member: Object.values(MEMBER_FIELD_PART).filter(
        (p) => !listed.member.has(p),
      ),
      room: Object.values(ROOM_FIELD_PART).filter((p) => !listed.room.has(p)),
    }).toStrictEqual({ member: [], room: [] });
  });
});
