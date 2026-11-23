// Auth core - invite lifecycle (tasks 5676b6cb / 530680ae / ec1724a8).
//
// The automated catalog for the INVITE half of server/auth.ts. It drives the
// real mint/peek/accept functions in-process (no HTTP round-trip) against the
// harness's temp STATE_ROOT, so every assertion runs the production code path.
// The route-level half (mint by userId, the 3-day and 1h windows, 404 for an
// unknown member, accept over HTTP) lives in routes-invites-rest,
// invite-onboarding and invite-consumed-ux.
//
// What this freezes:
//   - A sign-in link targets an EXISTING member by id: accept never creates a
//     member, a rename between mint and accept is harmless, and a deleted
//     member's link signs nobody in.
//   - Every mint replaces the member's unconsumed links (by id), live or
//     expired (task 1492af52: a replaced link can never be extended again), and
//     nothing else - a consumed row and another user's row survive.
//   - Legacy name-bound links bind to the member's id when the server boots,
//     persist that, and drop a name with no member; renames and name reuse
//     after boot cannot redirect them.
//   - peekInvite NEVER consumes (link unfurlers / prefetch must not burn a
//     one-time bearer token), and reports consumed/expired/not_found/owner_exists.
//   - acceptInvite's refusal matrix, including the two that only exist for
//     between-mint-and-accept races: role_mismatch and owner_exists.
//   - CONCURRENT acceptance of one token: the mutex lets exactly one win.
//   - Legacy bootstrap rows: the invitee names themselves, lands as owner, and
//     sibling bootstrap invites are SWEPT the moment an owner exists.
//
// Seam: startTestServer() for a clean STATE_ROOT + reset auth/users caches.
// Zero LLM.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { createHash, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  mintInvite,
  acceptInvite,
  peekInvite,
  listInvites,
  revokeInvitesForUser,
  revokeInviteByPrefix,
  extendInvite,
  expiredInviteRenewal,
  _testMintLegacyInvite,
  INVITE_TTL_MS,
  SELF_INVITE_TTL_MS,
  loadAuthState,
  validateSession,
} from "../auth.ts";
import * as persistence from "../persistence.ts";
import {
  deleteUserById,
  getUserByName,
  hasOwner,
  listUsers,
  setUserRole,
  updateUserById,
} from "../users.ts";
import { inThePast, mintExpiredLink, mintMemberLink } from "./member-link.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

function idOf(name: string): string {
  const u = getUserByName(name);
  if (!u) throw new Error(`no user record for ${name}`);
  return u.id;
}

// Mint and unwrap, failing loudly on the error arm so a broken mint surfaces as
// itself rather than as a confusing downstream assertion.
async function mintOk(
  name: string,
  ttlMs: number = INVITE_TTL_MS,
): Promise<{ rawToken: string; prefix: string; expiresAt: number }> {
  const m = await mintInvite({
    userId: idOf(name),
    createdBy: "Morgan",
    ttlMs,
  });
  if (!m.ok) throw new Error(`mint failed: ${m.code} ${m.error}`);
  return {
    rawToken: m.rawToken,
    prefix: m.invite.tokenPrefix,
    expiresAt: m.invite.expiresAt,
  };
}

function outstandingPrefixes(): string[] {
  return listInvites().map((i) => i.tokenPrefix);
}

describe("auth/invites: an expired link", () => {
  it("an already-expired link is refused by BOTH peek and accept, and the member stays", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");

    const stale = await mintExpiredLink("Ghost");

    expect(peekInvite(stale.rawToken)).toEqual({ error: "expired" });
    const acc = await acceptInvite(stale.rawToken, { userAgent: "test" });
    expect(acc).toEqual({ ok: false, error: "expired" });
    // The member and their profile outlive the link (task ec1724a8).
    expect(getUserByName("Ghost")?.pendingSignIn).toBe(true);
    // An owner can still extend it (task 1492af52), so the owner list keeps
    // it, marked expired.
    expect(
      listInvites().find((i) => i.tokenPrefix === stale.tokenPrefix)?.expired,
    ).toBe(true);
  });
});

