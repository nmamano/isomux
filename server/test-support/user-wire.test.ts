// Phase 3b slice 5 — user-wire projection leak closure (the Isomuxer3-gated
// leak). Asserted at the WIRE:
//   - the all-audience user_updated / users_list carry UserPublicWire ONLY (no
//     grants / env / prompt / view-prefs);
//   - owners get the FULL record via the owners-audience users_admin_list /
//     user_admin_updated; members NEVER receive those;
//   - the subject gets their OWN full record via user_self_updated, incl. at
//     connect hydration; another user never receives it;
//   - office envFile never reaches a member (full_state.office or the all-
//     audience office_settings_updated); owners keep it in their full_state.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName } from "../users.ts";
import type { OfficeWire } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Msg = Record<string, unknown>;
const bag = (s: TestSocket): Msg[] => s.messages as Msg[];

// Fields that must NEVER appear on a PUBLIC user wire.
const SENSITIVE = [
  "allowedRooms",
  "hidden",
  "order",
  "notifRooms",
  "defaultRoomId",
  "envFile",
  "memberPrompt",
] as const;

let reqSeq = 0;
const nextReqId = () => `uw-${++reqSeq}`;

// Connect + block until the WHOLE handshake arrived (presence_list is last).
async function connectSettled(
  srv: TestServer,
  raw: string,
): Promise<TestSocket> {
  const s = await srv.connectWs(raw);
  await s.waitFor("presence_list");
  return s;
}

const latest = (s: TestSocket, type: string): Msg | undefined => {
  let last: Msg | undefined;
  for (const m of bag(s)) if (m.type === type) last = m;
  return last;
};

async function waitForWhere(
  s: TestSocket,
  pred: (m: Msg) => boolean,
  timeoutMs = 2000,
): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = bag(s).find(pred);
    if (m) return m;
    if (Date.now() > deadline) throw new Error("waitForWhere timed out");
    await sleep(5);
  }
}

async function pingPong(s: TestSocket): Promise<void> {
  const before = bag(s).filter((m) => m.type === "pong").length;
  s.send({ type: "ping" });
  const deadline = Date.now() + 2000;
  while (bag(s).filter((m) => m.type === "pong").length <= before) {
    if (Date.now() > deadline) throw new Error("pingPong timed out");
    await sleep(5);
  }
}

function expectPublicOnly(user: Msg): void {
  for (const f of SENSITIVE) expect(user[f]).toBeUndefined();
  expect(typeof user.id).toBe("string");
  expect(typeof user.name).toBe("string");
  expect(typeof user.role).toBe("string");
}

async function ownerUpdateUser(
  ownerSock: TestSocket,
  username: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const requestId = nextReqId();
  ownerSock.send({ type: "update_user", requestId, username, changes });
  await waitForWhere(
    ownerSock,
    (m) => m.type === "settings_save_response" && m.requestId === requestId,
  );
}

