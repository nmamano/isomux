// The folder rules as pure functions (task 329974fe): the room folder a
// member with a pack keeps their Folder and Web agents in, the one share they
// allow (agents below Standard of one room, at that room's folder), and the
// office state no agent, schedule or app may work inside. The routes, the
// clamp and the session gate are in test-support/pack-room-folder.test.ts.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentAccess } from "../shared/agent-access.ts";
import {
  confinedFolderRefusal,
  folderOverlapRefusal,
  stateFolderRefusal,
  type FolderRuleAgent,
  type FolderRuleState,
} from "./agent-folder-rules.ts";

const root = mkdtempSync(join(tmpdir(), "folder-rules-"));
afterAll(() => rmSync(root, { recursive: true }));

let n = 0;
function dir(...parts: string[]): string {
  const path = parts.length ? join(root, ...parts) : join(root, `d${n++}`);
  mkdirSync(path, { recursive: true });
  return path;
}

const stateRoot = dir("state");
const home = dir("home");

// A state whose rooms have the folders in `rooms` (absent: no folder).
function stateWith(
  agents: FolderRuleAgent[],
  rooms: Record<string, string>,
  workloads: { schedules?: string[]; apps?: string[] } = {},
): FolderRuleState {
  return {
    stateRoot,
    home,
    providerHomes: [],
    agents,
    roomCwd: (roomId) => rooms[roomId] ?? null,
    schedules: (workloads.schedules ?? []).map((cwd) => ({ name: "S", cwd })),
    apps: (workloads.apps ?? []).map((cwd) => ({ name: "A", cwd })),
  };
}

const agent = (
  id: string,
  roomId: string,
  cwd: string,
  access?: AgentAccess,
): FolderRuleAgent => ({ id, name: id, roomId, cwd, access });

const ROOM_ONLY = { roomFolderOnly: true };

describe("a member's Folder agent keeps its files in its room's folder", () => {
  it("passes the room folder itself and refuses every other folder", () => {
    const roomFolder = dir();
    const state = stateWith([], { r1: roomFolder });
    const me = { id: "me", name: "Me", roomId: "r1" };
    expect(confinedFolderRefusal(me, roomFolder, state, ROOM_ONLY)).toBeNull();
    const sub = join(roomFolder, "sub");
    mkdirSync(sub);
    for (const [label, inside] of [
      ["a subfolder", sub],
      ["a folder elsewhere", dir()],
    ] as const) {
      expect({
        label,
        refused: confinedFolderRefusal(me, inside, state, ROOM_ONLY) !== null,
      }).toEqual({ label, refused: true });
      // The enabling condition: without the rule the same folder passes.
      expect({
        label,
        refused: confinedFolderRefusal(me, inside, state) !== null,
      }).toEqual({ label, refused: false });
    }
  });

  it("refuses every folder in a room with no folder", () => {
    const folder = dir();
    const state = stateWith([], {});
    const me = { id: "me", name: "Me", roomId: "r1" };
    expect(confinedFolderRefusal(me, folder, state, ROOM_ONLY)).not.toBeNull();
    expect(confinedFolderRefusal(me, folder, state)).toBeNull();
  });

  it("judges by the path as written and by where it points", () => {
    const target = dir();
    const roomLink = join(dir(), "room-link");
    symlinkSync(target, roomLink);
    // The room's folder is a link: the link passes, its target does not
    // (same real path, other literal path).
    const linked = stateWith([], { r1: roomLink });
    const me = { id: "me", name: "Me", roomId: "r1" };
    expect(confinedFolderRefusal(me, roomLink, linked, ROOM_ONLY)).toBeNull();
    expect(confinedFolderRefusal(me, target, linked, ROOM_ONLY)).not.toBeNull();
    // A link to the room folder from elsewhere is refused too.
    const plain = dir();
    const other = join(dir(), "to-room");
    symlinkSync(plain, other);
    const state = stateWith([], { r1: plain });
    expect(confinedFolderRefusal(me, plain, state, ROOM_ONLY)).toBeNull();
    expect(confinedFolderRefusal(me, other, state, ROOM_ONLY)).not.toBeNull();
  });
});

