// The invite seam, executed by the role the deployed provisioner authenticates
// as - which is the thing a decision-table test cannot say anything about.
//
// WHY THIS FILE EXISTS. `mint-seam.test.ts` drives `fetchInvite` as the owner,
// so every read it needs succeeds by construction and the file proves which
// ANSWER each situation earns. On 2026-08-12 the deployed seam earned none of
// them: the G3 forward probe's authenticated POST reached
// `instanceOwnedBy` -> `reservationForInstance`, the provisioner's matrix did
// not carry `name_reservations` SELECT, and the read was refused 42501 before
// any rule in that decision table could run. The probe reported a refusal, the
// move rolled back, and the SAME read sits on the real invite path - so D4's
// first genuine customer invite would have failed identically.
//
// So these cases run the REAL decision function, over a REAL store opened by a
// role holding exactly `PROVISIONER_GRANTS`, through the REAL HTTP seam. The
// probe's request and a customer's request are the same call into the same
// function, and both are exercised here rather than one standing in for the
// other.
//
// LOCAL ENGINE ONLY: it creates a login role.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { InviteHold } from "./invite-hold.ts";
import { MINT_SEAM_PATH, fetchInvite, startMintSeam } from "./mint-seam.ts";
import { PROVISIONER_GRANTS } from "./roles.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { Store } from "./store.ts";
import {
  TARGET_IS_LOCAL,
  freshDsn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
} from "./testing/least-privilege.ts";

const suite = TARGET_IS_LOCAL ? describe : describe.skip;

const URL_HELD = "https://cp1.test.isomux.app/i/seamsecret";
const TOKEN = "t".repeat(40);
const opened: Store[] = [];

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await dropLeastPrivilegedRoles();
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Bed {
  /** The seam's store, opened by the least-privileged role. */
  store: Store;
  hold: InviteHold;
  accountId: string;
  instanceId: string;
  opId: string;
}

/**
 * A real signed-up office with a proven first contact and a ready mint, and a
 * store for it opened AS THE PROVISIONER'S ROLE.
 *
 * The rows are written by the owner, because that is who writes them in
 * production too: signup happens on the web tier. What is under test is the
 * READ side, from the identity the deployed machine actually holds.
 */
async function bed(
  grants: readonly (typeof PROVISIONER_GRANTS)[number][] = PROVISIONER_GRANTS,
): Promise<Bed> {
  const ownerDsn = await freshDsn();
  const owner = await Store.open(ownerDsn);
  opened.push(owner);

  const account = await accountForDevSignIn(owner, "seam@example.com");
  const reserved = await reserveOffice(owner, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;
  const asset = (await owner.assetForInstance(instanceId))!;
  await owner.casAsset(asset.id, asset.version, {
    provider_id: "203474835",
    asset_state: "active",
  });

  const succeed = async (id: string, kind: string): Promise<void> => {
    const op = await owner.enqueue({
      id,
      instance_id: instanceId,
      kind,
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
    });
    const leased = (await owner.tryLease(
      op.id,
      op.version,
      "h",
      0,
      Date.now(),
    ))!;
    await owner.casOperation(
      { id: leased.id, version: leased.version, holder: "h" },
      { status: "succeeded" },
    );
  };
  await succeed("op-first_contact-1", "first_contact");
  await succeed("op-mint_invite-1", "mint_invite");

  const hold = new InviteHold();
  hold.hold("op-mint_invite-1", instanceId, URL_HELD);

  const roleDsn = await leastPrivilegedDsn({ dsn: ownerDsn, grants });
  const store = await Store.openRuntime(roleDsn);
  opened.push(store);
  return {
    store,
    hold,
    accountId: account.id,
    instanceId,
    opId: "op-mint_invite-1",
  };
}

/** One authenticated POST at the real server, and the answer it earned. */
async function ask(
  b: Bed,
  body: { accountId: string; instanceId: string; operationId: string },
): Promise<{ status: number; text: string }> {
  const seam = startMintSeam({
    store: b.store,
    hold: b.hold,
    token: TOKEN,
    port: 0,
  });
  try {
    const answer = await fetch(
      `http://127.0.0.1:${seam.port}${MINT_SEAM_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    return { status: answer.status, text: await answer.text() };
  } finally {
    await seam.stop();
  }
}

suite("the seam works under the role the provisioner authenticates as", () => {
  // THE PROBE'S OWN REQUEST, byte for byte the shape `deploy/probe.ts` sends:
  // three ids that name nothing, expecting the verb's fixed refusal. This is
  // the case that failed live on 2026-08-12.
  test("a request naming nothing earns the fixed forbidden answer", async () => {
    const b = await bed();
    const answer = await ask(b, {
      accountId: "probe-no-such-account",
      instanceId: "probe-no-such-instance",
      operationId: "probe-no-such-operation",
    });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({
      status: "forbidden",
      reason: "no such office",
    });
  });

  // AND THE REAL PATH, through the same function. A seam that could only refuse
  // would have passed the probe and still failed the first customer.
  test("a genuine owner collects the invite", async () => {
    const b = await bed();
    const answer = await ask(b, {
      accountId: b.accountId,
      instanceId: b.instanceId,
      operationId: b.opId,
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({
      status: "ready",
      url: URL_HELD,
    });
  });

  test("another account's claim on the same office is refused", async () => {
    const b = await bed();
    const answer = await ask(b, {
      accountId: "acct-somebody-else",
      instanceId: b.instanceId,
      operationId: b.opId,
    });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({
      status: "forbidden",
      reason: "no such office",
    });
  });

  // THE MECHANISM, pinned. Remove the one grant and the decision function does
  // not reach a decision at all - it is refused 42501 by the engine, which is
  // what the deployed machine did. The seam then answers something that is not
  // the verb's refusal, so a probe reading `invite_answer_forbidden` sees
  // false. This case is what makes the three above a boundary test rather than
  // a happy path that would go on passing after the grant was dropped.
  test("without the reservation read the seam cannot answer at all", async () => {
    const narrowed = PROVISIONER_GRANTS.filter(
      (g) => g.table !== "name_reservations",
    );
    const b = await bed(narrowed);
    const req = {
      accountId: "probe-no-such-account",
      instanceId: "probe-no-such-instance",
      operationId: "probe-no-such-operation",
    };
    // The DECISION FUNCTION, not the transport. Over HTTP this throw becomes
    // whatever the server does with a handler that raised - a dropped
    // connection here - and asserting that would pin Bun's error handling
    // rather than this build's boundary. What the seam can never do is reach
    // the refusal, so no probe reading `invite_answer_forbidden` sees true.
    const refusal = await fetchInvite(b.store, b.hold, req).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refusal).toEqual(expect.objectContaining({ code: "42501" }));
  });
});
