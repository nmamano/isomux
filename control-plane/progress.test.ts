// The projection's three promises: it does not invent progress, it does not
// hand raw evidence to a browser, and it does not show one account another
// account's office.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store, type OperationStatus } from "./store.ts";
import { acknowledgeAttention } from "./attention-ack.ts";
import { raiseAttention } from "./attention.ts";
import { DECLARED_UNIMPLEMENTED_KINDS, nextKind } from "./operations.ts";
import { ladderFor, projectionFor } from "./progress.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";

const temps: string[] = [];

function tempStore(now?: () => number): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-progress-"));
  temps.push(dir);
  return new Store(path.join(dir, "cp.db"), now);
}

afterEach(() => {
  while (temps.length)
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function signedUp(store: Store, over: { email?: string; name?: string } = {}) {
  const account = accountForDevSignIn(store, over.email ?? "a@example.com");
  const out = reserveOffice(store, {
    accountId: account.id,
    officeName: over.name ?? "acme",
    plan: "office",
  });
  if (!out.ok) throw new Error(`signup failed: ${out.reason}`);
  return out;
}

function signedUpAccountId(store: Store): string {
  return store.db
    .query<
      { account_id: string },
      []
    >("select account_id from name_reservations limit 1")
    .get()!.account_id;
}

function addOp(
  store: Store,
  instanceId: string,
  kind: string,
  status: OperationStatus,
  evidence: unknown = {},
): void {
  const id = `op-${kind}-${store.nextSeq("audit")}`;
  store.enqueue({
    id,
    instance_id: instanceId,
    kind,
    inactivity_deadline_at: store.now() + 60_000,
    absolute_deadline_at: store.now() + 120_000,
    evidence,
  });
  if (status !== "pending") {
    store.db.run("update operations set status = ? where id = ?", [status, id]);
  }
}

/** The adoption the exercise helper performs: an existing box linked to a
 * signed-up instance, with no create_instance row anywhere. */
function adopt(store: Store, instanceId: string): void {
  const asset = store.assetForInstance(instanceId)!;
  store.tx(() => {
    store.casAsset(asset.id, asset.version, {
      provider_id: "203474835",
      ipv4: "169.58.97.2",
      asset_state: "active",
    });
  });
}

describe("the ladder is walked, not written down", () => {
  test("each goal yields exactly its chain", () => {
    expect(ladderFor("first_contact")).toEqual([
      "create_instance",
      "wait_for_ssh",
      "first_contact",
      "arm_revocation",
    ]);
    expect(ladderFor("installed")).toEqual([
      "create_instance",
      "wait_for_ssh",
      "first_contact",
      "arm_revocation",
      "wait_for_package_manager",
      "run_installer",
    ]);
    // A HOSTED OFFICE STOPS AT verify_https. Slice 4b: minting before the
    // customer asks would put a live credential wherever the provisioner's
    // output goes, so `live` ends at verified-live and the dashboard's request
    // is what opens the mint.
    expect(ladderFor("live")).toEqual([
      "create_instance",
      "wait_for_ssh",
      "first_contact",
      "arm_revocation",
      "wait_for_package_manager",
      "run_installer",
      "verify_https",
    ]);
    // The OPERATOR's deliberate one-command flow still mints and revokes: it is
    // invoked interactively, and its invite goes to the reporter with the
    // redacted-transcript contract.
    expect(ladderFor("handed_off")).toEqual([
      ...ladderFor("live"),
      "mint_invite",
      "revoke_access",
    ]);
  });

  test("a hosted goal never reaches a mint on its own", () => {
    // The rule stated where it is enforced, so that moving it back into the
    // chain fails here rather than in a browser six steps later.
    expect(nextKind("verify_https", "live")).toBeNull();
    expect(nextKind("verify_https", "handed_off")).toBe("mint_invite");
    expect(ladderFor("live")).not.toContain("mint_invite");
  });

  test("no ladder can contain a kind nothing drives, or a suspension", () => {
    for (const goal of [
      "first_contact",
      "installed",
      "live",
      "handed_off",
    ] as const) {
      const ladder = ladderFor(goal);
      for (const kind of DECLARED_UNIMPLEMENTED_KINDS) {
        expect(ladder).not.toContain(kind);
      }
      expect(ladder).not.toContain("power_off");
    }
  });

  test("a signup's goal is live, so no revoke step is promised", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: reservation.instance_id,
    })!;
    expect(view.steps.map((s) => s.kind)).not.toContain("revoke_access");
  });
});

