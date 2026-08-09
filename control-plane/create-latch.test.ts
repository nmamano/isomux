// The money path. Everything here is about one question: can a second paid
// create happen? The answer has to be no at every instruction boundary, so the
// tests are written as crash points and races rather than as happy paths.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CreateCoordinator } from "./create-coordinator.ts";
import {
  CREATE_ARMED_PHASE,
  CreateLatch,
  CreatePermit,
  FenceLostError,
  LatchRefused,
  migrateLegacyIntents,
} from "./create-latch.ts";
import { IntentJournal } from "./intents.ts";
import { createInstanceHandler } from "./handlers.ts";
import { Reporter } from "./report.ts";
import { Store, type Fence } from "./store.ts";
import { Ticker } from "./tick.ts";
import type {
  CreateOutcome,
  CreateRequest,
  FindResult,
  ProviderAdapter,
} from "./provider.ts";

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-latch-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAdapter(
  overrides: Partial<ProviderAdapter> = {},
): ProviderAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async create(): Promise<CreateOutcome> {
      calls.push("create");
      return { outcome: "created", providerId: "999" };
    },
    async find(): Promise<FindResult | null> {
      calls.push("find");
      return null;
    },
    get: () => Promise.reject(new Error("not used")),
    reboot: () => Promise.reject(new Error("not used")),
    powerOff: () => Promise.reject(new Error("not used")),
    powerOn: () => Promise.reject(new Error("not used")),
    cancel: () => Promise.reject(new Error("not used")),
    ...overrides,
  };
}

interface Bed {
  store: Store;
  dir: string;
  instanceId: string;
  opId: string;
  fence: Fence;
}

function bed(): Bed {
  const dir = tempDir();
  const store = new Store(path.join(dir, "cp.db"));
  store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal: "live",
    access_window_expires_at: null,
  });
  const op = store.enqueue({
    id: "op-create",
    instance_id: "inst-1",
    kind: "create_instance",
    inactivity_deadline_at: store.now() + 900_000,
    absolute_deadline_at: store.now() + 900_000,
  });
  const now = store.now();
  const leased = store.tryLease(
    op.id,
    op.version,
    "holder-a",
    now + 60_000,
    now,
  )!;
  return {
    store,
    dir,
    instanceId: "inst-1",
    opId: op.id,
    fence: { id: op.id, version: leased.version, holder: "holder-a" },
  };
}

const REQ: CreateRequest = {
  intentId: "intent-1",
  plan: "V153",
  region: "EU",
  publicKeys: [1],
};

describe("the latch", () => {
  test("the INSERT is the check: a second arm for the same intent is refused", () => {
    const b = bed();
    const latch = new CreateLatch(b.store);
    const first = latch.armOnce(REQ, b.fence);
    expect(first.permit).toBeInstanceOf(CreatePermit);
    const next: Fence = {
      id: b.opId,
      version: first.armed.version,
      holder: "holder-a",
    };
    expect(() => latch.armOnce(REQ, next)).toThrow(LatchRefused);
    expect(b.store.listIntents()).toHaveLength(1);
  });

  test("arming writes the intent and the operation evidence in ONE transaction", () => {
    const b = bed();
    const { armed } = new CreateLatch(b.store).armOnce(REQ, b.fence);
    expect(b.store.getIntent("intent-1")?.state).toBe("intended");
    expect(JSON.parse(armed.evidence).phase).toBe(CREATE_ARMED_PHASE);
  });

  test("a stale fence rolls the intent back, so nothing is latched and nothing was sent", () => {
    const b = bed();
    const stale: Fence = { ...b.fence, version: b.fence.version - 1 };
    expect(() => new CreateLatch(b.store).armOnce(REQ, stale)).toThrow(
      FenceLostError,
    );
    // The rollback is the point: an intent latched against an operation we do
    // not hold would forbid a create that never reached the provider.
    expect(b.store.getIntent("intent-1")).toBeNull();
    expect(() => new CreateLatch(b.store).armOnce(REQ, b.fence)).not.toThrow();
  });

  test("two contenders on one pre-read: one winner row, one call, no partial loser", async () => {
    const b = bed();
    const adapter = fakeAdapter();
    const latch = new CreateLatch(b.store);
    const coordinator = new CreateCoordinator(adapter, latch, b.store);
    // ONE pre-read shared by both contenders, no serialising read between them.
    const results = await Promise.allSettled([
      coordinator.armAndCreate(REQ, b.fence),
      coordinator.armAndCreate(REQ, b.fence),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(adapter.calls.filter((c) => c === "create")).toHaveLength(1);
    const intents = b.store.listIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0]?.state).toBe("created");
    // The loser left nothing behind: exactly one arming was ever audited.
    const arms = b.store.auditEvents().filter((e) => e.action === "arm_create");
    expect(arms).toHaveLength(1);
  });
});

