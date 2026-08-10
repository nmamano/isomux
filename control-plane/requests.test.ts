// The customer's three verbs: who may ask, when, and what stops a second one.
//
// The interesting assertions here are the refusals. A verb that opens the right
// row on the happy path and opens a second one under a double click is not a
// verb, it is a race with a nice name.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  confirmHandoff,
  requestInvite,
  requestRestart,
  REFUSAL_WORDS,
} from "./requests.ts";
import { accountForDevSignIn, reserveOffice } from "./signup.ts";
import { Store, type OperationStatus } from "./store.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Bed {
  store: Store;
  accountId: string;
  instanceId: string;
  succeed(kind: string): void;
  open(kind: string, status?: OperationStatus): string;
}

function bed(opts: { linked?: boolean } = {}): Bed {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-requests-"));
  temps.push(dir);
  const store = new Store(path.join(dir, "cp.db"));
  const account = accountForDevSignIn(store, "asker@example.com");
  const reserved = reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;
  if (opts.linked !== false) {
    const asset = store.assetForInstance(instanceId)!;
    store.casAsset(asset.id, asset.version, {
      provider_id: "203474835",
      asset_state: "active",
    });
  }
  let n = 0;
  const open = (kind: string, status: OperationStatus = "pending"): string => {
    const op = store.enqueue({
      id: `op-${kind}-${n++}`,
      instance_id: instanceId,
      kind,
      inactivity_deadline_at: 0,
      absolute_deadline_at: 0,
    });
    if (status !== "pending") {
      const leased = store.tryLease(op.id, op.version, "h", 0, Date.now())!;
      store.casOperation(
        { id: leased.id, version: leased.version, holder: "h" },
        { status },
      );
    }
    return op.id;
  };
  return {
    store,
    accountId: account.id,
    instanceId,
    open,
    succeed: (kind) => void open(kind, "succeeded"),
  };
}

describe("who may ask", () => {
  test("another account's office is not found", () => {
    const b = bed();
    const other = accountForDevSignIn(b.store, "other@example.com");
    for (const verb of [requestInvite, confirmHandoff, requestRestart]) {
      const out = verb(b.store, {
        accountId: other.id,
        instanceId: b.instanceId,
      });
      expect(out).toMatchObject({ ok: false, code: "not_yours" });
    }
  });
});

describe("the access window gates minting", () => {
  test("a pristine signup is refused with the reason that fits it", () => {
    const b = bed({ linked: false });
    const out = requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(out).toMatchObject({ ok: false, code: "window_not_started" });
  });

  test("a held window mints, and the row carries the dashboard stamp", () => {
    const b = bed();
    b.succeed("first_contact");
    const out = requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(out.ok).toBe(true);
    const op = b.store.getOperation(
      (out as { operationId: string }).operationId,
    )!;
    expect(op.kind).toBe("mint_invite");
    // The stamp is what routes the URL to the customer instead of an operator.
    expect(JSON.parse(op.evidence).via).toBe("dashboard");
  });

  test("a proven revocation ends minting for good", () => {
    const b = bed();
    b.succeed("first_contact");
    b.succeed("revoke_access");
    const out = requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(out).toMatchObject({ ok: false, code: "window_gone" });
    // The wording matters: there is no later attempt that would work, so it
    // does not invite one.
    expect(REFUSAL_WORDS.window_gone).toContain("Contact support");
  });

  test("a refused mint is audited as the customer's, and opens nothing", () => {
    const b = bed({ linked: false });
    requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    const audits = b.store
      .auditEvents()
      .filter((a) => a.action === "request_invite");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: `account:${b.accountId}`,
      outcome: "failed",
    });
    expect(b.store.operationsFor(b.instanceId)).toHaveLength(0);
  });
});

describe("one active operation, whatever the caller does", () => {
  test("a second mint is refused while one is live", () => {
    const b = bed();
    b.succeed("first_contact");
    const first = requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(first.ok).toBe(true);
    expect(
      requestInvite(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "mint_in_progress" });
    expect(
      b.store
        .operationsFor(b.instanceId)
        .filter((o) => o.kind === "mint_invite"),
    ).toHaveLength(1);
  });

  test("a resend is allowed once the previous one is terminal", () => {
    const b = bed();
    b.succeed("first_contact");
    b.succeed("mint_invite");
    const again = requestInvite(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(again.ok).toBe(true);
  });

  test("a second restart is refused while one is live", () => {
    const b = bed();
    expect(
      requestRestart(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }).ok,
    ).toBe(true);
    expect(
      requestRestart(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "restart_in_progress" });
  });

  /**
   * THE INDEX IS THE ARBITER, not the pre-check.
   *
   * This is the property that survives two callers passing the pre-check in the
   * same instant, so it is asserted against the database directly rather than
   * through the function that also asks nicely first.
   */
  test("the database itself refuses the second row", () => {
    const b = bed();
    b.open("reboot");
    expect(() => b.open("reboot")).toThrow(/UNIQUE|constraint/i);
  });

  test("a restart with no box is refused before anything is opened", () => {
    const b = bed({ linked: false });
    expect(
      requestRestart(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "no_box" });
    expect(b.store.operationsFor(b.instanceId)).toHaveLength(0);
  });
});

describe("confirming the handoff", () => {
  test("an office that is not serving yet cannot be handed off", () => {
    // The same rule the operator path keeps: we do not give up the only access
    // we have to a box we never proved was live.
    const b = bed();
    b.succeed("first_contact");
    expect(
      confirmHandoff(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "not_live" });
  });

  test("confirming opens the revocation and stamps it as theirs", () => {
    const b = bed();
    b.succeed("first_contact");
    b.succeed("verify_https");
    const out = confirmHandoff(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(out.ok).toBe(true);
    const op = b.store.getOperation(
      (out as { operationId: string }).operationId,
    )!;
    expect(op.kind).toBe("revoke_access");
    expect(JSON.parse(op.evidence).via).toBe("dashboard");
    expect(
      b.store.auditEvents().some((a) => a.action === "confirm_handoff"),
    ).toBe(true);
  });

  test("clicking twice is not an error and opens nothing new", () => {
    const b = bed();
    b.succeed("first_contact");
    b.succeed("verify_https");
    const first = confirmHandoff(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    const second = confirmHandoff(b.store, {
      accountId: b.accountId,
      instanceId: b.instanceId,
    });
    expect(second).toMatchObject({ ok: true, alreadyOpen: true });
    expect((second as { operationId: string }).operationId).toBe(
      (first as { operationId: string }).operationId,
    );
    expect(
      b.store
        .operationsFor(b.instanceId)
        .filter((o) => o.kind === "revoke_access"),
    ).toHaveLength(1);
  });

  test("an already-proven revocation says so rather than trying again", () => {
    const b = bed();
    b.succeed("first_contact");
    b.succeed("verify_https");
    b.succeed("revoke_access");
    expect(
      confirmHandoff(b.store, {
        accountId: b.accountId,
        instanceId: b.instanceId,
      }),
    ).toMatchObject({ ok: false, code: "already_revoked" });
  });
});