describe("it does not invent progress", () => {
  test("a fresh signup shows every step waiting and is not ready", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: reservation.instance_id,
    })!;
    expect(view.origin).toBe("created");
    expect(view.steps.every((s) => s.state === "waiting")).toBe(true);
    expect(view.ready).toBe(false);
  });

  test("statuses map to states, and ambiguous is checking rather than failed", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    addOp(store, id, "wait_for_ssh", "succeeded");
    addOp(store, id, "first_contact", "failed");
    addOp(store, id, "arm_revocation", "ambiguous");
    addOp(store, id, "wait_for_package_manager", "running");
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    const byKind = new Map(view.steps.map((s) => [s.kind, s.state]));
    expect(byKind.get("wait_for_ssh")).toBe("done");
    expect(byKind.get("first_contact")).toBe("failed");
    expect(byKind.get("arm_revocation")).toBe("checking");
    expect(byKind.get("wait_for_package_manager")).toBe("active");
    expect(byKind.get("run_installer")).toBe("waiting");
  });

  test("ready rests on a succeeded verify_https, not on how far the ladder got", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    addOp(store, id, "verify_https", "running", { rung: "tls" });
    const running = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(running.ready).toBe(false);
    store.db.run("update operations set status = 'succeeded' where kind = ?", [
      "verify_https",
    ]);
    const done = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(done.ready).toBe(true);
  });
});

describe("the adopted path", () => {
  test("an adopted run never shows a waiting create step beside real progress", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    adopt(store, id);
    addOp(store, id, "wait_for_ssh", "succeeded");
    addOp(store, id, "run_installer", "running", { phase: "running" });
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(view.origin).toBe("adopted");
    expect(view.steps.map((s) => s.kind)).not.toContain("create_instance");
    expect(view.steps.find((s) => s.kind === "wait_for_ssh")?.state).toBe(
      "done",
    );
  });

  test("a cancel-scheduled box is still an adopted box", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    adopt(store, id);
    addOp(store, id, "wait_for_ssh", "succeeded");
    // What the provider says about BILLING is not what we say about whether a
    // box exists: the first reconcile against a cancel-scheduled box moves the
    // asset state, and the office does not become un-adopted.
    const asset = store.assetForInstance(id)!;
    store.tx(() => {
      store.casAsset(asset.id, asset.version, {
        asset_state: "cancel_scheduled",
      });
    });
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(view.origin).toBe("adopted");
    expect(view.steps.map((s) => s.kind)).not.toContain("create_instance");
  });

  test("a linked asset with no operations is still a created office", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    adopt(store, reservation.instance_id);
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: reservation.instance_id,
    })!;
    expect(view.origin).toBe("created");
    expect(view.steps[0].kind).toBe("create_instance");
    expect(view.steps[0].state).toBe("waiting");
  });

  test("a real create row keeps the create step, adopted or not", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    adopt(store, id);
    addOp(store, id, "create_instance", "succeeded");
    addOp(store, id, "wait_for_ssh", "running");
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(view.origin).toBe("created");
    expect(view.steps[0].kind).toBe("create_instance");
    expect(view.steps[0].state).toBe("done");
  });

  test("an operation outside the goal's chain is shown, not hidden", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    addOp(store, id, "revoke_access", "running");
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(view.steps.map((s) => s.kind)).not.toContain("revoke_access");
    expect(view.otherOperations.map((s) => s.kind)).toEqual(["revoke_access"]);
    expect(view.otherOperations[0].state).toBe("active");
  });
});

