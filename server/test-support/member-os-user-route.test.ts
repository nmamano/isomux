// GET /api/users/:username/os-user (task b94dfd25 4c-i): the owner's view of
// a member's own OS user, through the real server. The properties:
// - only an office owner's reach reads it (the owner, their privileged agent,
//   their API token); a room-limited token, a plain agent and a member get
//   403; an unknown member is 404 to an owner;
// - the office's support verdict goes through as is (the reason where the
//   command cannot run, with no command), and nothing else of the member's
//   record does;
// - the command holds the member id only: a member named with a quote,
//   spaces and dashes changes no word of it; an owner gets theirs too.
//
// Seam: startTestServer() - real auth, executor and guards. The verdict is
// set (the installer's container), so the commands are set on any box.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { userInfo } from "node:os";

import { startTestServer, type TestServer } from "./harness.ts";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { MEMBER_USER_COMMAND_PATH } from "../member-os-user-view.ts";
import {
  handleMemberUserAdmin,
  type MemberUserAdminDeps,
  setMemberUserAdminDeps,
} from "../member-user-admin.ts";
import type { MemberOsUserWire } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// No OS user names taken: a test reads no passwd of this box.
const CONTAINER_DEPS: Partial<MemberUserAdminDeps> = {
  support: { ok: true, shape: "container" },
  takenOsUserNames: async () => [],
};
beforeAll(() => {
  setMemberUserAdminDeps(CONTAINER_DEPS);
});
afterAll(() => {
  setMemberUserAdminDeps(null);
});

type Auth = { bearer?: string; rawSessionId?: string };