describe("auth/invites: a mint replaces the member's unconsumed links", () => {
  it("replaces the same member's live AND expired links - consumed and foreign rows survive", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    await server.seedMember("Alice");
    await server.seedMember("Bob");

    // Pre-existing rows around Alice. Each mint replaces the previous
    // outstanding one, so the consumed and expired rows are minted first.
    const aliceConsumed = await mintOk("Alice");
    const consumeIt = await acceptInvite(aliceConsumed.rawToken, {
      userAgent: "test",
    });
    expect(consumeIt.ok).toBe(true);
    const aliceExpired = await mintOk("Alice", -1000);
    const aliceOutstanding = await mintOk("Alice");
    const bobOutstanding = await mintOk("Bob");

    const replacement = await mintOk("Alice");

    const outstanding = outstandingPrefixes();
    expect(outstanding).not.toContain(aliceOutstanding.prefix); // displaced
    expect(outstanding).toContain(replacement.prefix);
    expect(outstanding).toContain(bobOutstanding.prefix); // another user: untouched

    // The consumed row was never a candidate for replacement: it stays
    // consumed (not deleted-and-forgotten).
    expect(peekInvite(aliceConsumed.rawToken)).toEqual({ error: "consumed" });
    // The displaced ones - live and expired - are genuinely gone, not merely
    // hidden from the list (task 1492af52: an expired row left behind could be
    // extended back to life once the newer link is revoked).
    expect(peekInvite(aliceOutstanding.rawToken)).toEqual({
      error: "not_found",
    });
    expect(peekInvite(aliceExpired.rawToken)).toEqual({ error: "not_found" });
  });
});

describe("auth/invites: a link targets an existing member", () => {
  it("a rename between mint and accept signs in the renamed member and creates no one", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const { rawToken, userId } = await mintMemberLink("Marc");
    const usersBefore = listUsers().length;

    updateUserById(userId, { name: "Marc Garcia" });
    expect(peekInvite(rawToken)).toMatchObject({ username: "Marc Garcia" });
    expect(listInvites().map((i) => i.username)).toEqual(["Marc Garcia"]);

    const acc = await acceptInvite(rawToken, { userAgent: "test" });
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    expect(acc.username).toBe("Marc Garcia");
    expect(getUserByName("Marc")).toBeUndefined();
    expect(listUsers().length).toBe(usersBefore);
  });

  it("a deleted member's link signs nobody in, even after the name is reused", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const { rawToken, userId } = await mintMemberLink("Marc");

    deleteUserById(userId);
    expect(peekInvite(rawToken)).toEqual({ error: "not_found" });
    expect(await acceptInvite(rawToken, { userAgent: "test" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(getUserByName("Marc")).toBeUndefined();
    // A new member named Marc does not inherit the old link.
    await mintMemberLink("Marc");
    expect(peekInvite(rawToken)).toEqual({ error: "not_found" });
  });

  it("revokeInvitesForUser removes every unconsumed link of that member only", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    await server.seedMember("Alice");
    await server.seedMember("Bob");
    const alice = await mintOk("Alice");
    const bob = await mintOk("Bob");

    expect(await revokeInvitesForUser(getUserByName("Alice")!)).toBe(1);
    expect(peekInvite(alice.rawToken)).toEqual({ error: "not_found" });
    expect(peekInvite(bob.rawToken)).not.toHaveProperty("error");
  });
});

// A legacy sign-in link row as invites.json held it before StoredInvite.userId:
// bound to a username only. Returns the raw token.
function plantLegacyLink(stateRoot: string, username: string): string {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const file = join(stateRoot, "invites.json");
  const rows = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>)
    : {};
  const now = Date.now();
  rows[tokenHash] = {
    tokenHash,
    tokenPrefix: raw.slice(0, 8),
    username,
    role: "member",
    createdBy: username,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    consumed: false,
    consumedAt: null,
    bootstrap: false,
  };
  writeFileSync(file, JSON.stringify(rows, null, 2));
  return raw;
}

