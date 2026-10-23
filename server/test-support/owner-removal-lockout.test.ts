// Demoting or deleting an owner must not leave the office with no owner who
// holds an active session: a signed-out owner gets back in only through a
// sign-in link another owner makes (task da7e8518). Session revoke and logout
// already keep that rule; these cases hold users.update and users.delete to it.
// Only a browser session holds user:self and user:admin, so the actor of a
// demote or delete is always a signed-in user: a delete strands the office
// only when the actor's own sign-out lands at the same time.
import { afterEach, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { createMember, getUserByName } from "../users.ts";
import {
  acceptInvite,
  INVITE_TTL_MS,
  mintInvite,
  validateSession,
} from "../auth.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// An owner record with no session.
function signedOutOwner(name: string): string {
  const created = createMember(name, { role: "owner" });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}

// A real sign-in (mint + accept) for an existing user; returns the cookie.
async function signIn(userId: string): Promise<string> {
  const mint = await mintInvite({
    userId,
    createdBy: null,
    ttlMs: INVITE_TTL_MS,
  });
  if (!mint.ok) throw new Error(mint.error);
  const acc = await acceptInvite(mint.rawToken, { userAgent: "test" });
  if (!acc.ok) throw new Error(acc.error);
  return acc.rawSessionId;
}

function demote(srv: TestServer, username: string, cookie: string) {
  return srv.http(`/api/users/${username}`, {
    method: "PATCH",
    rawSessionId: cookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "member" }),
  });
}

function remove(srv: TestServer, username: string, cookie: string) {
  return srv.http(`/api/users/${username}`, {
    method: "DELETE",
    rawSessionId: cookie,
  });
}

function signOut(srv: TestServer, cookie: string) {
  return srv.http("/auth/logout", { method: "POST", rawSessionId: cookie });
}

// A refusal is its status and its error code (a protocol value).
async function outcome(res: Response): Promise<[number, string | null]> {
  if (res.ok) return [res.status, null];
  const body = (await res.json()) as { error: { code: string } };
  return [res.status, body.error.code];
}

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(10);
  }
}

function ownerSignedIn(...cookies: string[]): boolean {
  return cookies.some((c) => validateSession(c)?.role === "owner");
}

it("an owner cannot demote themself while the only other owner is signed out; once that owner signs in, they can", async () => {
  const srv = (server = await startTestServer());
  const morgan = await srv.seedOwner("Morgan");
  const bellaId = signedOutOwner("Bella");

  expect(
    await outcome(await demote(srv, "Morgan", morgan.rawSessionId)),
  ).toEqual([409, "would_strand_office"]);
  expect(getUserByName("Morgan")?.role).toBe("owner");
  expect(validateSession(morgan.rawSessionId)?.role).toBe("owner");

  await signIn(bellaId);
  expect(
    await outcome(await demote(srv, "Morgan", morgan.rawSessionId)),
  ).toEqual([200, null]);
  expect(getUserByName("Morgan")?.role).toBe("member");
});

it("a signed-in owner can demote an owner who has no session", async () => {
  const srv = (server = await startTestServer());
  const morgan = await srv.seedOwner("Morgan");
  signedOutOwner("Bella");

  expect(
    await outcome(await demote(srv, "Bella", morgan.rawSessionId)),
  ).toEqual([200, null]);
  expect(getUserByName("Bella")?.role).toBe("member");
});

it("a signed-in owner can delete another signed-in owner", async () => {
  const srv = (server = await startTestServer());
  const morgan = await srv.seedOwner("Morgan");
  await signIn(signedOutOwner("Bella"));

  expect((await remove(srv, "Bella", morgan.rawSessionId)).ok).toBe(true);
  expect(getUserByName("Bella")).toBeUndefined();
});

it("a self-demote and the other owner's sign-out, sent together: exactly one goes through", async () => {
  const srv = (server = await startTestServer());
  const morgan = await srv.seedOwner("Morgan");
  const bella = await signIn(signedOutOwner("Bella"));

  const [signedOut, demoted] = await Promise.all([
    signOut(srv, bella),
    demote(srv, "Morgan", morgan.rawSessionId),
  ]);

  // The loser is refused by the lockout rule, whichever one it is.
  if (validateSession(bella) === null)
    expect(await outcome(demoted)).toEqual([409, "would_strand_office"]);
  else {
    expect(signedOut.status).toBe(409);
    expect(await outcome(demoted)).toEqual([200, null]);
  }
  expect(ownerSignedIn(morgan.rawSessionId, bella)).toBe(true);
});

it("an owner's sign-out while their delete of the only other signed-in owner is in flight: the sign-out goes through and the delete is refused", async () => {
  // Every turn completes; a closed session's stream stays open until the
  // test ends it, which parks the delete in its agent transfer.
  const srv = (server = await startTestServer({
    fakeBackend: new FakeBackend({
      session: {
        onSend: (_t, _a, session) => session.completeTurn({ text: "ok" }),
        hangOnClose: true,
      },
    }),
  }));
  const morgan = await srv.seedOwner("Morgan");
  const morganId = getUserByName("Morgan")!.id;
  const bellaId = signedOutOwner("Bella");
  const bella = await signIn(bellaId);
  const agent = await srv.agentManager.spawn(
    "Worker",
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    "Bella",
    "claude",
    undefined,
    bellaId,
  );
  if (!agent) throw new Error("spawn failed");
  await srv.agentManager.sendMessage(agent.id, "hello", "tester");
  await waitUntil(
    () => srv.fakeBackend.sessionForAgent(agent.id)?.sent.length === 1,
    "a live session",
  );
  const live = srv.fakeBackend.sessionForAgent(agent.id)!;

  const removing = remove(srv, "Bella", morgan.rawSessionId);
  // The agent passes to Morgan before its session closes; the delete then
  // waits on the drain, with Bella's record still there.
  await waitUntil(
    () =>
      srv.agentManager.getAllAgents().find((a) => a.id === agent.id)?.userId ===
        morganId && live.closed,
    "the delete parked in the agent transfer",
  );
  expect(getUserByName("Bella")?.role).toBe("owner");
  // Bella is still an owner with a session, so the sign-out goes through.
  await signOut(srv, morgan.rawSessionId);
  expect(validateSession(morgan.rawSessionId)).toBeNull();
  live.endStream();

  expect(await outcome(await removing)).toEqual([409, "would_strand_office"]);
  expect(getUserByName("Bella")?.role).toBe("owner");
  expect(validateSession(bella)?.role).toBe("owner");
});
