// The ops floor, and the authority that gates every one of its verbs.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { raiseAttention } from "./attention.ts";
import { acknowledgeInstance, opsFloor, opsInstance } from "./ops.ts";
import { isOperator } from "./operator.ts";
import { setOperator } from "./operator-admin.ts";
import { Database } from "bun:sqlite";
import { Store } from "./store.ts";
import { accountForDevSignIn } from "./signup.ts";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = Date.parse("2027-06-10T00:00:00Z");

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-ops-"));
  temps.push(dir);
  return await Store.open(path.join(dir, "cp.db"), () => NOW);
}

async function seed(
  store: Store,
): Promise<{ operator: string; plain: string }> {
  await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp2.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "live",
    access_window_expires_at: null,
  });
  const operator = (await accountForDevSignIn(store, "nil@example.test")).id;
  const plain = (await accountForDevSignIn(store, "customer@example.test")).id;
  const granted = await setOperator(store, {
    email: "nil@example.test",
    on: true,
    actor: "cli:test",
  });
  expect(granted.ok).toBe(true);
  return { operator, plain };
}

describe("the operator flag", () => {
  test("a sign-in cannot self-assign it", async () => {
    const store = await tempStore();
    // Both providers land on the same account creation path, and it writes 0.
    const account = await accountForDevSignIn(store, "someone@example.test");
    expect(account.is_operator).toBe(0);
    expect(await isOperator(store, account.id)).toBe(false);
    await store.close();
  });

  test("granting is audited, idempotent, and reversible", async () => {
    const store = await tempStore();
    const { operator } = await seed(store);
    expect(await isOperator(store, operator)).toBe(true);
    const again = await setOperator(store, {
      email: "nil@example.test",
      on: true,
      actor: "cli:test",
    });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(
      (await store.auditEvents()).filter((e) => e.action === "grant_operator"),
    ).toHaveLength(1);

    await setOperator(store, {
      email: "nil@example.test",
      on: false,
      actor: "cli:test",
    });
    expect(await isOperator(store, operator)).toBe(false);
    expect(
      (await store.auditEvents()).some((e) => e.action === "revoke_operator"),
    ).toBe(true);
    await store.close();
  });

  test("an unknown address is refused rather than creating an operator", async () => {
    const store = await tempStore();
    const outcome = await setOperator(store, {
      email: "nobody@example.test",
      on: true,
      actor: "cli:test",
    });
    expect(outcome).toMatchObject({ ok: false });
    await store.close();
  });
});