describe("agents below Standard of one room share its folder", () => {
  it("a Folder agent joins the room folder where Folder, Web, Office and Chat agents of the room work", () => {
    for (const access of ["folder", "web", "office", "chat"] as const) {
      const roomFolder = dir();
      const state = stateWith([agent("o", "r1", roomFolder, access)], {
        r1: roomFolder,
      });
      const me = { id: "me", name: "Me", roomId: "r1" };
      expect({
        access,
        refusal: confinedFolderRefusal(me, roomFolder, state),
      }).toEqual({ access, refusal: null });
      // The same with the room-folder rule of a member with a pack.
      expect({
        access,
        refusal: confinedFolderRefusal(me, roomFolder, state, ROOM_ONLY),
      }).toEqual({ access, refusal: null });
    }
  });

  it("a full agent at the room folder still refuses it", () => {
    for (const access of ["standard", "privileged", undefined] as const) {
      const roomFolder = dir();
      const state = stateWith([agent("o", "r1", roomFolder, access)], {
        r1: roomFolder,
      });
      const me = { id: "me", name: "Me", roomId: "r1" };
      expect({
        access,
        refused: confinedFolderRefusal(me, roomFolder, state) !== null,
      }).toEqual({ access, refused: true });
    }
  });

  it("no share in another room with the same folder, in a subfolder, or at a folder that is not the room's", () => {
    const roomFolder = dir();
    const me = { id: "me", name: "Me", roomId: "r1" };
    // The control: the share holds in one room.
    expect(
      confinedFolderRefusal(
        me,
        roomFolder,
        stateWith([agent("o", "r1", roomFolder, "folder")], { r1: roomFolder }),
      ),
    ).toBeNull();
    // Another room with the same folder.
    expect(
      confinedFolderRefusal(
        me,
        roomFolder,
        stateWith([agent("o", "r2", roomFolder, "folder")], {
          r1: roomFolder,
          r2: roomFolder,
        }),
      ),
    ).not.toBeNull();
    // A subfolder of the room folder, where a room agent works.
    const sub = join(roomFolder, "sub");
    mkdirSync(sub);
    expect(
      confinedFolderRefusal(
        me,
        sub,
        stateWith([agent("o", "r1", roomFolder, "folder")], { r1: roomFolder }),
      ),
    ).not.toBeNull();
    // The room agent works in a subfolder and the new one at the room folder.
    expect(
      confinedFolderRefusal(
        me,
        roomFolder,
        stateWith([agent("o", "r1", sub, "folder")], { r1: roomFolder }),
      ),
    ).not.toBeNull();
    // Two agents of one room at one folder that is not the room's.
    const elsewhere = dir();
    expect(
      confinedFolderRefusal(
        me,
        elsewhere,
        stateWith([agent("o", "r1", elsewhere, "folder")], {
          r1: roomFolder,
        }),
      ),
    ).not.toBeNull();
  });

  it("an Office or Chat agent may work at the room folder of Folder agents; a full agent, a schedule or an app may not", () => {
    const roomFolder = dir();
    const state = stateWith([agent("o", "r1", roomFolder, "folder")], {
      r1: roomFolder,
    });
    const self = (access: AgentAccess, roomId = "r1") => ({
      id: "me",
      roomId,
      access,
    });
    for (const access of ["office", "chat"] as const)
      expect({
        access,
        refusal: folderOverlapRefusal(roomFolder, self(access), state),
      }).toEqual({ access, refusal: null });
    for (const access of ["standard", "privileged"] as const)
      expect({
        access,
        refused: folderOverlapRefusal(roomFolder, self(access), state) !== null,
      }).toEqual({ access, refused: true });
    // A schedule or an app.
    expect(folderOverlapRefusal(roomFolder, null, state)).not.toBeNull();
    // An Office agent of another room, or in a subfolder.
    expect(
      folderOverlapRefusal(roomFolder, self("office", "r2"), {
        ...state,
        roomCwd: (id) => (id === "r1" || id === "r2" ? roomFolder : null),
      }),
    ).not.toBeNull();
    const sub = join(roomFolder, "office-sub");
    mkdirSync(sub);
    expect(folderOverlapRefusal(sub, self("office"), state)).not.toBeNull();
  });
});

describe("no agent, schedule or app works inside the office state", () => {
  it("refuses the state and a folder inside it, also through a link; holding it passes", () => {
    const inside = dir("state", "inside");
    const link = join(dir(), "into-state");
    symlinkSync(inside, link);
    for (const [label, cwd, refused] of [
      ["the state", stateRoot, true],
      ["inside the state", inside, true],
      ["a link into the state", link, true],
      ["the folder that holds the state", root, false],
      ["a folder elsewhere", dir(), false],
    ] as const)
      expect({
        label,
        refused: stateFolderRefusal(cwd, stateRoot) !== null,
      }).toEqual({ label, refused });
  });
});

// Task 6f802809: the office state lives in the home folder by default
// (~/.isomux), so a Folder or Web agent at the home folder breaks both rules.
// The refusal names the one the member chose, the home folder.
describe("a Folder or Web agent at the home folder that holds the office state", () => {
  it("is refused for the home folder, not for the state", () => {
    const homeWithState = dir("home-with-state");
    const stateInHome = dir("home-with-state", ".isomux");
    const me = { id: "me", name: "Me", roomId: "r1" };
    const refusal = (home: string, state: string) =>
      confinedFolderRefusal(me, homeWithState, {
        ...stateWith([], {}),
        home,
        stateRoot: state,
      });
    // Each rule alone, to tell the two reasons apart without their copy.
    const homeOnly = refusal(homeWithState, stateRoot);
    const stateOnly = refusal(home, stateInHome);
    expect({
      homeOnly: homeOnly !== null,
      stateOnly: stateOnly !== null,
      distinct: homeOnly !== stateOnly,
    }).toEqual({ homeOnly: true, stateOnly: true, distinct: true });
    expect(refusal(homeWithState, stateInHome)).toBe(homeOnly);
  });
});
