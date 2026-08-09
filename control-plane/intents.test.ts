import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IntentJournal } from "./intents.ts";
import { ContaboAdapter } from "./contabo/adapter.ts";
import { CreateCoordinator } from "./create-coordinator.ts";
import type {
  CreateOutcome,
  CreateRequest,
  ProviderAdapter,
} from "./provider.ts";
import { ContaboHttp } from "./contabo/http.ts";
import { TokenProvider, type FetchLike } from "./contabo/auth.ts";

/** Run something expected to fail and return its message. */
async function captureError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "(no error thrown)";
}

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-cp-intents-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the pre-call latch", () => {
  test("an unlatched intent may create; a latched one never may again", () => {
    const j = new IntentJournal(dir);
    expect(j.canCreate("i1")).toBe(true);
    j.latchBeforeCreate("i1", { plan: "V153", region: "EU" });
    expect(j.canCreate("i1")).toBe(false);
  });

  test("latching twice is refused rather than silently allowed", () => {
    const j = new IntentJournal(dir);
    j.latchBeforeCreate("i1", { plan: "V153", region: "EU" });
    expect(() =>
      j.latchBeforeCreate("i1", { plan: "V153", region: "EU" }),
    ).toThrow(/permanently forbidden/);
  });

  test("even a clean rejection does not unlock the intent", () => {
    const j = new IntentJournal(dir);
    j.latchBeforeCreate("i1", { plan: "V153", region: "EU" });
    j.recordOutcome("i1", { state: "rejected", reason: "HTTP 400" });
    // A rejection spent nothing, but retrying through the SAME intent is how a
    // second paid box gets ordered when the rejection classification was wrong.
    expect(j.canCreate("i1")).toBe(false);
  });

  test("a latched-but-unresolved intent is reported as pending, for find/list only", () => {
    const j = new IntentJournal(dir);
    j.latchBeforeCreate("i1", { plan: "V153", region: "EU" });
    j.latchBeforeCreate("i2", { plan: "V153", region: "EU" });
    j.recordOutcome("i2", { state: "created", providerId: "9" });
    expect(j.pending().map((r) => r.intentId)).toEqual(["i1"]);
  });
});

// M5. The rule has to survive process loss, not just a second call in one
// process. Death between Contabo accepting the order and our result write is
// the exact window a paid duplicate hides in.
describe("M5: death at the network boundary", () => {
  test("a fresh journal built after a crash mid-call still refuses to create", async () => {
    const journal = new IntentJournal(dir);
    const intentId = "crash1";

    // A transport that dies once the request has been handed to the network.
    const fetchImpl: FetchLike = (url) => {
      if (url.includes("/v1/compute/instances")) {
        throw new Error("process died after the request was sent");
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
      });
    };
    const adapter = new ContaboAdapter({
      http: new ContaboHttp({
        fetchImpl,
        tokens: new TokenProvider(
          { clientId: "c", clientSecret: "s", apiUser: "u", apiPassword: "p" },
          fetchImpl,
        ),
      }),
      imageId: "img",
      loginUser: "root",
    });

    // Pre-call latch, fsynced, THEN the call. The call dies and nothing is
    // written afterwards - which is the whole point of latching first.
    journal.latchBeforeCreate(intentId, { plan: "V153", region: "EU" });
    await adapter
      .create({ intentId, plan: "V153", region: "EU", publicKeys: [1] })
      .catch(() => undefined);

    // Process loss: discard every in-memory object and rebuild from disk.
    const afterRestart = new IntentJournal(dir);
    expect(afterRestart.canCreate(intentId)).toBe(false);
    expect(afterRestart.pending().map((r) => r.intentId)).toEqual([intentId]);
    expect(afterRestart.read(intentId)?.state).toBe("intended");
  });

  test("the latch is on disk before the call could possibly have been made", () => {
    const journal = new IntentJournal(dir);
    journal.latchBeforeCreate("ordering", { plan: "V153", region: "EU" });
    // Read the bytes, not the object: the guarantee is durability, not that we
    // remember having latched.
    const raw = fs.readFileSync(path.join(dir, "ordering.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      intentId: "ordering",
      state: "intended",
    });
  });
});

