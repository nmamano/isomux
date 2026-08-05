// Auth core - session lifetime, revocation, and the lockout invariant
// (tasks 5676b6cb / 530680ae).
//
// The invite half lives in auth-invites.test.ts; this file covers what happens
// to a session AFTER it exists. Everything runs in-process against the real
// auth module on the harness's temp STATE_ROOT.
//
// What this freezes:
//   - EXPIRY, both clocks: the rolling window and the absolute cap each
//     invalidate independently, and validation EVICTS the row rather than just
//     returning null (a session that reads as dead but stays in the map would
//     still be counted by the lockout arithmetic below).
//   - The rolling refresh is CLAMPED to the absolute cap - refreshing past it
//     would make the 1-year hard bound decorative.
//   - An orphaned session (user record gone) stops validating.
//   - Revoke / logout / evict all force-close the registered sockets, and the
//     socket is NOTIFIED (session_expired) before the close - the UI's reconnect
//     loop depends on that ordering.
//   - PREFIX AMBIGUITY: two rows sharing an 8-char display prefix refuse the
//     revoke instead of picking one. Exercised by planting a genuine collision
//     on disk and cold-reloading, since prefixes are random and can't be forced.
//   - LOCKOUT-CHECK ORDERING, the confidentiality-critical one: the scoped
//     session revoker runs the "would this strand the office" test only AFTER
//     confirming the row belongs to the caller. Hoisting it would turn the
//     refusal into an oracle telling any member which prefix is the last owner.
//
// Seam: startTestServer() + restart() for the on-disk collision cases. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { createHash, randomBytes } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  validateSession,
  revalidateByHash,
  listActiveSessions,
  listActiveSessionsForUserId,
  revokeSessionByPrefix,
  revokeInviteByPrefix,
  revokeActiveSessionByPrefixForUserId,
  revokeOutstandingInviteByPrefixForUsername,
  resolveSessionHashByPrefix,
  logoutBySessionHash,
  evictSessionsForUserId,
  countActiveOwnerSessions,
  wouldRevokeLeaveOfficeUnreachable,
  registerSocket,
  mintInvite,
  _testSetSessionExpiry,
} from "../auth.ts";
import {
  getUserByName,
  deleteUser,
  setUserRole,
  wouldDeleteLeaveNoOwner,
  countOwners,
} from "../users.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex");

function userIdOf(name: string): string {
  const u = getUserByName(name);
  if (!u) throw new Error(`no user record for ${name}`);
  return u.id;
}

// A minimal ClosableSocket double. auth.ts types `send` optional precisely so
// tests can register one of these without a real WebSocket.
function stubSocket() {
  const sent: string[] = [];
  let closed = false;
  // Records the send-count AT close time, so "notified before closed" is
  // asserted as an ordering fact rather than inferred from two counters.
  let sendsAtClose = -1;
  return {
    sent,
    get closed() {
      return closed;
    },
    get sendsAtClose() {
      return sendsAtClose;
    },
    send(data: string) {
      sent.push(data);
    },
    close() {
      sendsAtClose = sent.length;
      closed = true;
    },
  };
}

describe("auth/sessions: expiry invalidates and evicts", () => {
  it("a lapsed ROLLING window stops validating and drops the row", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    expect(validateSession(owner.rawSessionId)).not.toBeNull();
    expect(listActiveSessions().length).toBe(1);

    expect(
      _testSetSessionExpiry(owner.rawSessionId, { expiresAt: Date.now() - 1 }),
    ).toBe(true);

    expect(validateSession(owner.rawSessionId)).toBeNull();
    // Evicted, not merely filtered: a second validate finds nothing at all.
    expect(listActiveSessions().length).toBe(0);
    expect(validateSession(owner.rawSessionId)).toBeNull();
  });

  it("a lapsed ABSOLUTE cap stops validating even with the rolling window wide open", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");

    // Rolling window deliberately far in the future - only the absolute cap
    // has lapsed, so this fails only if the two clocks are checked together.
    expect(
      _testSetSessionExpiry(owner.rawSessionId, {
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        absoluteExpiresAt: Date.now() - 1,
      }),
    ).toBe(true);

    expect(validateSession(owner.rawSessionId)).toBeNull();
    expect(listActiveSessions().length).toBe(0);
  });

  it("the rolling refresh is clamped to the absolute cap, never past it", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const cap = Date.now() + 60 * 60 * 1000; // 1h left on the absolute cap

    // Rolling window nearly exhausted, absolute cap an hour out. An unclamped
    // refresh would push expiresAt 30 days out, past the cap.
    expect(
      _testSetSessionExpiry(owner.rawSessionId, {
        expiresAt: Date.now() + 1000,
        absoluteExpiresAt: cap,
      }),
    ).toBe(true);

    const lookup = validateSession(owner.rawSessionId);
    expect(lookup).not.toBeNull();
    expect(lookup?.needsRolling).toBe(true);

    const row = listActiveSessions()[0];
    expect(row.absoluteExpiresAt).toBe(cap);
    expect(row.expiresAt).toBe(cap); // clamped exactly to the cap
    expect(row.expiresAt).toBeLessThanOrEqual(row.absoluteExpiresAt);
  });

  it("a session whose user record vanished stops validating (orphan sweep)", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const alice = await server.seedMember("Alice");
    expect(validateSession(alice.rawSessionId)).not.toBeNull();

    // Remove the record WITHOUT going through the delete route (which evicts
    // proactively) - this is the stale-disk fallback branch in validateByHash.
    expect(deleteUser("Alice")).toBe(true);

    expect(validateSession(alice.rawSessionId)).toBeNull();
    expect(listActiveSessions().some((s) => s.username === "Alice")).toBe(
      false,
    );
  });
});

