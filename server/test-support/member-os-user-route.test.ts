// GET /api/users/:username/os-user (task b94dfd25 4c-i): the owner's view of
// a member's own OS user, through the real server. The properties:
// - only an office owner's reach reads it (the owner, their privileged agent,
//   their API token); a room-limited token, a plain agent and a member get
//   403; an unknown member is 404 to an owner;
// - the gate goes through as is (closed until 4c-ii), and nothing else of
//   the member's record does;
// - the command holds the member id only: a member named with a quote,
//   spaces and dashes changes no word of it; an owner gets no command.
//
// Seam: startTestServer() - real auth, executor and guards. The shape is the
// container (ISOMUX_APP_SUPERVISOR), so the commands are set on any box.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { startTestServer, type TestServer } from "./harness.ts";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { MEMBER_USER_COMMAND_PATH } from "../member-os-user-view.ts";
import type { MemberOsUserWire } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const savedSupervisor = process.env.ISOMUX_APP_SUPERVISOR;
beforeAll(() => {
  process.env.ISOMUX_APP_SUPERVISOR = "container";
});
afterAll(() => {
  if (savedSupervisor === undefined) delete process.env.ISOMUX_APP_SUPERVISOR;
  else process.env.ISOMUX_APP_SUPERVISOR = savedSupervisor;
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
    // Closed until the product slice opens it.
    expect(view.gate).toBe(false);
    expect(view.state).toBe("off");
    expect(view.run).toBeNull();
    expect(Object.keys(view).sort()).toEqual(
      ["commands", "gate", "run", "state"].sort(),
    );
    expect(view.commands?.enable.endsWith(`enable ${o.ids.mia}`)).toBe(true);
    // An owner never gets an OS user: no command.
    const ownerView = await get(o.srv, o.ownerName, o.callers.ownerSession);
    expect((ownerView.body as MemberOsUserWire).commands).toBeNull();
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