// Sign-in links minted before StoredInvite.userId (recovery, self-invite,
// owner-login) carry only a username. invites.json is planted on disk and the
// server restarted, so the real boot load does the binding.
describe("auth/invites: legacy name-bound links bind to ids at boot", () => {
  it("the binding persists across restarts; a name with no member is dropped and stays refused", async () => {
    let srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    await srv.seedMember("Marc");
    const token = plantLegacyLink(srv.stateRoot, "Marc");
    const orphan = plantLegacyLink(srv.stateRoot, "Ghost");
    srv = server = await srv.restart();
    const marcId = idOf("Marc");

    const onDisk = () =>
      Object.values(
        JSON.parse(
          readFileSync(join(srv.stateRoot, "invites.json"), "utf-8"),
        ) as Record<string, { username: string | null; userId?: string }>,
      );
    expect(onDisk().find((r) => r.username === "Marc")?.userId).toBe(marcId);
    expect(onDisk().some((r) => r.username === "Ghost")).toBe(false);

    // A member created later under the dropped name gets nothing from it.
    await mintMemberLink("Ghost");
    expect(peekInvite(orphan)).toEqual({ error: "not_found" });

    // The second boot reads the persisted id: a rename made before it is
    // harmless, and the link still signs in as Marc's id.
    updateUserById(marcId, { name: "Marco" });
    srv = server = await srv.restart();
    expect(peekInvite(token)).toMatchObject({ username: "Marco" });
    const acc = await acceptInvite(token, { userAgent: "test" });
    expect(acc.ok && validateSession(acc.rawSessionId)?.userId).toBe(marcId);
  });
});

// A binding that is not on disk would be redone by name on the next boot,
// after renames: the boot must stop instead, and a retry must save again.
describe("auth/invites: a failed binding save stops the boot", () => {
  it("refuses to boot, retries the save on every load, and binds to the right member once the save works", async () => {
    let srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    await srv.seedMember("Marc");
    await srv.seedMember("Alice");
    const marcId = idOf("Marc");
    // Bound by name, case-insensitively, at the next boot.
    const raw = plantLegacyLink(srv.stateRoot, "marc");
    const tokenHash = createHash("sha256").update(raw).digest("hex");
    const file = join(srv.stateRoot, "invites.json");
    const rowOnDisk = () =>
      (
        JSON.parse(readFileSync(file, "utf-8")) as Record<
          string,
          { userId?: string }
        >
      )[tokenHash];

    const realWrite = persistence.atomicWriteFileSync;
    let faults = 0;
    const spy = spyOn(persistence, "atomicWriteFileSync").mockImplementation(
      (path, data, mode) => {
        if (path === file) {
          faults++;
          throw new Error("injected invites.json write failure");
        }
        return realWrite(path, data, mode);
      },
    );
    try {
      const booted = await srv.restart().then(
        () => true,
        () => false,
      );
      expect(booted).toBe(false);
      expect(faults).toBe(1);
      // In-process retries cannot skip the save: each load re-binds and
      // writes again, and fails again.
      expect(() => loadAuthState()).toThrow();
      expect(() => loadAuthState()).toThrow();
      expect(faults).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(rowOnDisk().userId).toBeUndefined();

    srv = server = await srv.restart();
    expect(rowOnDisk().userId).toBe(marcId);
    // A rename chain after the binding cannot redirect the link: Marc ->
    // Marco, then another member takes the name Marc.
    updateUserById(marcId, { name: "Marco" });
    updateUserById(idOf("Alice"), { name: "Marc" });
    srv = server = await srv.restart();
    expect(peekInvite(raw)).toMatchObject({ username: "Marco" });
    const acc = await acceptInvite(raw, { userAgent: "test" });
    expect(acc.ok && validateSession(acc.rawSessionId)?.userId).toBe(marcId);
  });
});

describe("auth/invites: peek never consumes", () => {
  it("two peeks then an accept still succeeds; the accept is what flips it consumed", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const inv = await mintMemberLink("Newbie");

    const first = peekInvite(inv.rawToken);
    const second = peekInvite(inv.rawToken);
    expect(first).toEqual({
      firstSignIn: true,
      needsName: false,
      username: "Newbie",
      role: "member",
      bootstrap: false,
    });
    expect(second).toEqual(first);

    const acc = await acceptInvite(inv.rawToken, { userAgent: "test" });
    expect(acc.ok).toBe(true);
    expect(peekInvite(inv.rawToken)).toEqual({ error: "consumed" });
    // Unknown token reads as not_found, never as a different error that would
    // distinguish "never existed" from "existed once".
    expect(peekInvite("totally-made-up-token")).toEqual({ error: "not_found" });
  });
});