describe("auth/sessions: revoke / logout / evict force-close sockets", () => {
  it("revoke by prefix notifies the socket, THEN closes it, and the cookie stops working", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const alice = await server.seedMember("Alice");

    const lookup = validateSession(alice.rawSessionId);
    if (!lookup) throw new Error("alice session missing");
    const sock = stubSocket();
    registerSocket(lookup.sessionIdHash, sock);

    expect(await revokeSessionByPrefix(lookup.sessionPrefix)).toBe("ok");

    expect(sock.closed).toBe(true);
    expect(sock.sent).toEqual([JSON.stringify({ type: "session_expired" })]);
    // The notify must land BEFORE the close, or the UI's blind reconnect loop
    // hammers a 401 upgrade instead of routing to the login screen.
    expect(sock.sendsAtClose).toBe(1);

    // Cookie is dead on both validation paths.
    expect(validateSession(alice.rawSessionId)).toBeNull();
    expect(revalidateByHash(lookup.sessionIdHash)).toBeNull();
    // The owner's own session is untouched.
    expect(validateSession(owner.rawSessionId)).not.toBeNull();
  });

  it("logout by hash and evict-by-user each close their own sockets only", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const alice1 = await server.seedMember("Alice");

    // A second device for Alice: accept a self-invite as her.
    const m = await mintInvite({
      username: "Alice",
      role: "member",
      createdBy: "Alice",
      allowExisting: true,
      replacePriorForUsername: true,
    });
    if (!m.ok) throw new Error("mint failed");
    const { acceptInvite } = await import("../auth.ts");
    const acc = await acceptInvite(m.rawToken, { userAgent: "phone" });
    if (!acc.ok) throw new Error("accept failed");
    const alice2Raw = acc.rawSessionId;

    const l1 = validateSession(alice1.rawSessionId)!;
    const l2 = validateSession(alice2Raw)!;
    const lOwner = validateSession(owner.rawSessionId)!;
    const s1 = stubSocket();
    const s2 = stubSocket();
    const sOwner = stubSocket();
    registerSocket(l1.sessionIdHash, s1);
    registerSocket(l2.sessionIdHash, s2);
    registerSocket(lOwner.sessionIdHash, sOwner);
    expect(listActiveSessionsForUserId(userIdOf("Alice")).length).toBe(2);

    // logout closes exactly one device.
    expect(await logoutBySessionHash(l1.sessionIdHash)).toBe(true);
    expect(s1.closed).toBe(true);
    expect(s2.closed).toBe(false);
    expect(sOwner.closed).toBe(false);
    expect(validateSession(alice1.rawSessionId)).toBeNull();
    expect(validateSession(alice2Raw)).not.toBeNull();
    // Idempotent: logging the same hash out again is a no-op, not an error.
    expect(await logoutBySessionHash(l1.sessionIdHash)).toBe(false);

    // evict takes every remaining session for that user - and nobody else's.
    expect(await evictSessionsForUserId(userIdOf("Alice"))).toBe(1);
    expect(s2.closed).toBe(true);
    expect(s2.sent).toEqual([JSON.stringify({ type: "session_expired" })]);
    expect(sOwner.closed).toBe(false);
    expect(validateSession(alice2Raw)).toBeNull();
    expect(validateSession(owner.rawSessionId)).not.toBeNull();
  });
});

