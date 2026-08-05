// Auth core - invite lifecycle (tasks 5676b6cb / 530680ae).
//
// The auth module was shipped on manual smoke tests; this file is the
// automated catalog for the INVITE half of server/auth.ts. It drives the real
// mint/peek/accept functions in-process (no HTTP round-trip) against the
// harness's temp STATE_ROOT, so every assertion runs the production code path.
//
// What this freezes:
//   - TTL SELECTION, the whole precedence ladder: ttlMsOverride wins, else
//     replacePriorForUsername picks the tight 1h self-invite window, else the
//     standard 24h INVITE_TTL_MS. No client wire carries the override, so this
//     ladder is the only thing standing between "self-invite" and a 24x wider
//     bearer-URL exposure window.
//   - replacePriorForUsername: removes exactly the OUTSTANDING invites for the
//     same username (case-insensitively), and nothing else - a consumed row, an
//     expired row, and another user's row all survive.
//   - peekInvite NEVER consumes (link unfurlers / prefetch must not burn a
//     one-time bearer token), and reports consumed/expired/not_found/owner_exists.
//   - acceptInvite's refusal matrix, including the two that only exist for
//     between-mint-and-accept races: role_mismatch and owner_exists.
//   - CONCURRENT acceptance of one token: the mutex lets exactly one win.
//   - Bootstrap: the invitee names themselves, lands as owner, and sibling
//     bootstrap invites are SWEPT the moment an owner exists.
//
// Seam: startTestServer() for a clean STATE_ROOT + reset auth/users caches.
// Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  mintInvite,
  acceptInvite,
  peekInvite,
  listInvites,
  INVITE_TTL_MS,
} from "../auth.ts";
import { getUserByName, setUserRole, hasOwner } from "../users.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const HOUR_MS = 60 * 60 * 1000;

// Mint and unwrap, failing loudly on the error arm so a broken mint surfaces as
// itself rather than as a confusing downstream assertion.
async function mintOk(
  opts: Parameters<typeof mintInvite>[0],
): Promise<{ rawToken: string; prefix: string; expiresAt: number }> {
  const m = await mintInvite(opts);
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

describe("auth/invites: TTL selection ladder", () => {
  it("standard mint = 24h, self-invite (replacePrior) = 1h, ttlMsOverride beats both", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    await server.seedMember("Alice");

    const before = Date.now();
    const standard = await mintOk({
      username: "Newbie",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });
    const selfInvite = await mintOk({
      username: "Alice",
      role: "member",
      createdBy: "Alice",
      allowExisting: true,
      replacePriorForUsername: true,
    });
    // The admin-socket owner-login path: a 15min window, and the override must
    // win even though replacePriorForUsername is also set (owner-recovery mints
    // pass both, and picking the 1h self-invite TTL there would be wrong).
    const overridden = await mintOk({
      username: "Alice",
      role: "member",
      createdBy: null,
      allowExisting: true,
      replacePriorForUsername: true,
      ttlMsOverride: 15 * 60 * 1000,
    });
    const after = Date.now();

    // Window rather than an exact equality: expiresAt is stamped from a
    // Date.now() taken inside the mutex, somewhere in [before, after].
    const spans = (expiresAt: number) => ({
      atLeast: expiresAt - after,
      atMost: expiresAt - before,
    });
    const s = spans(standard.expiresAt);
    expect(s.atLeast).toBeLessThanOrEqual(INVITE_TTL_MS);
    expect(s.atMost).toBeGreaterThanOrEqual(INVITE_TTL_MS);

    const si = spans(selfInvite.expiresAt);
    expect(si.atLeast).toBeLessThanOrEqual(HOUR_MS);
    expect(si.atMost).toBeGreaterThanOrEqual(HOUR_MS);
    // The distinction is the point: a self-invite is not merely "shorter", it
    // is the 1h window specifically.
    expect(selfInvite.expiresAt).toBeLessThan(
      standard.expiresAt - 22 * HOUR_MS,
    );

    const ov = spans(overridden.expiresAt);
    expect(ov.atLeast).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(ov.atMost).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(overridden.expiresAt).toBeLessThan(selfInvite.expiresAt);
  });

  it("an already-expired invite (negative override) is refused by BOTH peek and accept", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");

    const stale = await mintOk({
      username: "Ghost",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
      ttlMsOverride: -1000,
    });

    expect(peekInvite(stale.rawToken)).toEqual({ error: "expired" });
    const acc = await acceptInvite(stale.rawToken, { userAgent: "test" });
    expect(acc).toEqual({ ok: false, error: "expired" });
    // ...and it never created the user it was bound to.
    expect(getUserByName("Ghost")).toBeUndefined();
    // Expired rows drop out of the outstanding list.
    expect(outstandingPrefixes()).not.toContain(stale.prefix);
  });
});