describe("evidence never reaches the browser raw", () => {
  test("hostile and unlisted evidence fields are dropped", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    addOp(store, id, "run_installer", "running", {
      phase: "running",
      step: "install service; cat /root/.ssh/id_ed25519",
      detail: "sk_test_hostile_fixture_value",
      last: "ssh: connect to host 169.58.97.2 port 22: Connection refused",
      runId: "run-20260809-abcd",
      surprise: "a field a future handler added",
    });
    addOp(store, id, "wait_for_package_manager", "running", {
      busy: "Unable to acquire the dpkg frontend lock, held by pid 900 (unattended-upgr)",
    });
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("sk_test_");
    expect(serialised).not.toContain("id_ed25519");
    expect(serialised).not.toContain("Connection refused");
    expect(serialised).not.toContain("dpkg frontend lock");
    expect(serialised).not.toContain("run-20260809-abcd");
    expect(serialised).not.toContain("a field a future handler added");
    // The one allowlisted field still comes through, mapped to our words.
    expect(view.steps.find((s) => s.kind === "run_installer")?.detail).toBe(
      "installer running",
    );
  });

  test("an oversized or unparseable marker is dropped rather than trimmed", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    addOp(store, id, "run_installer", "running", { step: "x".repeat(10_000) });
    const big = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(
      big.steps.find((s) => s.kind === "run_installer")?.detail,
    ).toBeNull();

    store.db.run("update operations set evidence = ? where kind = ?", [
      "not json at all",
      "run_installer",
    ]);
    const broken = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(
      broken.steps.find((s) => s.kind === "run_installer")?.detail,
    ).toBeNull();
  });

  test("a well-formed marker and a liveness rung become our own words", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    addOp(store, id, "run_installer", "running", { step: "install-service" });
    addOp(store, id, "verify_https", "running", { rung: "tls" });
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(view.steps.find((s) => s.kind === "run_installer")?.detail).toBe(
      "step: install-service",
    );
    expect(view.steps.find((s) => s.kind === "verify_https")?.detail).toBe(
      "waiting for the certificate",
    );
  });
});

describe("attention", () => {
  test("renders by class and severity, never as the operator's own words", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    addOp(store, id, "run_installer", "running");
    raiseAttention(store, {
      instanceId: id,
      sourceOpId: "op-run_installer-1",
      reasonClass: "inactivity_deadline",
      reason:
        "systemd reports OnCalendar=2026-09-08 12:00:00 UTC for /root/secret-timer",
      severity: "warning",
      actor: "tick",
    });
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(view.attention).toHaveLength(1);
    expect(view.attention[0].reasonClass).toBe("inactivity_deadline");
    expect(view.attention[0].severity).toBe("warning");
    expect(JSON.stringify(view)).not.toContain("secret-timer");
    expect(JSON.stringify(view)).not.toContain("OnCalendar");
  });

  test("acknowledging is not clearing: the condition still renders", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    const id = reservation.instance_id;
    addOp(store, id, "run_installer", "running");
    raiseAttention(store, {
      instanceId: id,
      sourceOpId: "op-run_installer-1",
      reasonClass: "absolute_deadline",
      reason: "the installer passed its ceiling",
      severity: "critical",
      actor: "tick",
    });
    acknowledgeAttention(store, id, "Nil");
    const view = projectionFor(store, {
      accountId: account.id,
      instanceId: id,
    })!;
    expect(view.attention).toHaveLength(1);
    expect(view.attention[0].acknowledged).toBe(true);
  });
});

describe("tenant scope", () => {
  test("another account's instance projects to null, as does an unknown one", () => {
    const store = tempStore();
    const mine = signedUp(store);
    const theirs = signedUp(store, { email: "b@example.com", name: "beta" });
    expect(
      projectionFor(store, {
        accountId: mine.account.id,
        instanceId: theirs.reservation.instance_id,
      }),
    ).toBeNull();
    expect(
      projectionFor(store, {
        accountId: mine.account.id,
        instanceId: "inst-nope",
      }),
    ).toBeNull();
  });
});