// An unreadable journal must never read as "no record here". That would turn a
// permissions slip or a corrupt file into permission to buy another box, which
// is the single outcome this file exists to prevent.
describe("failing closed", () => {
  test("a corrupt journal throws rather than reporting absence", () => {
    const j = new IntentJournal(dir);
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{ not json");
    expect(() => j.canCreate("corrupt")).toThrow(/corrupt/i);
  });

  test("an unreadable journal throws rather than reporting absence", () => {
    const j = new IntentJournal(dir);
    const f = path.join(dir, "locked.json");
    fs.writeFileSync(
      f,
      JSON.stringify({ intentId: "locked", state: "intended" }),
    );
    fs.chmodSync(f, 0o000);
    try {
      expect(() => j.canCreate("locked")).toThrow(/unreadable/i);
    } finally {
      fs.chmodSync(f, 0o600);
    }
  });

  test("a genuinely absent record is the ONLY thing that reads as absent", () => {
    expect(new IntentJournal(dir).canCreate("never-seen")).toBe(true);
  });
});

// Two workers can both observe "no record" before either writes. The
// reservation therefore has to be the filesystem's decision, not ours.
describe("single writer", () => {
  test("only one of two racing reservations can win", () => {
    const a = new IntentJournal(dir);
    const b = new IntentJournal(dir);
    const meta = { plan: "V153", region: "EU" };
    // reserve() DIRECTLY, with no prior read - which is the whole point. Going
    // through latchBeforeCreate would have b read the record a just wrote and
    // fail on the read-check, proving nothing about the race this guards. Both
    // workers here have already read "absent"; the filesystem is the only thing
    // left to arbitrate.
    a.reserve("raced", meta);
    expect(() => b.reserve("raced", meta)).toThrow(/permanently forbidden/);
  });

  test("the loser leaves the winner's record untouched", () => {
    const a = new IntentJournal(dir);
    const b = new IntentJournal(dir);
    a.reserve("raced2", { plan: "V153", region: "EU" }, 111);
    try {
      b.reserve("raced2", { plan: "OTHER", region: "US-west" }, 222);
    } catch {
      // expected
    }
    const rec = a.read("raced2");
    expect(rec?.plan).toBe("V153");
    expect(rec?.latchedAt).toBe(111);
  });
});

// The coordinator is the only seam that may spend money. Calling the adapter
// directly is what the reviewer called "testing discipline rather than
// enforcing the invariant", so the invariant lives here now.
describe("CreateCoordinator", () => {
  function fakeAdapter(outcome: CreateOutcome, calls: string[] = []) {
    return {
      calls,
      create: (req: CreateRequest) => {
        calls.push(req.intentId);
        return Promise.resolve(outcome);
      },
      find: () => Promise.resolve(null),
    } as unknown as ProviderAdapter & { calls: string[] };
  }

  test("latches before calling, and records what the call did", async () => {
    const journal = new IntentJournal(dir);
    const adapter = fakeAdapter({ outcome: "created", providerId: "77" });
    const coord = new CreateCoordinator(adapter, journal);
    const out = await coord.create({
      intentId: "c1",
      plan: "V153",
      region: "EU",
      publicKeys: [1],
    });
    expect(out).toEqual({ outcome: "created", providerId: "77" });
    expect(journal.read("c1")?.state).toBe("created");
    expect(journal.canCreate("c1")).toBe(false);
  });

  test("a second create for the same intent never reaches the provider", async () => {
    const journal = new IntentJournal(dir);
    const calls: string[] = [];
    const adapter = fakeAdapter({ outcome: "ambiguous", reason: "5xx" }, calls);
    const coord = new CreateCoordinator(adapter, journal);
    const req = { intentId: "c2", plan: "V153", region: "EU", publicKeys: [1] };
    await coord.create(req);
    expect(calls).toHaveLength(1);
    expect(await captureError(() => coord.create(req))).toMatch(
      /permanently forbidden/,
    );
    // The adapter was never reached the second time - no second paid call.
    expect(calls).toHaveLength(1);
  });

  test("an adapter that THROWS still leaves the intent latched as ambiguous", async () => {
    const journal = new IntentJournal(dir);
    const adapter = {
      create: () => Promise.reject(new Error("socket hang up")),
      find: () => Promise.resolve(null),
    } as unknown as ProviderAdapter;
    const coord = new CreateCoordinator(adapter, journal);
    expect(
      await captureError(() =>
        coord.create({
          intentId: "c3",
          plan: "V153",
          region: "EU",
          publicKeys: [1],
        }),
      ),
    ).toMatch(/socket hang up/);
    // A throw is not evidence that nothing was ordered.
    expect(journal.read("c3")?.state).toBe("ambiguous");
    expect(journal.canCreate("c3")).toBe(false);
  });
});
