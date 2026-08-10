// The fetch verb's decision table, and the credential in front of it.
//
// Every rule is tested without a port: the server is a thin wrapper around
// fetchInvite, and what matters is which answer each situation earns and what
// each answer does NOT say.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InviteHold } from "./invite-hold.ts";
import {
  fetchInvite,
  startMintSeam,
  tokenMatches,
  MIN_SEAM_TOKEN_LENGTH,
} from "./mint-seam.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { Store, type OperationStatus } from "./store.ts";

const URL_HELD = "https://cp1.test.isomux.app/i/seamsecret";
const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Bed {
  store: Store;
  hold: InviteHold;
  accountId: string;
  instanceId: string;
  opId: string;
  req: { accountId: string; instanceId: string; operationId: string };
}

/**
 * A signed-up office with a linked box, a proven first contact and a mint row.
 * That is the state a real fetch happens in: anything less and the window
 * computation would be answering a different question.
 */
async function bed(
  opts: { status?: OperationStatus; revoked?: boolean } = {},
): Promise<Bed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-seam-"));
  temps.push(dir);
  const store = await Store.open(path.join(dir, "cp.db"));
  const account = await accountForDevSignIn(store, "seam@example.com");
  const reserved = await reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;
  const asset = (await store.assetForInstance(instanceId))!;
  await store.casAsset(asset.id, asset.version, {
    provider_id: "203474835",
    asset_state: "active",
  });
  const succeed = async (kind: string): Promise<void> => {
    const op = await store.enqueue({
      id: `op-${kind}-x`,
      instance_id: instanceId,
      kind,
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
    });
    const leased = (await store.tryLease(
      op.id,
      op.version,
      "h",
      0,
      Date.now(),
    ))!;
    await store.casOperation(
      { id: leased.id, version: leased.version, holder: "h" },
      { status: "succeeded" },
    );
  };
  await succeed("first_contact");
  if (opts.revoked) await succeed("revoke_access");

  const mint = await store.enqueue({
    id: "op-mint_invite-1",
    instance_id: instanceId,
    kind: "mint_invite",
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
  });
  const status = opts.status ?? "succeeded";
  if (status !== "pending") {
    const leased = (await store.tryLease(
      mint.id,
      mint.version,
      "h",
      0,
      Date.now(),
    ))!;
    await store.casOperation(
      { id: leased.id, version: leased.version, holder: "h" },
      { status },
    );
  }
  const hold = new InviteHold();
  hold.hold(mint.id, instanceId, URL_HELD);
  return {
    store,
    hold,
    accountId: account.id,
    instanceId,
    opId: mint.id,
    req: {
      accountId: account.id,
      instanceId,
      operationId: mint.id,
    },
  };
}

describe("the fetch verb", () => {
  test("a succeeded mint hands the URL over exactly once", async () => {
    const b = await bed();
    expect(await fetchInvite(b.store, b.hold, b.req)).toEqual({
      status: "ready",
      url: URL_HELD,
    });
    const second = await fetchInvite(b.store, b.hold, b.req);
    expect(second.status).toBe("expired_or_lost");
    expect(JSON.stringify(second)).not.toContain("seamsecret");
  });

  test("a running mint is not_ready, and says nothing else", async () => {
    const b = await bed({ status: "running" });
    const result = await fetchInvite(b.store, b.hold, b.req);
    expect(result.status).toBe("not_ready");
    expect(JSON.stringify(result)).not.toContain("seamsecret");
    // And it did NOT consume the entry: the customer's link survives a poll
    // that arrived a moment early.
    expect(b.hold.size()).toBe(1);
  });

  test("a failed mint is reported from the ROW's status", async () => {
    const b = await bed({ status: "failed" });
    const result = await fetchInvite(b.store, b.hold, b.req);
    expect(result).toEqual({
      status: "failed",
      reason: "the invite request ended failed",
    });
  });

  test("another account gets the same answer as a stranger", async () => {
    const b = await bed();
    const other = await accountForDevSignIn(
      b.store,
      "someone-else@example.com",
    );
    const result = await fetchInvite(b.store, b.hold, {
      ...b.req,
      accountId: other.id,
    });
    expect(result.status).toBe("forbidden");
    // The entry is untouched, so a foreign probe cannot burn somebody's link.
    expect(b.hold.size()).toBe(1);
  });

  test("an operation of another kind is not a fetchable invite", async () => {
    const b = await bed();
    const other = await b.store.enqueue({
      id: "op-reboot-9",
      instance_id: b.instanceId,
      kind: "reboot",
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
    });
    expect(
      (await fetchInvite(b.store, b.hold, { ...b.req, operationId: other.id }))
        .status,
    ).toBe("forbidden");
  });
});

describe("the window closes between mint and fetch", () => {
  test("the fetch refuses AND empties the hold", async () => {
    // Ruled by the manager (R-2026-08-10-1-AMENDED clause 4) and confirmed by
    // the reviewer: a closed window means the customer is already in, so a link
    // nobody may collect stops existing rather than waiting out its TTL.
    const b = await bed({ revoked: true });
    expect(b.hold.size()).toBe(1);
    const result = await fetchInvite(b.store, b.hold, b.req);
    expect(result).toEqual({
      status: "window_closed",
      reason: "the access window for this office is closed",
    });
    expect(b.hold.size()).toBe(0);
    expect(JSON.stringify(result)).not.toContain("seamsecret");
  });

  test("and a later fetch still refuses rather than reporting a loss", async () => {
    const b = await bed({ revoked: true });
    await fetchInvite(b.store, b.hold, b.req);
    expect((await fetchInvite(b.store, b.hold, b.req)).status).toBe(
      "window_closed",
    );
  });
});

describe("the credential", () => {
  test("a wrong or shorter token never matches", async () => {
    const token = "a".repeat(40);
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches("a".repeat(39), token)).toBe(false);
    expect(tokenMatches(`${token}b`, token)).toBe(false);
    expect(tokenMatches("", token)).toBe(false);
  });

  test("the seam refuses to start without a real one", async () => {
    const b = await bed();
    const start = (token: string) =>
      startMintSeam({ store: b.store, hold: b.hold, token, port: 0 });
    expect(() => start("")).toThrow(/refusing to start an unauthenticated/);
    expect(() => start("short")).toThrow(/at least/);
    expect(MIN_SEAM_TOKEN_LENGTH).toBeGreaterThanOrEqual(32);
  });
});

describe("over HTTP", () => {
  test("no credential, no answer - and no detail either", async () => {
    const b = await bed();
    const token = "t".repeat(40);
    const seam = startMintSeam({
      store: b.store,
      hold: b.hold,
      token,
      port: 0,
    });
    try {
      const base = `http://127.0.0.1:${seam.port}/internal/invite`;
      const body = JSON.stringify(b.req);

      const anonymous = await fetch(base, { method: "POST", body });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.text()).not.toContain("seamsecret");

      const wrong = await fetch(base, {
        method: "POST",
        headers: { authorization: `Bearer ${"x".repeat(40)}` },
        body,
      });
      expect(wrong.status).toBe(401);
      // The link is still there: an unauthenticated caller cannot burn it.
      expect(b.hold.size()).toBe(1);

      const ok = await fetch(base, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
      });
      expect(await ok.json()).toEqual({ status: "ready", url: URL_HELD });

      const elsewhere = await fetch(
        `http://127.0.0.1:${seam.port}/internal/anything`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body,
        },
      );
      expect(elsewhere.status).toBe(404);
    } finally {
      await seam.stop();
    }
  });
});