describe("user-wire projection leak closure (3b.5)", () => {
  it("a member receives UserPublicWire only on users_list, their OWN full record via self, and NO admin events", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    await server.seedMember("Bob");

    const miaSock = await connectSettled(server, mia.rawSessionId);

    // users_list: every entry (incl the owner + Bob) is public-only.
    const usersList = latest(miaSock, "users_list")!;
    const users = usersList.users as Msg[];
    expect(users.length).toBeGreaterThanOrEqual(3);
    for (const u of users) expectPublicOnly(u);

    // Own full record arrived via user_self_updated (carries her grants/view).
    const self = latest(miaSock, "user_self_updated")!;
    const selfUser = self.user as Msg;
    expect(selfUser.id).toBe(getUserByName(mia.username)!.id);
    expect(Array.isArray(selfUser.allowedRooms)).toBe(true); // full record

    // A member NEVER receives the owners-audience admin events.
    expect(bag(miaSock).some((m) => m.type === "users_admin_list")).toBe(false);
    expect(bag(miaSock).some((m) => m.type === "user_admin_updated")).toBe(
      false,
    );
  });

  it("an owner receives the full admin roster + their own self record; users_list still public", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);

    const adminList = latest(ownerSock, "users_admin_list")!;
    const admins = adminList.users as Msg[];
    expect(admins.length).toBeGreaterThanOrEqual(2);
    for (const u of admins) expect(Array.isArray(u.allowedRooms)).toBe(true); // full

    // The all-audience users_list the owner ALSO gets is public-only.
    for (const u of latest(ownerSock, "users_list")!.users as Msg[]) {
      expectPublicOnly(u);
    }
    // Owner's own self record.
    expect((latest(ownerSock, "user_self_updated")!.user as Msg).id).toBe(
      getUserByName(owner.username)!.id,
    );
  });

  it("a grant change fans out self(full) to the subject, admin(full) to owners, public-only to other members", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    const bob = await server.seedMember("Bob");
    const r1 = server.agentManager.getRooms()[0].id;

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    const miaSock = await connectSettled(server, mia.rawSessionId);
    const bobSock = await connectSettled(server, bob.rawSessionId);

    await ownerUpdateUser(ownerSock, mia.username, { allowedRooms: [r1] });

    // Subject (Mia): self carries the NEW grants; the public user_updated does not.
    const miaSelf = await waitForWhere(
      miaSock,
      (m) =>
        m.type === "user_self_updated" &&
        ((m.user as Msg).allowedRooms as string[] | undefined)?.includes(r1) ===
          true,
    );
    expect((miaSelf.user as Msg).allowedRooms).toEqual([r1]);
    const miaPublic = latest(miaSock, "user_updated")!;
    expectPublicOnly(miaPublic.user as Msg);

    // Owner: admin event carries Mia's full record incl the grant.
    const ownerAdmin = await waitForWhere(
      ownerSock,
      (m) =>
        m.type === "user_admin_updated" &&
        (m.user as Msg).id === getUserByName(mia.username)!.id,
    );
    expect((ownerAdmin.user as Msg).allowedRooms).toEqual([r1]);

    // Other member (Bob): public user_updated only — NEVER admin or self for Mia.
    await pingPong(bobSock);
    expect(bag(bobSock).some((m) => m.type === "user_admin_updated")).toBe(
      false,
    );
    const bobSelfForMia = bag(bobSock).filter(
      (m) =>
        m.type === "user_self_updated" &&
        (m.user as Msg).id === getUserByName(mia.username)!.id,
    );
    expect(bobSelfForMia).toHaveLength(0);
  });

  it("office envFile is stripped for members (full_state.office + office_settings_updated) and kept for owners", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    // Seed an office envFile directly (officeState stores it without validation).
    server.agentManager.setOfficeSettings("op", "/seed/env/path", "Acme");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    const miaSock = await connectSettled(server, mia.rawSessionId);

    const ownerOffice = latest(ownerSock, "full_state")!.office as OfficeWire;
    const miaOffice = latest(miaSock, "full_state")!.office as OfficeWire;
    expect(ownerOffice.envFile).toBe("/seed/env/path"); // owner keeps it
    expect(miaOffice.envFile).toBeUndefined(); // member never sees it
    expect(miaOffice.name).toBe("Acme"); // but does see the public fields

    // The all-audience office_settings_updated carries NO envFile (both
    // recipients). Driven via the manager core directly — the WS handler
    // validates the env path; the WIRE stripping is what's under test here.
    server.agentManager.setOfficeSettings("op2", "/seed/env/path", "Acme2");
    const ev = await waitForWhere(
      miaSock,
      (m) => m.type === "office_settings_updated",
    );
    expect(ev.envFile).toBeUndefined();
    expect(ev.name).toBe("Acme2");
    const ownerEv = await waitForWhere(
      ownerSock,
      (m) => m.type === "office_settings_updated",
    );
    expect(ownerEv.envFile).toBeUndefined(); // dropped even for owners on the all-event
  });

  it("connect hydration delivers the full self/admin records BEFORE full_state (the UI default-room + owner-roster reads depend on this order)", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    const idxOf = (s: TestSocket, type: string) =>
      bag(s).findIndex((m) => m.type === type);

    const miaSock = await connectSettled(server, mia.rawSessionId);
    expect(idxOf(miaSock, "user_self_updated")).toBeGreaterThanOrEqual(0);
    expect(idxOf(miaSock, "user_self_updated")).toBeLessThan(
      idxOf(miaSock, "full_state"),
    );

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    expect(idxOf(ownerSock, "users_admin_list")).toBeLessThan(
      idxOf(ownerSock, "full_state"),
    );
    expect(idxOf(ownerSock, "user_self_updated")).toBeLessThan(
      idxOf(ownerSock, "full_state"),
    );
  });
});