describe("auth/invites: replacePriorForUsername scope", () => {
  it("replaces only the same user's OUTSTANDING invites - consumed, expired and foreign rows survive", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    await server.seedMember("Alice");
    await server.seedMember("Bob");

    // Four pre-existing rows around Alice.
    const aliceOutstanding = await mintOk({
      username: "Alice",
      role: "member",
      createdBy: "Alice",
      allowExisting: true,
      replacePriorForUsername: true,
    });
    const aliceExpired = await mintOk({
      username: "Alice",
      role: "member",
      createdBy: "Boss",
      allowExisting: true,
      ttlMsOverride: -1000,
    });
    const aliceConsumed = await mintOk({
      username: "Alice",
      role: "member",
      createdBy: "Boss",
      allowExisting: true,
    });
    const consumeIt = await acceptInvite(aliceConsumed.rawToken, {
      userAgent: "test",
    });
    expect(consumeIt.ok).toBe(true);
    const bobOutstanding = await mintOk({
      username: "Bob",
      role: "member",
      createdBy: "Bob",
      allowExisting: true,
      replacePriorForUsername: true,
    });

    // Re-mint for "alice" in DIFFERENT CASE: the match is case-insensitive, so
    // this must still displace the outstanding row above.
    const replacement = await mintOk({
      username: "alice",
      role: "member",
      createdBy: "Alice",
      allowExisting: true,
      replacePriorForUsername: true,
    });

    const outstanding = outstandingPrefixes();
    expect(outstanding).not.toContain(aliceOutstanding.prefix); // displaced
    expect(outstanding).toContain(replacement.prefix);
    expect(outstanding).toContain(bobOutstanding.prefix); // another user: untouched

    // The consumed and expired rows were never candidates for replacement, so
    // they must still be REDEEMABLE-STATE-wise what they were: consumed stays
    // consumed (not deleted-and-forgotten), expired stays expired.
    expect(peekInvite(aliceConsumed.rawToken)).toEqual({ error: "consumed" });
    expect(peekInvite(aliceExpired.rawToken)).toEqual({ error: "expired" });
    // And the displaced one is genuinely gone, not merely hidden from the list.
    expect(peekInvite(aliceOutstanding.rawToken)).toEqual({
      error: "not_found",
    });
  });
});

