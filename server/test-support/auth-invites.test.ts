// Auth core - invite lifecycle (tasks 5676b6cb / 530680ae / ec1724a8).
//
// The auth module was shipped on manual smoke tests; this file is the
// automated catalog for the INVITE half of server/auth.ts. It drives the real
// mint/peek/accept functions in-process (no HTTP round-trip) against the
// harness's temp STATE_ROOT, so every assertion runs the production code path.
//
// What this freezes:
//   - A sign-in link targets an EXISTING member by id: mint refuses an unknown
//     id, accept never creates a member, a rename between mint and accept is
//     harmless, and a deleted member's link signs nobody in.
//   - The stamped expiry is exactly the caller's window (the seam picks it;
//     no client wire carries it).
//   - Every mint replaces the member's OUTSTANDING links (by id) and nothing
//     else - a consumed row, an expired row, and another user's row all survive.
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
import { mintMemberLink } from "./member-link.ts";

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
  const m = await mintInvite({ userId: idOf(name), createdBy: "Boss", ttlMs });
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

describe("auth/invites: expiry window", () => {
  it("stamps exactly the caller's window: 24h, the 1h self-invite, 15min", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    await server.seedMember("Alice");
    await server.seedMember("Bob");
    await server.seedMember("Carol");

    const before = Date.now();
    const standard = await mintOk("Alice", INVITE_TTL_MS);
    const selfInvite = await mintOk("Bob", SELF_INVITE_TTL_MS);
    const ownerLogin = await mintOk("Carol", 15 * 60 * 1000);
    const after = Date.now();

    // Window rather than an exact equality: expiresAt is stamped from a
    // Date.now() taken inside the mutex, somewhere in [before, after].
    for (const [minted, ttl] of [
      [standard, INVITE_TTL_MS],
      [selfInvite, SELF_INVITE_TTL_MS],
      [ownerLogin, 15 * 60 * 1000],
    ] as const) {
      expect(minted.expiresAt - after).toBeLessThanOrEqual(ttl);
      expect(minted.expiresAt - before).toBeGreaterThanOrEqual(ttl);
    }
    expect(SELF_INVITE_TTL_MS).toBe(60 * 60 * 1000);
    expect(INVITE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("an already-expired link is refused by BOTH peek and accept, and the member stays", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");

    const stale = await mintMemberLink("Ghost", "member", -1000);

    expect(peekInvite(stale.rawToken)).toEqual({ error: "expired" });
    const acc = await acceptInvite(stale.rawToken, { userAgent: "test" });
    expect(acc).toEqual({ ok: false, error: "expired" });
    // The member and their profile outlive the link (task ec1724a8).
    expect(getUserByName("Ghost")?.pendingSignIn).toBe(true);
    // Expired rows drop out of the outstanding list.
    expect(outstandingPrefixes()).not.toContain(stale.tokenPrefix);
  });
});

describe("auth/invites: a mint replaces the member's outstanding links", () => {
  it("replaces only the same member's OUTSTANDING links - consumed, expired and foreign rows survive", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
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

    // The consumed and expired rows were never candidates for replacement, so
    // they must still be REDEEMABLE-STATE-wise what they were: consumed stays
    // consumed (not deleted-and-forgotten), expired stays expired.
    expect(peekInvite(aliceConsumed.rawToken)).toEqual({ error: "consumed" });
    expect(peekInvite(aliceExpired.rawToken)).toEqual({ error: "expired" });
    // And the displaced ones are genuinely gone, not merely hidden from the list.
    expect(peekInvite(aliceOutstanding.rawToken)).toEqual({
      error: "not_found",
    });
  });
});

describe("auth/invites: a link targets an existing member", () => {
  it("mint refuses an unknown member id and stores nothing", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");

    const r = await mintInvite({
      userId: "deadbeef",
      createdBy: "Boss",
      ttlMs: INVITE_TTL_MS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("USER_NOT_FOUND");
    expect(listInvites()).toEqual([]);
  });

  it("a rename between mint and accept signs in the renamed member and creates no one", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
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
    await server.seedOwner("Boss");
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
    await server.seedOwner("Boss");
    await server.seedMember("Alice");
    await server.seedMember("Bob");
    const alice = await mintOk("Alice");
    const bob = await mintOk("Bob");

    expect(await revokeInvitesForUser(getUserByName("Alice")!)).toBe(1);
    expect(peekInvite(alice.rawToken)).toEqual({ error: "not_found" });
    expect(peekInvite(bob.rawToken)).not.toHaveProperty("error");
  });
});