async function get(
  srv: TestServer,
  username: string,
  auth: Auth,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  const res = await srv.http(
    `/api/users/${encodeURIComponent(username)}/os-user`,
    { method: "GET", headers, rawSessionId: auth.rawSessionId },
  );
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// A display name with every shell-special character a name may hold.
const ODD_NAME = "Eve O'Neil --user root .";

async function office() {
  server = await startTestServer();
  const srv = server;
  const owner = await srv.seedOwner("Morgan");
  const mia = await srv.seedMember("Mia");
  const eve = await srv.seedMember(ODD_NAME);
  const id = (name: string) => getUserByName(name)!.id;
  const [room] = srv.agentManager.getRooms();
  const token = async (userId: string, rooms?: string[]) =>
    (
      await mintApiToken({
        userId,
        name: `t-${userId}-${rooms ? "rooms" : "all"}`,
        expiresInDays: null,
        ...(rooms ? { limits: { rooms } } : {}),
      })
    ).token;
  return {
    srv,
    ids: { owner: id(owner.username), mia: id("Mia"), eve: id(eve.username) },
    eveName: eve.username,
    ownerName: owner.username,
    callers: {
      ownerSession: { rawSessionId: owner.rawSessionId },
      ownerPrivilegedAgent: {
        bearer: mintAgentToken("os-owner-priv", id(owner.username), true),
      },
      ownerApiToken: { bearer: await token(id(owner.username)) },
      ownerPlainAgent: {
        bearer: mintAgentToken("os-owner-plain", id(owner.username), false),
      },
      ownerRoomToken: { bearer: await token(id(owner.username), [room.id]) },
      memberSession: { rawSessionId: mia.rawSessionId },
      memberPrivilegedAgent: {
        bearer: mintAgentToken("os-mia-priv", id("Mia"), true),
      },
    } satisfies Record<string, Auth>,
  };
}

describe("GET /api/users/:username/os-user", () => {
  it("answers an office owner's reach only", async () => {
    const o = await office();
    const out: Record<string, number> = {};
    for (const [who, auth] of Object.entries(o.callers))
      out[who] = (await get(o.srv, "Mia", auth)).status;
    expect(out).toEqual({
      ownerSession: 200,
      ownerPrivilegedAgent: 200,
      ownerApiToken: 200,
      ownerPlainAgent: 403,
      ownerRoomToken: 403,
      memberSession: 403,
      memberPrivilegedAgent: 403,
    });
    // A member reads not even their own.
    expect((await get(o.srv, "Mia", o.callers.memberSession)).status).toBe(403);
    expect((await get(o.srv, "Nobody", o.callers.ownerSession)).status).toBe(
      404,
    );
  });

  it("gives the state, the gate and the commands, and nothing else of the member", async () => {
    const o = await office();
    const r = await get(o.srv, "Mia", o.callers.ownerSession);
    expect(r.status).toBe(200);
    const view = r.body as MemberOsUserWire;
    expect(view.support).toEqual({ ok: true });
    expect(view.state).toBe("off");
    expect(view.run).toBeNull();
    // officeOsUser is the office's OS user, not the member's (task 83ebaa3c).
    // newUserName is the default new user's name (task e15a82e7): the
    // member's own name while it is free (task 3b5234dc).
    expect(Object.keys(view).sort()).toEqual(
      [
        "commands",
        "support",
        "run",
        "state",
        "officeOsUser",
        "newUserName",
      ].sort(),
    );
    expect(view.newUserName).toBe("mia");
    expect(view.officeOsUser).toBe(userInfo().username);
    expect(view.commands?.enable.endsWith(`enable ${o.ids.mia}`)).toBe(true);
    // Task 12c796b2: an owner may have an OS user: their commands, and the
    // owner flag for the page's note.
    const ownerView = await get(o.srv, o.ownerName, o.callers.ownerSession);
    const ownerWire = ownerView.body as MemberOsUserWire;
    expect(ownerWire.commands?.enable.endsWith(`enable ${o.ids.owner}`)).toBe(
      true,
    );
    expect(ownerWire.owner).toBe(true);
    // Where the command cannot run: the reason, and no command.
    setMemberUserAdminDeps({ support: { ok: false, reason: "kubernetes" } });
    try {
      const refused = (await get(o.srv, "Mia", o.callers.ownerSession))
        .body as MemberOsUserWire;
      expect(refused.support).toEqual({ ok: false, reason: "kubernetes" });
      expect(refused.commands).toBeNull();
    } finally {
      setMemberUserAdminDeps(CONTAINER_DEPS);
    }
  });

  // Task 3b5234dc: a taken name gives the next free one, and the page and
  // the root command's default (info's userName, for a command line with no
  // --user) give the same name from the same names.
  it("gives the next free name while the member's name is taken, the same name the root command's default takes", async () => {
    const o = await office();
    const both = async (taken: string[] | null) => {
      setMemberUserAdminDeps({
        ...CONTAINER_DEPS,
        takenOsUserNames: async () => taken,
      });
      const view = (await get(o.srv, "Mia", o.callers.ownerSession))
        .body as MemberOsUserWire;
      const info = await handleMemberUserAdmin("/admin/member-user/info", {
        member: o.ids.mia,
      });
      const body = (await info.json()) as { userName?: unknown };
      return [view.newUserName, body.userName];
    };
    try {
      expect(await both(["mia"])).toEqual(["mia2", "mia2"]);
      expect(await both(["mia", "mia2"])).toEqual(["mia3", "mia3"]);
      expect(await both(["bob"])).toEqual(["mia", "mia"]);
      expect(await both(null)).toEqual(["mia", "mia"]);
    } finally {
      setMemberUserAdminDeps(CONTAINER_DEPS);
    }
  });

  it("builds the command from the member id only, whatever their name holds", async () => {
    const o = await office();
    // The enabling condition: her name holds the quote, spaces and dashes.
    expect(o.eveName).toBe(ODD_NAME);
    const r = await get(o.srv, o.eveName, o.callers.ownerSession);
    expect(r.status).toBe(200);
    const { commands } = r.body as MemberOsUserWire;
    expect(commands).not.toBeNull();
    for (const verb of ["enable", "disable"] as const) {
      const line = commands![verb];
      // The words after the container's prefix are fixed, then the id.
      expect(line.split(" ").slice(-3)).toEqual([
        MEMBER_USER_COMMAND_PATH,
        verb,
        o.ids.eve,
      ]);
      for (const piece of ["'", "Eve", "Neil", "--user", "root"])
        expect({ verb, piece, in: line.includes(piece) }).toEqual({
          verb,
          piece,
          in: false,
        });
    }
  });
});