describe("auth/invites: accept refusal matrix", () => {
  it("role_mismatch: the record's role changed between mint and accept", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    await server.seedMember("Alice");

    // Minted while Alice is a member...
    const inv = await mintOk("Alice");
    // ...then she is promoted before the link is clicked.
    expect(setUserRole("Alice", "owner")).toBe(true);

    const acc = await acceptInvite(inv.rawToken, { userAgent: "test" });
    expect(acc).toEqual({ ok: false, error: "role_mismatch" });
    // The refusal must not have silently demoted her back to the invite's role.
    expect(getUserByName("Alice")?.role).toBe("owner");
    // ...and it must not have burnt the invite either (the accept never got
    // past the guard, so the link is still redeemable once the roles agree).
    expect(peekInvite(inv.rawToken)).not.toHaveProperty("error");
  });

  it("a null-username (legacy bootstrap) invite demands a valid chosen name", async () => {
    server = await startTestServer();
    // No owner yet - a bootstrap invite is only meaningful pre-claim.
    const inv = await _testMintLegacyInvite({
      username: null,
      role: "owner",
      bootstrap: true,
    });
    expect(peekInvite(inv.rawToken)).toEqual({
      needsName: true,
      username: null,
      role: "owner",
      bootstrap: true,
    });

    expect(await acceptInvite(inv.rawToken, { userAgent: "t" })).toEqual({
      ok: false,
      error: "needs_name",
    });
    expect(
      await acceptInvite(inv.rawToken, { userAgent: "t", chosenName: "   " }),
    ).toEqual({ ok: false, error: "needs_name" });
    expect(
      await acceptInvite(inv.rawToken, {
        userAgent: "t",
        chosenName: "x".repeat(65),
      }),
    ).toEqual({ ok: false, error: "invalid_name" });
    expect(
      await acceptInvite(inv.rawToken, {
        userAgent: "t",
        chosenName: "bad<script>",
      }),
    ).toEqual({ ok: false, error: "invalid_name" });

    // None of the refusals burnt the invite or created a user.
    expect(hasOwner()).toBe(false);
    const good = await acceptInvite(inv.rawToken, {
      userAgent: "t",
      chosenName: "Chosen Name",
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.username).toBe("Chosen Name");
    expect(good.role).toBe("owner");
    expect(good.isBootstrap).toBe(true);
    expect(getUserByName("Chosen Name")?.role).toBe("owner");
  });
});

describe("auth/invites: concurrent acceptance of one token", () => {
  it("exactly one of two simultaneous accepts wins; the loser sees consumed", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const inv = await mintMemberLink("Newbie");

    // Both calls are in flight before either resolves - the mutex, not call
    // ordering, is what serializes them.
    const [a, b] = await Promise.all([
      acceptInvite(inv.rawToken, { userAgent: "tab-a" }),
      acceptInvite(inv.rawToken, { userAgent: "tab-b" }),
    ]);

    const wins = [a, b].filter((r) => r.ok);
    const losses = [a, b].filter((r) => !r.ok);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
    expect(losses[0]).toEqual({ ok: false, error: "consumed" });

    // One winner means ONE session, not two.
    const winner = wins[0];
    if (!winner.ok) return;
    expect(winner.username).toBe("Newbie");
  });
});