describe("auth/sessions: lockout-prevention arithmetic", () => {
  it("counts by RECORD role, so a promotion/demotion moves the last-owner line", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    await server.seedMember("Alice");

    const lOwner = validateSession(owner.rawSessionId)!;
    // Alice's session exists but is not owner-bearing.
    expect(listActiveSessions().length).toBe(2);
    expect(countActiveOwnerSessions()).toBe(1);
    expect(wouldRevokeLeaveOfficeUnreachable(lOwner.sessionIdHash)).toBe(true);
    expect(wouldRevokeLeaveOfficeUnreachable("no-such-hash")).toBe(false);

    // Promote Alice: her EXISTING session becomes owner-bearing, because the
    // role is read from the record at check time rather than frozen at accept.
    expect(setUserRole("Alice", "owner")).toBe(true);
    expect(countActiveOwnerSessions()).toBe(2);
    expect(wouldRevokeLeaveOfficeUnreachable(lOwner.sessionIdHash)).toBe(false);

    // Demote her again and Boss is back to being the only way in.
    expect(setUserRole("Alice", "member")).toBe(true);
    expect(countActiveOwnerSessions()).toBe(1);
    expect(wouldRevokeLeaveOfficeUnreachable(lOwner.sessionIdHash)).toBe(true);
  });

  it("an EXPIRED owner session is not counted as a rescue session", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const alice = await server.seedMember("Alice");
    expect(setUserRole("Alice", "owner")).toBe(true);
    const lOwner = validateSession(owner.rawSessionId)!;

    // Two live owner sessions: Boss's is not the last.
    expect(countActiveOwnerSessions()).toBe(2);
    expect(wouldRevokeLeaveOfficeUnreachable(lOwner.sessionIdHash)).toBe(false);

    // Lapse Alice's without revoking it - the row is still in the map, so a
    // count that ignored the clock would keep reporting two and let Boss
    // revoke the office's only usable way back in.
    expect(
      _testSetSessionExpiry(alice.rawSessionId, { expiresAt: Date.now() - 1 }),
    ).toBe(true);

    expect(countActiveOwnerSessions()).toBe(1);
    expect(wouldRevokeLeaveOfficeUnreachable(lOwner.sessionIdHash)).toBe(true);
  });

  it("wouldDeleteLeaveNoOwner guards the RECORD side of the same invariant", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    await server.seedMember("Alice");

    expect(countOwners()).toBe(1);
    expect(wouldDeleteLeaveNoOwner(userIdOf("Boss"))).toBe(true);
    expect(wouldDeleteLeaveNoOwner(userIdOf("Alice"))).toBe(false); // not an owner
    expect(wouldDeleteLeaveNoOwner("no-such-id")).toBe(false);

    expect(setUserRole("Alice", "owner")).toBe(true);
    expect(countOwners()).toBe(2);
    expect(wouldDeleteLeaveNoOwner(userIdOf("Boss"))).toBe(false);
  });
});

describe("auth/sessions: scoped revoke - lockout check runs AFTER the scope test", () => {
  it("a member probing the last owner's prefix gets the SAME answer as a prefix that never existed", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const alice = await server.seedMember("Alice");

    const lOwner = validateSession(owner.rawSessionId)!;
    const lAlice = validateSession(alice.rawSessionId)!;
    const aliceId = userIdOf("Alice");

    // Precondition that makes this test non-vacuous: the prefix Alice is about
    // to probe really IS the office's last owner session, so a lockout check
    // placed before the scope test WOULD fire on it.
    expect(countActiveOwnerSessions()).toBe(1);
    expect(wouldRevokeLeaveOfficeUnreachable(lOwner.sessionIdHash)).toBe(true);

    const probeForeign = await revokeActiveSessionByPrefixForUserId(
      lOwner.sessionPrefix,
      aliceId,
    );
    const probeNonexistent = await revokeActiveSessionByPrefixForUserId(
      "deadbeef",
      aliceId,
    );

    // The load-bearing assertion: identical, and specifically NOT the
    // would_strand_office answer that would identify the owner's row.
    expect(probeForeign).toBe("not_found");
    expect(probeForeign).toBe(probeNonexistent);
    // Nothing was revoked either.
    expect(validateSession(owner.rawSessionId)).not.toBeNull();

    // POSITIVE CONTROLS - the "not_found" above is the scope check, not a
    // blanket refusal:
    //   (a) the owner revoking their OWN last-owner session DOES get the
    //       lockout answer, proving the check exists and is reachable;
    expect(
      await revokeActiveSessionByPrefixForUserId(
        lOwner.sessionPrefix,
        userIdOf("Boss"),
      ),
    ).toBe("would_strand_office");
    //   (b) Alice can revoke her own session.
    expect(
      await revokeActiveSessionByPrefixForUserId(lAlice.sessionPrefix, aliceId),
    ).toBe("ok");
    expect(validateSession(alice.rawSessionId)).toBeNull();
  });

  it("the scoped INVITE revoker hides foreign rows behind not_found too", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    await server.seedMember("Alice");
    await server.seedMember("Bob");

    const m = await mintInvite({
      username: "Bob",
      role: "member",
      createdBy: "Bob",
      allowExisting: true,
      replacePriorForUsername: true,
    });
    if (!m.ok) throw new Error("mint failed");
    const bobPrefix = m.invite.tokenPrefix;

    // Alice cannot revoke Bob's invite, and cannot tell it apart from a
    // prefix that does not exist.
    expect(
      await revokeOutstandingInviteByPrefixForUsername(bobPrefix, "Alice"),
    ).toBe("not_found");
    expect(
      await revokeOutstandingInviteByPrefixForUsername("deadbeef", "Alice"),
    ).toBe("not_found");

    // POSITIVE CONTROL: Bob can, and the scope match is case-insensitive.
    expect(
      await revokeOutstandingInviteByPrefixForUsername(bobPrefix, "bob"),
    ).toBe("ok");
    expect(
      await revokeOutstandingInviteByPrefixForUsername(bobPrefix, "Bob"),
    ).toBe("not_found");
  });
});