describe("what the page is allowed to claim about our key", () => {
  const NOW = 1_700_000_000_000;

  function frozen() {
    const store = tempStore(() => NOW);
    const { reservation, account } = signedUp(store);
    const read = () =>
      projectionFor(store, {
        accountId: account.id,
        instanceId: reservation.instance_id,
      })!.access;
    return { store, id: reservation.instance_id, read };
  }

  /** The ceiling signup wrote, moved to a chosen instant. Rewriting the row
   * directly is the only way: the store refuses to update that column, which is
   * the property that makes it worth trusting. */
  function ceilingAt(store: Store, id: string, at: number): void {
    store.db.run(
      "update instances set access_window_expires_at = ? where id = ?",
      [at, id],
    );
  }

  test("a fresh reservation has no box, so no key is claimed", () => {
    const { store, id, read } = frozen();
    // Pristine is what earns the claim: the placeholder asset untouched.
    expect(store.assetForInstance(id)?.asset_state).toBe("none");
    expect(store.assetForInstance(id)?.provider_id).toBeNull();
    expect(read().state).toBe("not_started");
    expect(read().ceilingProven).toBe(false);
  });

  test("an AMBIGUOUS create is unknown access, never 'no key'", () => {
    const { store, id, read } = frozen();
    const asset = store.assetForInstance(id)!;
    store.tx(() => {
      store.casAsset(asset.id, asset.version, {
        asset_state: "order_ambiguous",
      });
    });
    addOp(store, id, "create_instance", "ambiguous");
    // A machine may exist carrying our key that we cannot yet name. That is
    // unknown, and the page must not say there is no key.
    expect(read().state).toBe("needs_attention");
    expect(store.assetForInstance(id)?.provider_id).toBeNull();
  });

  test("a create that has been ATTEMPTED at all stops the no-key claim", () => {
    const { store, id, read } = frozen();
    // The window the discriminator exists for: the operation row is open while
    // the asset is still the placeholder, so asset state alone would say
    // pristine.
    expect(store.assetForInstance(id)?.asset_state).toBe("none");
    addOp(store, id, "create_instance", "pending");
    expect(read().state).toBe("needs_attention");
  });

  test("an order_pending asset is unknown even with no create row read back", () => {
    const { store, id, read } = frozen();
    const asset = store.assetForInstance(id)!;
    store.tx(() => {
      store.casAsset(asset.id, asset.version, { asset_state: "order_pending" });
    });
    expect(read().state).toBe("needs_attention");
  });

  test("an instance whose asset row is missing is unknown, not absent", () => {
    const { store, id, read } = frozen();
    store.db.run("delete from provider_assets where instance_id = ?", [id]);
    expect(read().state).toBe("needs_attention");
  });

  test("a linked box before its ceiling holds a key", () => {
    const { store, id, read } = frozen();
    adopt(store, id);
    ceilingAt(store, id, NOW + 60_000);
    expect(read().state).toBe("held");
    // No first contact yet, so the instant is ours and not the box's: the page
    // may say a key is held and may NOT name a date.
    expect(read().ceilingProven).toBe(false);
    addOp(store, id, "first_contact", "succeeded");
    expect(read().state).toBe("held");
    expect(read().ceilingProven).toBe(true);
  });

  test("with first contact proven, the exact ceiling is already past", () => {
    const { store, id, read } = frozen();
    adopt(store, id);
    addOp(store, id, "first_contact", "succeeded");
    ceilingAt(store, id, NOW + 1);
    expect(read().state).toBe("held");
    ceilingAt(store, id, NOW);
    expect(read().state).toBe("gone");
    ceilingAt(store, id, NOW - 1);
    expect(read().state).toBe("gone");
  });

  test("a crossed ceiling without proven first contact is neither held nor gone", () => {
    const { store, id, read } = frozen();
    adopt(store, id);
    addOp(store, id, "first_contact", "failed");
    ceilingAt(store, id, NOW - 1);
    expect(read().state).toBe("needs_attention");
  });

  test("an enqueued or failed revocation is not proof", () => {
    const { store, id, read } = frozen();
    adopt(store, id);
    ceilingAt(store, id, NOW + 60_000);
    addOp(store, id, "revoke_access", "running");
    expect(read().state).toBe("held");
    store.db.run("update operations set status = 'failed' where kind = ?", [
      "revoke_access",
    ]);
    expect(read().state).toBe("held");
  });

  test("a SUCCEEDED revocation means the key is gone, whatever the ceiling says", () => {
    const { store, id, read } = frozen();
    adopt(store, id);
    ceilingAt(store, id, NOW + 86_400_000);
    addOp(store, id, "revoke_access", "succeeded");
    expect(read().state).toBe("gone");
    const view = projectionFor(store, {
      accountId: signedUpAccountId(store),
      instanceId: id,
    })!;
    // And the page cannot then say both things: the operation reads done too.
    expect(
      view.otherOperations.find((s) => s.kind === "revoke_access")?.state,
    ).toBe("done");
  });
});