describe("auth/invites: mint refusal matrix", () => {
  it("existing user without allowExisting -> USER_EXISTS; role conflict -> ROLE_MISMATCH", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    await server.seedMember("Alice");

    const dup = await mintInvite({
      username: "Alice",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("USER_EXISTS");

    // allowExisting clears USER_EXISTS but NOT a role conflict: Alice is a
    // member on the record, so an owner-role invite for her is refused rather
    // than silently promoting her on accept.
    const mismatch = await mintInvite({
      username: "Alice",
      role: "owner",
      createdBy: "Boss",
      allowExisting: true,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("ROLE_MISMATCH");

    // Positive control: matching role passes, so the two refusals above are the
    // named checks and not a blanket "existing users can't be minted for".
    const okMint = await mintInvite({
      username: "Alice",
      role: "member",
      createdBy: "Boss",
      allowExisting: true,
    });
    expect(okMint.ok).toBe(true);
  });

  it("blank username and an unknown role are refused", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");

    const blank = await mintInvite({
      username: "   ",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.code).toBe("INVALID_USERNAME");

    const badRole = await mintInvite({
      username: "Zed",
      role: "admin" as never,
      createdBy: "Boss",
      allowExisting: false,
    });
    expect(badRole.ok).toBe(false);
    if (!badRole.ok) expect(badRole.code).toBe("INVALID_ROLE");
  });
});

describe("auth/invites: peek never consumes", () => {
  it("two peeks then an accept still succeeds; the accept is what flips it consumed", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const inv = await mintOk({
      username: "Newbie",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });

    const first = peekInvite(inv.rawToken);
    const second = peekInvite(inv.rawToken);
    expect(first).toEqual({
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
  it("accept creates the user, issues a session, and consumes the invite", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    expect(getUserByName("Newbie")).toBeUndefined();

    const inv = await mintOk({
      username: "Newbie",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });
    const acc = await acceptInvite(inv.rawToken, { userAgent: "ua/1" });
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;

    expect(acc.username).toBe("Newbie");
    expect(acc.role).toBe("member");
    expect(acc.isBootstrap).toBe(false);
    expect(acc.inviteNeedsName).toBe(false);
    expect(acc.rawSessionId.length).toBeGreaterThan(20);
    expect(acc.absoluteExpiresAt).toBeGreaterThan(acc.expiresAt);

    // User upserted with the invited role.
    const rec = getUserByName("Newbie");
    expect(rec?.role).toBe("member");
    // Invite burnt.
    expect(peekInvite(inv.rawToken)).toEqual({ error: "consumed" });
    const replay = await acceptInvite(inv.rawToken, { userAgent: "ua/1" });
    expect(replay).toEqual({ ok: false, error: "consumed" });
  });

  it("role_mismatch: the record's role changed between mint and accept", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    await server.seedMember("Alice");

    // Minted while Alice is a member (so mint's own ROLE_MISMATCH check passes)...
    const inv = await mintOk({
      username: "Alice",
      role: "member",
      createdBy: "Boss",
      allowExisting: true,
    });
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

  it("a null-username (bootstrap) invite demands a valid chosen name", async () => {
    server = await startTestServer();
    // No owner yet - a bootstrap invite is only meaningful pre-claim.
    const inv = await mintOk({
      username: null,
      role: "owner",
      createdBy: null,
      allowExisting: false,
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
    const inv = await mintOk({
      username: "Newbie",
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });

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
    const a = await mintOk({
      username: null,
      role: "owner",
      createdBy: null,
      allowExisting: false,
      bootstrap: true,
    });
    const b = await mintOk({
      username: null,
      role: "owner",
      createdBy: null,
      allowExisting: false,
      bootstrap: true,
    });
    const c = await mintOk({
      username: null,
      role: "owner",
      createdBy: null,
      allowExisting: false,
      bootstrap: true,
    });

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
    expect(outstandingPrefixes()).not.toContain(b.prefix);
    expect(outstandingPrefixes()).not.toContain(c.prefix);

    // And a fresh bootstrap invite minted AFTER the claim is refused with
    // owner_exists (the mutex-held recheck), not honored as a second owner.
    const late = await mintOk({
      username: null,
      role: "owner",
      createdBy: null,
      allowExisting: false,
      bootstrap: true,
    });
    expect(peekInvite(late.rawToken)).toEqual({ error: "owner_exists" });
    const acc = await acceptInvite(late.rawToken, {
      userAgent: "t",
      chosenName: "Impostor",
    });
    expect(acc).toEqual({ ok: false, error: "owner_exists" });
    expect(getUserByName("Impostor")).toBeUndefined();
  });
});