describe("the permit", () => {
  test("is single use", () => {
    const b = bed();
    const { permit } = new CreateLatch(b.store).armOnce(REQ, b.fence);
    permit.consume();
    expect(() => permit.consume()).toThrow(LatchRefused);
  });

  test("cannot be minted from outside the latch", () => {
    expect(() => CreatePermit.mint("intent-1", Symbol("forged"))).toThrow(
      /minted only by CreateLatch/,
    );
  });
});

describe("the legacy journal can only veto", () => {
  test("a journal record forbids the create even with an empty database", () => {
    const b = bed();
    const journalDir = path.join(b.dir, "intents");
    const journal = new IntentJournal(journalDir);
    journal.reserve("intent-1", { plan: "V153", region: "EU" });
    const latch = new CreateLatch(b.store, journal);
    expect(() => latch.armOnce(REQ, b.fence)).toThrow(LatchRefused);
    expect(b.store.getIntent("intent-1")).toBeNull();
  });

  test("an unreadable journal record throws rather than reading as absent", () => {
    const b = bed();
    const journalDir = path.join(b.dir, "intents");
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, "intent-1.json"), "{not json");
    const latch = new CreateLatch(b.store, new IntentJournal(journalDir));
    expect(() => latch.armOnce(REQ, b.fence)).toThrow();
    expect(b.store.getIntent("intent-1")).toBeNull();
  });
});