describe("every ops service gates on the column itself", () => {
  test("a non-operator gets the same answer a missing office gets", async () => {
    const store = await tempStore();
    const { plain } = await seed(store);
    // Null, not a refusal object: a 403 would confirm the floor exists and that
    // this account is not on it.
    expect(await opsFloor(store, plain)).toBeNull();
    expect(await opsInstance(store, plain, "inst-1")).toBeNull();
    expect(await acknowledgeInstance(store, plain, "inst-1")).toBeNull();
    await store.close();
  });

  test("revoking the flag closes every verb, on the next call", async () => {
    const store = await tempStore();
    const { operator } = await seed(store);
    expect(await opsFloor(store, operator)).not.toBeNull();
    await setOperator(store, {
      email: "nil@example.test",
      on: false,
      actor: "cli:test",
    });
    // The check is INSIDE each service and re-reads the account, so authority
    // that is taken away is gone immediately rather than at the next page load.
    expect(await opsFloor(store, operator)).toBeNull();
    expect(await opsInstance(store, operator, "inst-1")).toBeNull();
    expect(await acknowledgeInstance(store, operator, "inst-1")).toBeNull();
    await store.close();
  });

  test("THE ROLE IS READ INSIDE THE TRANSACTION THAT DOES THE WORK", async () => {
    // A role read that commits separately from the work it guards is a role
    // that can be revoked in between while the protected read still goes
    // through. This observes the accounts query directly: it must happen with a
    // transaction already open.
    const store = await tempStore();
    const { operator } = await seed(store);
    const inside: boolean[] = [];
    // The SAME observation as before the async flip, moved to the public SQL
    // primitive because the engine handle is private now: the operator read is
    // a sqlGet, and what is asserted is still that it happens with a
    // transaction already open.
    const realGet = store.sqlGet.bind(store);
    store.sqlGet = (async (sql: string, args?: unknown[]) => {
      if (sql.includes("is_operator from accounts")) {
        inside.push(store.inTransaction());
      }
      return realGet(sql, args as never);
    }) as unknown as typeof store.sqlGet;

    try {
      await opsFloor(store, operator);
      await opsInstance(store, operator, "inst-1");
      await acknowledgeInstance(store, operator, "inst-1");
    } finally {
      store.sqlGet = realGet;
    }
    expect(inside).toEqual([true, true, true]);
    await store.close();
  });

  test("a revoke cannot land between the check and the work", async () => {
    // The seam itself, from a SECOND connection: while a verb holds its
    // transaction, a competing revoke cannot commit, so no protected read can
    // straddle one. `begin immediate` is what makes that true rather than
    // hoped for.
    const store = await tempStore();
    const { operator } = await seed(store);
    const file = store.file;
    let revokeOutcome = "not attempted";
    const realList = store.listInstances.bind(store);
    store.listInstances = () => {
      // Mid-work, from outside this transaction. Still a raw second connection
      // on purpose: the point is a competing writer that is not this Store.
      const other = new Database(file);
      other.run("pragma busy_timeout = 100");
      try {
        other.run("update accounts set is_operator = 0 where id = ?", [
          operator,
        ]);
        revokeOutcome = "committed";
      } catch (err) {
        revokeOutcome = (err as { code?: string }).code ?? "refused";
      }
      other.close();
      return realList();
    };

    let floor;
    try {
      floor = await opsFloor(store, operator);
    } finally {
      store.listInstances = realList;
    }
    expect(revokeOutcome).not.toBe("committed");
    // And the read that was already authorised completed coherently.
    expect(floor).not.toBeNull();
    expect(await isOperator(store, operator)).toBe(true);
    await store.close();
  });

  test("an unknown account id is not an operator", async () => {
    const store = await tempStore();
    await seed(store);
    expect(await opsFloor(store, "acct-nonexistent")).toBeNull();
    await store.close();
  });
});