describe("auth/sessions: 8-char prefix collisions refuse rather than guess", () => {
  // Prefixes are the first 8 chars of a random 256-bit token, so a collision
  // can't be produced by minting. These tests plant a genuine duplicate on disk
  // and cold-reload the auth module through the harness restart.
  it("two sessions sharing a prefix: every revoke path answers ambiguous", async () => {
    let srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const lOwner = validateSession(owner.rawSessionId)!;
    const sharedPrefix = lOwner.sessionPrefix;
    const ownerId = userIdOf("Boss");

    const file = join(srv.stateRoot, "sessions.json");
    const rows = JSON.parse(readFileSync(file, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const original = rows[lOwner.sessionIdHash];
    expect(original).toBeTruthy();
    // A second, independent session that happens to share the display prefix.
    const twinHash = hashOf(randomBytes(32).toString("base64url"));
    rows[twinHash] = {
      ...original,
      sessionIdHash: twinHash,
      sessionPrefix: sharedPrefix,
    };
    writeFileSync(file, JSON.stringify(rows, null, 2));

    srv = await srv.restart();
    server = srv;

    // Sanity: the reload really did produce two rows on one prefix.
    expect(
      listActiveSessions().filter((s) => s.sessionPrefix === sharedPrefix)
        .length,
    ).toBe(2);

    expect(resolveSessionHashByPrefix(sharedPrefix)).toBeNull();
    expect(await revokeSessionByPrefix(sharedPrefix)).toBe("ambiguous");
    // Ambiguity is decided at the prefix level, BEFORE the scope test, so even
    // the rightful owner is refused rather than served an arbitrary one.
    expect(
      await revokeActiveSessionByPrefixForUserId(sharedPrefix, ownerId),
    ).toBe("ambiguous");
    // Neither row was touched.
    expect(
      listActiveSessions().filter((s) => s.sessionPrefix === sharedPrefix)
        .length,
    ).toBe(2);
  });

  it("two invites sharing a prefix: both revoke paths answer ambiguous", async () => {
    let srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    await srv.seedMember("Alice");

    const m = await mintInvite({
      username: "Alice",
      role: "member",
      createdBy: "Alice",
      allowExisting: true,
      replacePriorForUsername: true,
    });
    if (!m.ok) throw new Error("mint failed");
    const sharedPrefix = m.invite.tokenPrefix;

    const file = join(srv.stateRoot, "invites.json");
    const rows = JSON.parse(readFileSync(file, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const original = rows[m.invite.tokenHash];
    expect(original).toBeTruthy();
    const twinHash = hashOf(randomBytes(32).toString("base64url"));
    rows[twinHash] = { ...original, tokenHash: twinHash };
    writeFileSync(file, JSON.stringify(rows, null, 2));

    srv = await srv.restart();
    server = srv;

    expect(await revokeInviteByPrefix(sharedPrefix)).toBe("ambiguous");
    expect(
      await revokeOutstandingInviteByPrefixForUsername(sharedPrefix, "Alice"),
    ).toBe("ambiguous");
  });
});