describe("auth/invites: bootstrap invites go stale once an owner exists", () => {
  it("accept -> owner_exists, and every sibling bootstrap invite is swept in the same mutation", async () => {
    server = await startTestServer();

    // Three bootstrap invites minted pre-claim (the operator re-ran the
    // bootstrap printer a few times).
    const bootstrap = () =>
      _testMintLegacyInvite({ username: null, role: "owner", bootstrap: true });
    const a = await bootstrap();
    const b = await bootstrap();
    const c = await bootstrap();

    // The first one claims the office.
    const claimed = await acceptInvite(a.rawToken, {
      userAgent: "t",
      chosenName: "Morgan",
    });
    expect(claimed.ok).toBe(true);
    expect(hasOwner()).toBe(true);

    // Siblings are swept by that same accept - not merely refused later.
    expect(peekInvite(b.rawToken)).toEqual({ error: "consumed" });
    expect(peekInvite(c.rawToken)).toEqual({ error: "consumed" });
    expect(outstandingPrefixes()).not.toContain(b.invite.tokenPrefix);
    expect(outstandingPrefixes()).not.toContain(c.invite.tokenPrefix);

    // And a fresh bootstrap invite minted AFTER the claim is refused with
    // owner_exists (the mutex-held recheck), not honored as a second owner.
    const late = await bootstrap();
    expect(peekInvite(late.rawToken)).toEqual({ error: "owner_exists" });
    const acc = await acceptInvite(late.rawToken, {
      userAgent: "t",
      chosenName: "Impostor",
    });
    expect(acc).toEqual({ ok: false, error: "owner_exists" });
    expect(getUserByName("Impostor")).toBeUndefined();
  });
});

// Extending a sign-in link (task 1492af52). An owner gives a link another
// INVITE_TTL_MS, live or expired, and the SAME token signs in again: the guest
// reopens the email they already have. Only an owner-made link of an existing
// member that no newer link replaced can be extended; the owner list shows
// such a link even after it expired, and the expired-link page offers the
// renewal request only for it.

// A row as invites.json holds it today (bound to a userId), planted on disk so
// a restart loads it. Two rows of one member side by side only exist in files
// written before task 1492af52 (a mint then left expired rows behind).
function plantBoundLink(
  stateRoot: string,
  row: {
    userId: string;
    username: string;
    createdBy: string;
    createdAt: number;
    expiresAt: number;
    rawToken?: string;
  },
): { rawToken: string; prefix: string } {
  const raw = row.rawToken ?? randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const file = join(stateRoot, "invites.json");
  const rows = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>)
    : {};
  rows[tokenHash] = {
    tokenHash,
    tokenPrefix: raw.slice(0, 8),
    userId: row.userId,
    username: row.username,
    role: "member",
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumed: false,
    consumedAt: null,
    bootstrap: false,
  };
  writeFileSync(file, JSON.stringify(rows, null, 2));
  return { rawToken: raw, prefix: raw.slice(0, 8) };
}

function listed(prefix: string) {
  return listInvites().find((i) => i.tokenPrefix === prefix);
}