describe("comped means an ACTIVE full discount", () => {
  function withDiscount(
    store: Store,
    instanceId: string,
    percent: number | null,
    endsAt: number | null,
  ): void {
    store.db.run(
      "insert into subscriptions (id, account_id, instance_id, stripe_customer_id, " +
        "status, cancel_at_period_end, discount_percent_off, discount_ends_at, " +
        "ever_full_discount, payment_failures, episode_state, version, created_at, updated_at) " +
        "values ('sub_1', 'acct', ?, 'cus_1', 'active', 0, ?, ?, 1, 0, 'none', 1, ?, ?)",
      [instanceId, percent, endsAt, store.now(), store.now()],
    );
  }

  test("a discount with no end is comped; one that has ended is not", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    withDiscount(store, reservation.instance_id, 100, null);
    expect(
      projectionFor(store, {
        accountId: account.id,
        instanceId: reservation.instance_id,
      })!.subscription?.comped,
    ).toBe(true);

    store.db.run("update subscriptions set discount_ends_at = ?", [
      store.now() - 1,
    ]);
    expect(
      projectionFor(store, {
        accountId: account.id,
        instanceId: reservation.instance_id,
      })!.subscription?.comped,
    ).toBe(false);
  });

  test("the boundary is exact, and a frozen clock is what proves it", () => {
    // The clock has to be FROZEN for this to mean anything: with a real one,
    // "ends exactly now" has already passed by the time the projection reads
    // it, and `>=` would pass the test while being wrong.
    const NOW = 1_700_000_000_000;
    const store = tempStore(() => NOW);
    const { reservation, account } = signedUp(store);
    withDiscount(store, reservation.instance_id, 100, null);
    const read = () =>
      projectionFor(store, {
        accountId: account.id,
        instanceId: reservation.instance_id,
      })!.subscription!.comped;

    store.db.run("update subscriptions set discount_ends_at = ?", [NOW - 1]);
    expect(read()).toBe(false);
    // Ending AT this instant is over: the discount does not cover it.
    store.db.run("update subscriptions set discount_ends_at = ?", [NOW]);
    expect(read()).toBe(false);
    store.db.run("update subscriptions set discount_ends_at = ?", [NOW + 1]);
    expect(read()).toBe(true);
  });

  test("a partial discount is never comped, however live", () => {
    const store = tempStore();
    const { reservation, account } = signedUp(store);
    withDiscount(store, reservation.instance_id, 50, store.now() + 60_000);
    expect(
      projectionFor(store, {
        accountId: account.id,
        instanceId: reservation.instance_id,
      })!.subscription?.comped,
    ).toBe(false);
  });
});

// ------------------------------------------------------------- slice 4b

describe("the handoff panel", () => {
  function ready(store: Store): { instanceId: string; accountId: string } {
    const out = signedUp(store);
    const instanceId = out.reservation.instance_id;
    adopt(store, instanceId);
    addOp(store, instanceId, "first_contact", "succeeded");
    addOp(store, instanceId, "verify_https", "succeeded");
    return { instanceId, accountId: signedUpAccountId(store) };
  }

  test("a live office with our key held may mint, and nothing has yet", () => {
    const store = tempStore();
    const { instanceId, accountId } = ready(store);
    const view = projectionFor(store, { accountId, instanceId })!;
    expect(view.handoff.canMint).toBe(true);
    expect(view.handoff.invite).toEqual({
      state: "none",
      operationId: null,
      mintedAt: null,
    });
    expect(view.handoff.revocation.state).toBe("none");
    expect(view.handoff.revocation.customerConfirmed).toBe(false);
  });

  test("a running mint is visible as itself, with the id to collect it by", () => {
    const store = tempStore();
    const { instanceId, accountId } = ready(store);
    addOp(store, instanceId, "mint_invite", "running", { via: "dashboard" });
    const view = projectionFor(store, { accountId, instanceId })!;
    expect(view.handoff.invite.state).toBe("active");
    expect(view.handoff.invite.operationId).toContain("mint_invite");
    // Nothing claims a link exists until one does.
    expect(view.handoff.invite.mintedAt).toBeNull();
  });

  test("a proven revocation closes minting and reports it as theirs", () => {
    const store = tempStore();
    const { instanceId, accountId } = ready(store);
    addOp(store, instanceId, "revoke_access", "succeeded", {
      via: "dashboard",
    });
    const view = projectionFor(store, { accountId, instanceId })!;
    expect(view.access.state).toBe("gone");
    expect(view.handoff.canMint).toBe(false);
    expect(view.handoff.revocation.state).toBe("done");
    expect(view.handoff.revocation.customerConfirmed).toBe(true);
  });

  test("a revocation nobody asked for is shown but not called confirmation", () => {
    // An operator- or chain-opened row is real history and renders as a
    // revocation; describing it as the customer's confirmation would put words
    // in their mouth about the one act the access window turns on.
    const store = tempStore();
    const { instanceId, accountId } = ready(store);
    addOp(store, instanceId, "revoke_access", "running");
    const view = projectionFor(store, { accountId, instanceId })!;
    expect(view.handoff.revocation.state).toBe("active");
    expect(view.handoff.revocation.customerConfirmed).toBe(false);
    expect(view.handoff.revocation.confirmedAt).toBeNull();
  });

  test("an ambiguous revocation stays visible rather than reading as done", () => {
    const store = tempStore();
    const { instanceId, accountId } = ready(store);
    addOp(store, instanceId, "revoke_access", "ambiguous", {
      via: "dashboard",
    });
    const view = projectionFor(store, { accountId, instanceId })!;
    expect(view.handoff.revocation.state).toBe("checking");
    // And our key is still reported as HELD: an unproven removal is not a
    // removal, whatever the customer asked for.
    expect(view.access.state).toBe("held");
  });
});