// Sign-in links minted before StoredInvite.userId (recovery, self-invite,
// owner-login) carry only a username. invites.json is planted on disk and the
// server restarted, so the real boot load does the binding.
describe("auth/invites: legacy name-bound links bind to ids at boot", () => {
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

  it("a rename chain after boot keeps the link on its member: Marc -> Marco, then another member -> Marc", async () => {
    let srv = (server = await startTestServer());
    await srv.seedOwner("Boss");
    await srv.seedMember("Marc");
    await srv.seedMember("Alice");
    const token = plantLegacyLink(srv.stateRoot, "marc");
    srv = server = await srv.restart();
    const marcId = idOf("Marc");

    updateUserById(marcId, { name: "Marco" });
    updateUserById(idOf("Alice"), { name: "Marc" });

    expect(peekInvite(token)).toMatchObject({ username: "Marco" });
    const acc = await acceptInvite(token, { userAgent: "test" });
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    expect(acc.username).toBe("Marco");
    expect(validateSession(acc.rawSessionId)?.userId).toBe(marcId);
  });

  it("the binding persists across restarts; a name with no member is dropped and stays refused", async () => {
    let srv = (server = await startTestServer());
    await srv.seedOwner("Boss");
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
    await srv.seedOwner("Boss");
    await srv.seedMember("Marc");
    await srv.seedMember("Alice");
    const marcId = idOf("Marc");
    const raw = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(raw).digest("hex");
    const file = join(srv.stateRoot, "invites.json");
    const rows = JSON.parse(readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    rows[tokenHash] = {
      tokenHash,
      tokenPrefix: raw.slice(0, 8),
      username: "Marc",
      role: "member",
      createdBy: "Marc",
      createdAt: Date.now(),
      expiresAt: Date.now() + INVITE_TTL_MS,
      consumed: false,
      consumedAt: null,
      bootstrap: false,
    };
    writeFileSync(file, JSON.stringify(rows, null, 2));
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
    updateUserById(marcId, { name: "Marco" });
    updateUserById(idOf("Alice"), { name: "Marc" });
    srv = server = await srv.restart();
    const acc = await acceptInvite(raw, { userAgent: "test" });
    expect(acc.ok && validateSession(acc.rawSessionId)?.userId).toBe(marcId);
  });
});

describe("auth/invites: peek never consumes", () => {
  it("two peeks then an accept still succeeds; the accept is what flips it consumed", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
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

describe("auth/invites: accept happy path + refusal matrix", () => {
  it("accept signs the existing member in, ends their pending state, and consumes the link", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const inv = await mintMemberLink("Newbie");
    expect(getUserByName("Newbie")?.pendingSignIn).toBe(true);

    const acc = await acceptInvite(inv.rawToken, { userAgent: "ua/1" });
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;

    expect(acc.username).toBe("Newbie");
    expect(acc.role).toBe("member");
    expect(acc.isBootstrap).toBe(false);
    expect(acc.inviteNeedsName).toBe(false);
    expect(acc.rawSessionId.length).toBeGreaterThan(20);
    expect(acc.absoluteExpiresAt).toBeGreaterThan(acc.expiresAt);

    const rec = getUserByName("Newbie");
    expect(rec?.id).toBe(inv.userId);
    expect(rec?.role).toBe("member");
    expect(rec?.pendingSignIn).toBeUndefined();
    // Invite burnt.
    expect(peekInvite(inv.rawToken)).toEqual({ error: "consumed" });
    const replay = await acceptInvite(inv.rawToken, { userAgent: "ua/1" });
    expect(replay).toEqual({ ok: false, error: "consumed" });
  });

  it("role_mismatch: the record's role changed between mint and accept", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
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
    await server.seedOwner("Boss");
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
      chosenName: "Boss",
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