describe("auth/invites: extending a link (task 1492af52)", () => {
  it("an expired owner-made link is listed as expired and extendable, offers the renewal, and once extended the SAME token signs in", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const dan = await mintExpiredLink("Dan");
    expect(peekInvite(dan.rawToken)).toEqual({ error: "expired" });

    // The owner list keeps it, marked.
    const row = listed(dan.tokenPrefix);
    expect(row?.expired).toBe(true);
    expect(row?.extendable).toBe(true);
    // The expired-link page can offer the renewal request for it.
    expect(expiredInviteRenewal(dan.rawToken)).toEqual({
      tokenPrefix: dan.tokenPrefix,
      userId: dan.userId,
      memberName: "Dan",
      createdBy: "Morgan",
    });

    const before = Date.now();
    const r = await extendInvite(dan.tokenPrefix);
    const after = Date.now();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.invite.tokenPrefix).toBe(dan.tokenPrefix);
    expect(r.invite.expiresAt).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    expect(r.invite.expiresAt).toBeLessThanOrEqual(after + INVITE_TTL_MS);

    // Live again: no longer expired, still extendable, nothing to renew.
    expect(listed(dan.tokenPrefix)?.expired).toBeUndefined();
    expect(listed(dan.tokenPrefix)?.extendable).toBe(true);
    expect(expiredInviteRenewal(dan.rawToken)).toBeNull();

    // Persisted: a cold boot reads the new expiry, and the old token signs
    // in as Dan.
    server = await server.restart();
    expect(peekInvite(dan.rawToken)).not.toHaveProperty("error");
    const acc = await acceptInvite(dan.rawToken, { userAgent: "test" });
    expect(acc.ok && validateSession(acc.rawSessionId)?.userId).toBe(
      dan.userId,
    );
  });

  it("on a live link it sets the expiry to now + 3 days and never shortens it", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const userId = (await mintMemberLink("Dan")).userId;
    // An owner link with a minute left.
    const short = await inThePast(INVITE_TTL_MS - 60_000, () =>
      mintInvite({ userId, createdBy: "Morgan", ttlMs: INVITE_TTL_MS }),
    );
    if (!short.ok) throw new Error("mint failed");
    const before = Date.now();
    const r1 = await extendInvite(short.invite.tokenPrefix);
    expect(r1.ok && r1.invite.expiresAt).toBeGreaterThanOrEqual(
      before + INVITE_TTL_MS,
    );

    const long = await mintInvite({
      userId,
      createdBy: "Morgan",
      ttlMs: 2 * INVITE_TTL_MS,
    });
    if (!long.ok) throw new Error("mint failed");
    const r2 = await extendInvite(long.invite.tokenPrefix);
    expect(r2.ok && r2.invite.expiresAt).toBe(long.invite.expiresAt);
  });

  it("refuses a consumed, self-made, owner-login, bootstrap, legacy new-member or orphaned link, and none of them is offered or listed as extendable", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const outcomes: Record<string, unknown> = {};
    const renewals: Record<string, unknown> = {};
    const extendableRows: string[] = [];
    const check = async (label: string, rawToken: string, prefix: string) => {
      renewals[label] = expiredInviteRenewal(rawToken) !== null;
      if (listed(prefix)?.extendable) extendableRows.push(label);
      const r = await extendInvite(prefix);
      outcomes[label] = r.ok ? "ok" : r.error;
    };

    // Consumed: Ann accepted her link.
    const ann = await mintMemberLink("Ann");
    expect((await acceptInvite(ann.rawToken, { userAgent: "t" })).ok).toBe(
      true,
    );
    await check("consumed", ann.rawToken, ann.tokenPrefix);

    // Self-made (the member's own 1h link, createdBy = their name): live,
    // and run out after its real 1h window.
    const benId = (await mintMemberLink("Ben")).userId;
    const selfLive = await mintInvite({
      userId: benId,
      createdBy: "Ben",
      ttlMs: SELF_INVITE_TTL_MS,
    });
    if (!selfLive.ok) throw new Error("mint failed");
    await check("self live", selfLive.rawToken, selfLive.invite.tokenPrefix);
    const selfExpired = await mintExpiredLink("Ben", {
      createdBy: "Ben",
      ttlMs: SELF_INVITE_TTL_MS,
    });
    await check("self expired", selfExpired.rawToken, selfExpired.tokenPrefix);
    // A self-made link stays short-lived after the member is renamed.
    const fay = await mintExpiredLink("Fay", {
      createdBy: "Fay",
      ttlMs: SELF_INVITE_TTL_MS,
    });
    updateUserById(fay.userId, { name: "Fay Lee" });
    await check("self, member renamed", fay.rawToken, fay.tokenPrefix);
    // The box operator's 15-minute owner-login link (admin socket) keeps its
    // short life: nobody can stretch it to 3 days.
    const olga = await mintExpiredLink("Olga", {
      createdBy: "(admin-cli)",
      ttlMs: 15 * 60 * 1000,
      role: "owner",
    });
    await check("owner-login", olga.rawToken, olga.tokenPrefix);
    // Control: the operator's link for a member has the owner window and can
    // be extended.
    const gus = await mintExpiredLink("Gus", { createdBy: "(admin-cli)" });
    await check("operator member link", gus.rawToken, gus.tokenPrefix);

    // A legacy bootstrap row and a legacy new-member row, both run out after
    // the owner window.
    const boot = await inThePast(INVITE_TTL_MS + 1000, () =>
      _testMintLegacyInvite({
        username: null,
        role: "owner",
        bootstrap: true,
        createdBy: "Morgan",
      }),
    );
    await check("bootstrap", boot.rawToken, boot.invite.tokenPrefix);
    const legacyNew = await inThePast(INVITE_TTL_MS + 1000, () =>
      _testMintLegacyInvite({
        username: "Newcomer",
        role: "member",
        createdBy: "Morgan",
      }),
    );
    await check(
      "legacy new member",
      legacyNew.rawToken,
      legacyNew.invite.tokenPrefix,
    );

    // Orphaned: the member record is gone (deleted without the route's
    // revoke).
    const cal = await mintExpiredLink("Cal");
    deleteUserById(cal.userId);
    await check("member gone", cal.rawToken, cal.tokenPrefix);

    expect(outcomes).toEqual({
      consumed: "not_extendable",
      "self live": "not_extendable",
      "self expired": "not_extendable",
      "self, member renamed": "not_extendable",
      "owner-login": "not_extendable",
      "operator member link": "ok",
      bootstrap: "not_extendable",
      "legacy new member": "not_extendable",
      "member gone": "not_extendable",
    });
    expect(renewals).toEqual({
      consumed: false,
      "self live": false,
      "self expired": false,
      "self, member renamed": false,
      "owner-login": false,
      "operator member link": true,
      bootstrap: false,
      "legacy new member": false,
      "member gone": false,
    });
    expect(extendableRows).toEqual(["operator member link"]);
    // An expired row that cannot be extended is not on the owner list at all.
    expect(listed(selfExpired.tokenPrefix)).toBeUndefined();
    expect(listed(olga.tokenPrefix)).toBeUndefined();
    expect(listed(cal.tokenPrefix)).toBeUndefined();
    // Nothing above changed a row: each refusal left it as it was.
    expect(peekInvite(selfExpired.rawToken)).toEqual({ error: "expired" });
    expect(peekInvite(ann.rawToken)).toEqual({ error: "consumed" });
  });

  it("an unknown prefix is not_found and a prefix two rows share is ambiguous", async () => {
    let srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const dan = await mintExpiredLink("Dan");
    const eve = await mintExpiredLink("Eve");
    // A second row whose token starts with Dan's 8-character prefix, for
    // another member.
    const twin = plantBoundLink(srv.stateRoot, {
      userId: eve.userId,
      username: "Eve",
      createdBy: "Morgan",
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1000,
      rawToken:
        dan.tokenPrefix + randomBytes(32).toString("base64url").slice(8),
    });
    expect(twin.prefix).toBe(dan.tokenPrefix);
    srv = server = await srv.restart();

    expect(await extendInvite("zzzzzzzz")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await extendInvite(dan.tokenPrefix)).toEqual({
      ok: false,
      error: "ambiguous",
    });
    expect(peekInvite(dan.rawToken)).toEqual({ error: "expired" });
  });

  it("a persist failure leaves the link expired, in memory and on disk", async () => {
    let srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const dan = await mintExpiredLink("Dan");
    const file = join(srv.stateRoot, "invites.json");
    const realWrite = persistence.atomicWriteFileSync;
    const spy = spyOn(persistence, "atomicWriteFileSync").mockImplementation(
      (path, data, mode) => {
        if (path === file)
          throw new Error("injected invites.json write failure");
        return realWrite(path, data, mode);
      },
    );
    let threw = false;
    try {
      await extendInvite(dan.tokenPrefix).catch(() => {
        threw = true;
      });
    } finally {
      spy.mockRestore();
    }
    expect(threw).toBe(true);
    expect(peekInvite(dan.rawToken)).toEqual({ error: "expired" });
    expect(listed(dan.tokenPrefix)?.expired).toBe(true);
    srv = server = await srv.restart();
    expect(peekInvite(dan.rawToken)).toEqual({ error: "expired" });
  });
});