describe("liveness and restart", () => {
  test("no reading is null rather than an invented healthy one", () => {
    const store = tempStore();
    const out = signedUp(store);
    const view = projectionFor(store, {
      accountId: signedUpAccountId(store),
      instanceId: out.reservation.instance_id,
    })!;
    expect(view.liveness).toBeNull();
    expect(view.restart).toEqual({
      state: "none",
      active: false,
      lastRequestedAt: null,
    });
  });

  test("strikes cross into unreachable at three, in our words", () => {
    const store = tempStore();
    const out = signedUp(store);
    const instanceId = out.reservation.instance_id;
    store.ensureLiveness(instanceId, store.now());
    const claimed = store.claimLiveness(instanceId, "h", 0, store.now())!;
    store.recordLiveness(instanceId, claimed.version, "h", {
      rung: "tls",
      strikes: 3,
      checkedAt: store.now(),
      nextAt: store.now() + 60_000,
    });
    const view = projectionFor(store, {
      accountId: signedUpAccountId(store),
      instanceId,
    })!;
    expect(view.liveness).toMatchObject({
      rung: "tls",
      strikes: 3,
      unreachable: true,
      words: "waiting for the certificate",
    });
  });

  test("an active restart is reported active, so the button cannot double-fire", () => {
    const store = tempStore();
    const out = signedUp(store);
    const instanceId = out.reservation.instance_id;
    addOp(store, instanceId, "reboot", "running", { via: "dashboard" });
    const view = projectionFor(store, {
      accountId: signedUpAccountId(store),
      instanceId,
    })!;
    expect(view.restart).toMatchObject({ state: "active", active: true });
  });

  test("a finished restart is no longer active", () => {
    const store = tempStore();
    const out = signedUp(store);
    const instanceId = out.reservation.instance_id;
    addOp(store, instanceId, "reboot", "succeeded", { via: "dashboard" });
    const view = projectionFor(store, {
      accountId: signedUpAccountId(store),
      instanceId,
    })!;
    expect(view.restart).toMatchObject({ state: "done", active: false });
  });
});

test("the customer's view never carries an invite or anything URL-shaped", () => {
  // Belt and braces beside invite-persistence.test.ts: that one watches what is
  // STORED, this one watches what is SENT. A future field that helpfully
  // surfaced "the link we minted" would fail here.
  const store = tempStore();
  const out = signedUp(store);
  const instanceId = out.reservation.instance_id;
  adopt(store, instanceId);
  addOp(store, instanceId, "first_contact", "succeeded");
  addOp(store, instanceId, "verify_https", "succeeded");
  addOp(store, instanceId, "mint_invite", "succeeded", {
    phase: "minted",
    minted: true,
    via: "dashboard",
  });
  const view = projectionFor(store, {
    accountId: signedUpAccountId(store),
    instanceId,
  })!;
  const json = JSON.stringify(view);
  expect(json).not.toMatch(/https?:\/\/\S*\/(?:i|invite)\//);
  expect(json).not.toContain("sealed");
  // It may say a link EXISTS, which is the point of the panel.
  expect(view.handoff.invite.mintedAt).not.toBeNull();
});