describe("what the floor shows", () => {
  test("open attention, worst first, with the operator-facing reason", async () => {
    const store = await tempStore();
    const { operator } = await seed(store);
    await raiseAttention(store, {
      instanceId: "inst-1",
      reasonClass: "inactivity_deadline",
      sourceOpId: "op-a",
      reason: "the installer has been on the same step for ten minutes",
      severity: "warning",
    });
    await raiseAttention(store, {
      instanceId: "inst-1",
      reasonClass: "operation_condition",
      sourceOpId: "op-b",
      reason: "REVOCATION NOT PROVEN: the box still accepts the removed key",
      severity: "critical",
    });
    const floor = (await opsFloor(store, operator))!;
    expect(floor.attention).toHaveLength(2);
    // Worst first.
    expect(floor.attention[0].severity).toBe("critical");
    // The STRING, unlike the customer projection's reason class. This is the
    // audience it was written for.
    expect(floor.attention[0].reason).toContain("REVOCATION NOT PROVEN");
    expect(floor.attention[0].ageMs).toBe(0);
    await store.close();
  });

  test("a FAILED operation past its ceiling is still on the floor", async () => {
    // liveOperations excludes terminal rows, so scanning it hid exactly the
    // operation an operator most needs: one that blew its ceiling and then
    // failed. Succeeded work stays out - a step that finished late is history.
    const store = await tempStore();
    const { operator } = await seed(store);
    for (const [id, kind, status] of [
      ["op-dead", "revoke_access", "failed"],
      ["op-old", "run_installer", "succeeded"],
    ] as const) {
      const op = await store.enqueue({
        id,
        instance_id: "inst-1",
        kind,
        inactivity_deadline_at: NOW - 20_000,
        absolute_deadline_at: NOW - 10_000,
      });
      await store.flagDeadline(op.id, op.version, "absolute", NOW);
      await store.sqlRun("update operations set status = ? where id = ?", [
        status,
        id,
      ]);
    }
    const floor = (await opsFloor(store, operator))!;
    expect(floor.overdue.map((o) => o.operationId)).toEqual(["op-dead"]);
    expect(floor.overdue[0].status).toBe("failed");
    await store.close();
  });

  test("operations past their ABSOLUTE ceiling, and only those", async () => {
    const store = await tempStore();
    const { operator } = await seed(store);
    const late = await store.enqueue({
      id: "op-late",
      instance_id: "inst-1",
      kind: "revoke_access",
      inactivity_deadline_at: NOW - 20_000,
      absolute_deadline_at: NOW - 10_000,
    });
    await store.enqueue({
      id: "op-fine",
      instance_id: "inst-1",
      kind: "reboot",
      inactivity_deadline_at: NOW + 10_000,
      absolute_deadline_at: NOW + 20_000,
    });
    // Not flagged yet: the floor reads the FLAG the ticker writes, not the
    // clock, so an operator and the machine agree on what is overdue.
    expect((await opsFloor(store, operator))!.overdue).toEqual([]);
    await store.flagDeadline(late.id, late.version, "absolute", NOW);
    const floor = (await opsFloor(store, operator))!;
    expect(floor.overdue.map((o) => o.operationId)).toEqual(["op-late"]);
    expect(floor.overdue[0].overdueMs).toBe(10_000);
    await store.close();
  });

  test("one office carries its attention history, operations and audit", async () => {
    const store = await tempStore();
    const { operator } = await seed(store);
    await raiseAttention(store, {
      instanceId: "inst-1",
      reasonClass: "operation_condition",
      sourceOpId: "op-a",
      reason: "a thing happened",
      severity: "info",
    });
    const view = (await opsInstance(store, operator, "inst-1"))!;
    expect(view.officeName).toBe("cp2.test.isomux.app");
    expect(view.attention).toHaveLength(1);
    expect(view.audit.some((e) => e.action === "raise_attention")).toBe(true);
    // Its audit only, never another office's.
    expect(view.audit.every((e) => e.instance_id === "inst-1")).toBe(true);
    await store.close();
  });

  test("an office that does not exist is null even for an operator", async () => {
    const store = await tempStore();
    const { operator } = await seed(store);
    expect(await opsInstance(store, operator, "inst-nope")).toBeNull();
    expect(await acknowledgeInstance(store, operator, "inst-nope")).toBeNull();
    await store.close();
  });
});

describe("acknowledging", () => {
  test("it marks the reasons, writes audit, and does NOT clear them", async () => {
    const store = await tempStore();
    const { operator } = await seed(store);
    await raiseAttention(store, {
      instanceId: "inst-1",
      reasonClass: "absolute_deadline",
      sourceOpId: "op-a",
      reason: "a step passed its ceiling",
      severity: "warning",
    });
    expect(await acknowledgeInstance(store, operator, "inst-1")).toBe(1);

    const floor = (await opsFloor(store, operator))!;
    // Still open. An ack that cleared would let "I saw it" pass for "it is
    // fixed", which is exactly the lie a tired operator would act on.
    expect(floor.attention).toHaveLength(1);
    expect(floor.attention[0].acknowledgedAt).toBe(NOW);
    expect(floor.attention[0].acknowledgedBy).toBe(`account:${operator}`);
    expect((await store.getInstance("inst-1"))!.attention_state).toBe(
      "needs_operator",
    );
    expect(
      (await store.auditEvents()).some(
        (e) =>
          e.action === "acknowledge_attention" &&
          e.actor === `account:${operator}`,
      ),
    ).toBe(true);
    await store.close();
  });

  test("acknowledging nothing says so rather than pretending", async () => {
    const store = await tempStore();
    const { operator } = await seed(store);
    expect(await acknowledgeInstance(store, operator, "inst-1")).toBe(0);
    await store.close();
  });
});