describe("auth/invites: a replaced link is never extended again (task 1492af52)", () => {
  it("an owner mint and a self-mint each remove the member's expired link", async () => {
    server = await startTestServer();
    await server.seedOwner("Morgan");
    const old1 = await mintExpiredLink("Dan");
    const fresh = await mintMemberLink("Dan");
    expect(peekInvite(old1.rawToken)).toEqual({ error: "not_found" });
    expect(await extendInvite(old1.tokenPrefix)).toEqual({
      ok: false,
      error: "not_found",
    });
    // Revoking the newer link brings nothing back.
    expect(await revokeInviteByPrefix(fresh.tokenPrefix)).toBe("ok");
    expect(listInvites().filter((i) => i.username === "Dan")).toEqual([]);

    // The member's own link replaces an owner's expired one the same way.
    const old2 = await mintExpiredLink("Dan");
    const self = await mintInvite({
      userId: old2.userId,
      createdBy: "Dan",
      ttlMs: 60_000,
    });
    expect(self.ok).toBe(true);
    expect(peekInvite(old2.rawToken)).toEqual({ error: "not_found" });
    expect(expiredInviteRenewal(old2.rawToken)).toBeNull();
  });

  it("in a file with an older expired row beside a newer one, the older is replaced, and an owner revoke of the newer removes it too", async () => {
    let srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const { userId } = await mintMemberLink("Dan");
    // Clear the live link the helper minted, then plant the pre-1492af52 pair.
    await revokeInvitesForUser({ id: userId, name: "Dan" });
    const now = Date.now();
    const older = plantBoundLink(srv.stateRoot, {
      userId,
      username: "Dan",
      createdBy: "Morgan",
      createdAt: now - 5 * INVITE_TTL_MS,
      expiresAt: now - 4 * INVITE_TTL_MS,
    });
    const newer = plantBoundLink(srv.stateRoot, {
      userId,
      username: "Dan",
      createdBy: "Morgan",
      createdAt: now - 2 * INVITE_TTL_MS,
      expiresAt: now - INVITE_TTL_MS,
    });
    srv = server = await srv.restart();

    expect(await extendInvite(older.prefix)).toEqual({
      ok: false,
      error: "replaced",
    });
    expect(expiredInviteRenewal(older.rawToken)).toBeNull();
    expect(listed(older.prefix)).toBeUndefined();
    expect(listed(newer.prefix)?.extendable).toBe(true);
    expect(expiredInviteRenewal(newer.rawToken)?.tokenPrefix).toBe(
      newer.prefix,
    );

    // The owner revokes the newer link: the older one must not become the
    // member's newest link and come back.
    expect(await revokeInviteByPrefix(newer.prefix)).toBe("ok");
    expect(peekInvite(older.rawToken)).toEqual({ error: "not_found" });
    expect(await extendInvite(older.prefix)).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});