describe("legacy migration", () => {
  test("imports a readable record", () => {
    const b = bed();
    const dir = path.join(b.dir, "intents");
    new IntentJournal(dir).reserve("old-1", { plan: "V153", region: "EU" });
    expect(migrateLegacyIntents(b.store, dir)).toBe(1);
    expect(b.store.getIntent("old-1")?.state).toBe("intended");
  });

  test("a corrupt record still forbids, using the id from the filename", () => {
    const b = bed();
    const dir = path.join(b.dir, "intents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old-2.json"), "garbage");
    migrateLegacyIntents(b.store, dir);
    const row = b.store.getIntent("old-2");
    expect(row?.state).toBe("ambiguous");
    expect(row?.reason).toBe("legacy journal record unreadable");
  });

  test("an unrecognised state imports as ambiguous rather than being trusted", () => {
    const b = bed();
    const dir = path.join(b.dir, "intents");
    fs.mkdirSync(dir, { recursive: true });
    // Valid JSON, meaningless state. A legacy file is bytes on disk, and the
    // column's type is a claim about our own writes, not about theirs.
    fs.writeFileSync(
      path.join(dir, "old-4.json"),
      JSON.stringify({ intentId: "old-4", state: "probably-fine", plan: 7 }),
    );
    migrateLegacyIntents(b.store, dir);
    const row = b.store.getIntent("old-4");
    expect(row?.state).toBe("ambiguous");
    expect(row?.reason).toMatch(/not recognised/);
    // And a non-string plan does not travel into the row either.
    expect(row?.plan).toBe("unknown");
  });

  test("migration never deletes or rewrites the legacy evidence", () => {
    const b = bed();
    const dir = path.join(b.dir, "intents");
    new IntentJournal(dir).reserve("old-3", { plan: "V153", region: "EU" });
    const before = fs.readFileSync(path.join(dir, "old-3.json"), "utf8");
    migrateLegacyIntents(b.store, dir);
    expect(fs.readFileSync(path.join(dir, "old-3.json"), "utf8")).toBe(before);
  });

  test("a directory that cannot be enumerated refuses to open the store", () => {
    const b = bed();
    const dir = path.join(b.dir, "locked");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o000);
    try {
      expect(() => migrateLegacyIntents(b.store, dir)).toThrow(
        /cannot be read/,
      );
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  test("an absent directory is simply nothing to import", () => {
    const b = bed();
    expect(migrateLegacyIntents(b.store, path.join(b.dir, "nope"))).toBe(0);
  });
});

describe("the outcome transaction", () => {
  test("losing the fence after the call rolls EVERYTHING back", async () => {
    const b = bed();
    const store = b.store;
    const adapter = fakeAdapter({
      async create(): Promise<CreateOutcome> {
        // While we are at the remote seam, another holder adopts the lease.
        const op = store.getOperation(b.opId)!;
        store.tryLease(
          op.id,
          op.version,
          "holder-b",
          store.now() + 60_000,
          store.now() + 999_999,
        );
        return { outcome: "created", providerId: "777" };
      },
    });
    const coordinator = new CreateCoordinator(
      adapter,
      new CreateLatch(store),
      store,
    );
    const settling = coordinator.armAndCreate(REQ, b.fence, () => {
      store.createAsset({
        id: "asset-should-not-exist",
        instance_id: b.instanceId,
        provider: "contabo",
        provider_id: "777",
        intent_id: "intent-1",
        asset_state: "active",
        ipv4: null,
        service_ends_at: null,
        host_key_fingerprint: null,
        next_reconcile_at: 0,
      });
    });
    let thrown: unknown;
    try {
      await settling;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FenceLostError);

    // The intent stays at `intended` and the operation stays armed: the state
    // whose only legal next act is find. And the settle callback's asset write
    // is gone with the rest.
    expect(store.getIntent("intent-1")?.state).toBe("intended");
    expect(JSON.parse(store.getOperation(b.opId)!.evidence).phase).toBe(
      CREATE_ARMED_PHASE,
    );
    expect(store.getAsset("asset-should-not-exist")).toBeNull();
  });

  test("an intent may never be written back to `intended`", () => {
    const b = bed();
    new CreateLatch(b.store).armOnce(REQ, b.fence);
    const row = b.store.getIntent("intent-1")!;
    expect(() =>
      b.store.casIntent("intent-1", row.version, { state: "intended" }),
    ).toThrow(/never be returned/);
  });
});

describe("restart after a real crash", () => {
  test("a persisted armed row can never reach adapter.create again", async () => {
    const b = bed();
    const dbPath = path.join(b.dir, "cp.db");
    // Hand the row over unleased: the child process is the holder in this
    // story, and it is the one whose death has to be survivable.
    b.store.casOperation(b.fence, { lease_until: null, lease_holder: null });
    b.store.close();

    // A REAL child process arms the create and dies inside the provider call.
    const child = Bun.spawn(
      [
        "bun",
        path.join(import.meta.dir, "fixtures", "arm-and-hang.ts"),
        dbPath,
        b.opId,
        "intent-1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("ARMED")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    expect(seen).toContain("ARMED");
    child.kill(9);
    await child.exited;

    // Everything below comes from the file. Nothing carries the capability.
    const store = new Store(dbPath);
    expect(store.getIntent("intent-1")?.state).toBe("intended");
    expect(JSON.parse(store.getOperation(b.opId)!.evidence).phase).toBe(
      CREATE_ARMED_PHASE,
    );

    const adapter = fakeAdapter({
      create(): Promise<CreateOutcome> {
        throw new Error("a restart reached create; the latch did not hold");
      },
    });
    const coordinator = new CreateCoordinator(
      adapter,
      new CreateLatch(store),
      store,
    );
    const ticker = new Ticker({
      store,
      handlers: [
        createInstanceHandler({
          exec: { run: () => Promise.reject(new Error("no ssh here")) },
          reporter: new Reporter({ out: () => {}, err: () => {} }),
          runsDir: b.dir,
          keysDir: b.dir,
          coordinator,
          createRequest: () => REQ,
        }),
      ],
      holder: "restarted",
    });

    // Wait out the dead holder's lease, then tick repeatedly.
    await Bun.sleep(1200);
    for (let i = 0; i < 4; i++) await ticker.once();

    expect(adapter.calls).not.toContain("create");
    expect(adapter.calls.filter((c) => c === "find").length).toBeGreaterThan(0);
    expect(store.listIntents()).toHaveLength(1);
    expect(store.getInstance(b.instanceId)?.service_state).toBe("provisioning");
  }, 20_000);
});

describe("the armed phase is defence in depth, and it is pinned", () => {
  test("evidence alone forces find-only, even with no intent row at all", async () => {
    const b = bed();
    // The operation says it armed; the intent row is not there. That pairing is
    // reachable if a settle transaction rolled back after the call, and it must
    // read as "the paid call may have happened" rather than as "nothing
    // happened yet". The intent-state clause cannot help here, so this is what
    // holds the phase clause up.
    b.store.casOperation(b.fence, {
      evidence: { phase: CREATE_ARMED_PHASE, intentId: "intent-1" },
    });
    expect(b.store.getIntent("intent-1")).toBeNull();

    const adapter = fakeAdapter({
      create(): Promise<CreateOutcome> {
        throw new Error("reached create with an armed operation");
      },
    });
    const ticker = new Ticker({
      store: b.store,
      handlers: [
        createInstanceHandler({
          exec: { run: () => Promise.reject(new Error("no ssh here")) },
          reporter: new Reporter({ out: () => {}, err: () => {} }),
          runsDir: b.dir,
          keysDir: b.dir,
          coordinator: new CreateCoordinator(
            adapter,
            new CreateLatch(b.store),
            b.store,
          ),
          createRequest: () => REQ,
        }),
      ],
      holder: "restarted",
    });
    b.store.casOperation(
      { ...b.fence, version: b.store.getOperation(b.opId)!.version },
      { lease_until: null, lease_holder: null },
    );
    await ticker.once();
    expect(adapter.calls).not.toContain("create");
    expect(adapter.calls).toContain("find");
  });
});

describe("adoption never certifies a box it cannot name", () => {
  async function adoptWith(
    b: Bed,
    found: { providerId: string; confidence: "exact" | "unproven" } | null,
    prepare?: (store: Store) => void,
  ) {
    b.store.casOperation(b.fence, {
      status: "ambiguous",
      evidence: { phase: "quarantine", intentId: "intent-1" },
      lease_until: null,
      lease_holder: null,
    });
    prepare?.(b.store);
    const adapter = fakeAdapter({
      find: () => Promise.resolve(found),
    });
    const ticker = new Ticker({
      store: b.store,
      handlers: [
        createInstanceHandler({
          exec: { run: () => Promise.reject(new Error("no ssh here")) },
          reporter: new Reporter({ out: () => {}, err: () => {} }),
          runsDir: b.dir,
          keysDir: b.dir,
          coordinator: new CreateCoordinator(
            adapter,
            new CreateLatch(b.store),
            b.store,
          ),
          createRequest: () => REQ,
        }),
      ],
      holder: "adopter",
    });
    await ticker.once();
    return b.store.getOperation(b.opId)!;
  }

  test("an exact match with no provider id does not advance the chain", async () => {
    const b = bed();
    const op = await adoptWith(b, { providerId: "", confidence: "exact" });
    expect(op.status).toBe("ambiguous");
    expect(b.store.getInstance(b.instanceId)?.attention_state).toBe(
      "needs_operator",
    );
  });

  test("a conflicting existing asset is never silently replaced", async () => {
    const b = bed();
    const op = await adoptWith(
      b,
      { providerId: "999", confidence: "exact" },
      (store) => {
        store.createAsset({
          id: "asset-existing",
          instance_id: "inst-1",
          provider: "contabo",
          provider_id: "111",
          intent_id: null,
          asset_state: "active",
          ipv4: null,
          service_ends_at: null,
          host_key_fingerprint: null,
          next_reconcile_at: 0,
        });
      },
    );
    // Two boxes for one instance is the failure class the create path exists to
    // prevent: it raises a human rather than picking one.
    expect(op.status).toBe("ambiguous");
    expect(b.store.assetForInstance("inst-1")?.provider_id).toBe("111");
    expect(
      b.store
        .openReasons("inst-1")
        .some((r) => /refusing to replace/.test(r.reason)),
    ).toBe(true);
  });
});

describe("one call site", () => {
  test("adapter.create is called from exactly one file", async () => {
    const dir = import.meta.dir;
    const hits: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const body = fs.readFileSync(path.join(dir, name), "utf8");
      // Specific to the adapter seam: an ordinary `.create(` elsewhere (a store
      // row, a key secret) is not the thing being bounded here.
      if (/\badapter\.create\(/.test(body)) hits.push(name);
    }
    expect(hits).toEqual(["create-coordinator.ts"]);
  });
});
