// App tokens: the persisted, hash-only store; the identity it resolves to; and
// the boot pass that keeps a hash and the plaintext an app is actually handed
// from drifting apart.
//
// The properties worth breaking a build over, all asserted below:
//   - the plaintext is NEVER on disk in the store (only in the app's own
//     environment file, which is the supervisor's business);
//   - a corrupt store denies rather than resolving, and REFUSES TO BE WRITTEN,
//     because a full-file rewrite over an unreadable one silently revokes every
//     other app's token;
//   - a hash and an environment file are a pair: reconciliation checks them
//     against each other by HASHING the plaintext, not by checking that both
//     exist, and it restarts only a running app whose token changed.
//
// Pure T0: a temp directory, no server, no systemd, no LLM.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appIdentityFromToken,
  createAppTokenStore,
  type AppTokenStore,
} from "./app-tokens.ts";
import { reconcileAppTokens } from "./app-token-reconcile.ts";
import { APP_CAPABILITIES } from "./identity/index.ts";
import type { AppRecord } from "../shared/types.ts";

let dir = "";
const tokenFile = () => join(dir, "app-tokens.json");
const store = (over: Parameters<typeof createAppTokenStore>[0] = {}) =>
  createAppTokenStore({ dir, now: () => 1000, ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isomux-app-tokens-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const record = (over: Partial<AppRecord> = {}): AppRecord => ({
  name: "hello",
  hostLabel: "hello",
  hostGen: 1,
  port: 21000,
  command: "bun run serve.ts",
  cwd: "/srv/hello",
  dataDir: "/state/apps/data/hello",
  userId: "u-alice",
  username: "alice",
  createdBy: "AppBot",
  createdAt: 1,
  ...over,
});

// --- the store --------------------------------------------------------------

describe("app-tokens: mint, resolve, revoke", () => {
  it("writes the store 0600 in a directory it creates 0700", () => {
    const sub = join(dir, "apps");
    createAppTokenStore({ dir: sub }).mint("hello", "u-alice");
    expect(statSync(join(sub, "app-tokens.json")).mode & 0o777).toBe(0o600);
    expect(statSync(sub).mode & 0o777).toBe(0o700);
  });

  it("mints a token an environment file can hold verbatim", () => {
    // base64url only. A value needing systemd's quoting would come back from
    // the parser as something other than what was hashed - a token that never
    // works and says nothing about why.
    expect(store().mint("hello", null)).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("revoke ends the token and leaves the other apps alone", () => {
    const s = store();
    const gone = s.mint("alpha", "u-alice");
    const kept = s.mint("beta", "u-alice");
    // A mint keeps every other app's entry.
    expect(s.lookup(gone)?.appName).toBe("alpha");
    expect(s.lookup(kept)?.appName).toBe("beta");
    s.revoke("alpha");
    expect(s.lookup(gone)).toBeNull();
    expect(s.lookup(kept)?.appName).toBe("beta");
    s.revoke("alpha"); // idempotent
    expect(s.names()).toEqual(["beta"]);
  });

  it("resolves nothing for garbage, the empty string, or a hash presented as a token", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    expect(s.lookup("")).toBeNull();
    expect(s.lookup("not-a-real-token")).toBeNull();
    // Presenting the stored hash is the obvious attack when a hash-at-rest
    // store is readable by everything on the box.
    expect(s.lookup(createHash("sha256").update(raw).digest("hex"))).toBeNull();
  });

  it("matches() compares the PLAINTEXT against the stored hash", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    expect(s.matches("hello", raw)).toBe(true);
    expect(s.matches("hello", "something-else")).toBe(false);
    expect(s.matches("nobody", raw)).toBe(false);
  });
});

describe("app-tokens: a corrupt store denies and refuses to be overwritten", () => {
  it("denies even a valid token when another entry is damaged", () => {
    // The whole file is validated, so a reader that skipped the bad entry and
    // kept the rest would show here.
    const raw = store().mint("hello", "u-alice");
    const contents = JSON.parse(readFileSync(tokenFile(), "utf-8"));
    contents.other = { hash: "abc", userId: null, mintedAt: 1 };
    writeFileSync(tokenFile(), JSON.stringify(contents));
    expect(store().lookup(raw)).toBeNull();
    expect(store().matches("hello", raw)).toBe(false);
    expect(store().names()).toEqual([]);
  });

  it("refuses to mint over a corrupt store, leaving the file untouched", () => {
    // THE FAILURE THIS PREVENTS: mint reads, adds one entry and rewrites the
    // whole file. Treating an unreadable file as an empty one would rewrite it
    // with a single app in it - silently revoking every other app's token and
    // destroying the only copy of the evidence.
    const s = store();
    s.mint("alpha", "u-alice");
    const good = readFileSync(tokenFile(), "utf-8");
    writeFileSync(tokenFile(), good + "corrupted");

    expect(() => store().mint("beta", "u-bob")).toThrow();
    expect(readFileSync(tokenFile(), "utf-8")).toBe(good + "corrupted");
  });
});

// --- the identity -----------------------------------------------------------

describe("app-tokens: the identity a token resolves to", () => {
  // Which apps exist, stated explicitly - the resolver is injected precisely so
  // a token's meaning never depends on the production registry.
  const registered =
    (owners: Record<string, string | null>) => (name: string) =>
      name in owners ? { userId: owners[name] } : null;

  it("is APP scope, carries the app name and its owner, and holds only app:message", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    const identity = appIdentityFromToken(
      raw,
      s,
      registered({ hello: "u-alice" }),
    )!;

    expect(identity.scope).toBe("app");
    expect(identity.appName).toBe("hello");
    // Truthful, and never an authority: every guard is scope-gated, which the
    // guard matrix and the whole-table reachability test pin.
    expect(identity.userId).toBe("u-alice");
    expect(identity.role).toBe("member");
    expect(identity.capabilities).toEqual(APP_CAPABILITIES);
    expect(identity.agentId).toBeUndefined();
  });

  // TWO facts are required, and the store can only supply one of them. A hash
  // that outlived its app is not an identity: there is no such app to be, and a
  // caller isomux recognises but cannot describe is worse than a 401.
  it("is null when the hash matches but the app is no longer registered", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    // The store still holds the hash - this is not a revoke.
    expect(s.matches("hello", raw)).toBe(true);
    expect(appIdentityFromToken(raw, s, registered({}))).toBeNull();
  });

  // The OWNER is the live record's, not the token file's. Ownership is not
  // mutable today, so this pins intent rather than a reachable transition: the
  // identity's userId is documented as truthful attribution, and a mint-time
  // snapshot cannot promise that.
  it("takes the owner from the live app record, not from the stored snapshot", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    const identity = appIdentityFromToken(
      raw,
      s,
      registered({ hello: "u-someone-else" }),
    )!;
    expect(identity.userId).toBe("u-someone-else");
  });

  // A registry that cannot answer must not become an authorization decision of
  // the wrong sign - the same fail-closed posture the token store itself takes.
  it("is null when the registry throws (corrupt state denies, never resolves)", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    expect(
      appIdentityFromToken(raw, s, () => {
        throw new Error("registry is corrupt");
      }),
    ).toBeNull();
  });
});

// --- boot reconciliation ----------------------------------------------------

interface FakeSupervisorFiles {
  tokens: Map<string, string>;
  reloads: number;
  // Apps whose unit actually reads their token file. The third fact, and the
  // only way to construct the state that matters: a healthy pair behind a unit
  // that injects nothing.
  wired: Set<string>;
  regenerated: string[];
  removed: string[];
  states: Map<
    string,
    "running" | "starting" | "stopped" | "failed" | "unknown"
  >;
  restarted: string[];
  failProvision: boolean;
  failRegenerate: boolean;
  failRestart: boolean;
}

function reconcileDeps(
  apps: AppRecord[],
  tokens: AppTokenStore,
  files: FakeSupervisorFiles,
) {
  return {
    list: () => apps,
    tokens,
    readToken: (name: string) => files.tokens.get(name) ?? null,
    reloadUnits: () => {
      files.reloads += 1;
    },
    removeToken: (name: string) => {
      files.removed.push(name);
      files.tokens.delete(name);
    },
    unitInjectsToken: (name: string) => files.wired.has(name),
    provisionToken: (name: string, raw: string) => {
      if (files.failProvision) throw new Error("disk full");
      files.tokens.set(name, raw);
    },
    regenerate: (app: AppRecord) => {
      if (files.failRegenerate) throw new Error("systemd refused");
      files.regenerated.push(app.name);
      files.wired.add(app.name);
    },
    states: (names: readonly string[]) =>
      new Map(
        names.map((name) => [
          name,
          { state: files.states.get(name) ?? "stopped", restartCount: 0 },
        ]),
      ),
    restart: (name: string) => {
      if (files.failRestart) throw new Error("restart refused");
      files.restarted.push(name);
    },
  };
}

// Default: the app's unit already reads its token file (what every app
// registered since tokens existed looks like). `wired: new Set()` is the
// pre-token unit.
const files = (
  over: Partial<FakeSupervisorFiles> = {},
): FakeSupervisorFiles => ({
  tokens: new Map(),
  reloads: 0,
  wired: new Set(["hello"]),
  regenerated: [],
  removed: [],
  states: new Map(),
  restarted: [],
  failProvision: false,
  failRegenerate: false,
  failRestart: false,
  ...over,
});

describe("app-tokens: boot reconciliation", () => {
  it("rotates a pair that DISAGREES - the case a presence check would miss", () => {
    const s = store();
    s.mint("hello", "u-alice"); // hash from one token...
    const f = files({ tokens: new Map([["hello", "a-different-token"]]) }); // ...file holds another

    reconcileAppTokens(reconcileDeps([record()], s, f));
    const now = f.tokens.get("hello")!;
    expect(now).not.toBe("a-different-token");
    expect(s.matches("hello", now)).toBe(true);
  });

  it("rotates a plaintext the store has no hash for", () => {
    // The hash-without-file half is routes-apps-rest's same-box restore test.
    const s = store();
    expect(s.names()).toEqual([]);
    const f = files({ tokens: new Map([["hello", "orphan-plaintext"]]) });
    reconcileAppTokens(reconcileDeps([record()], s, f));
    expect(f.tokens.get("hello")).not.toBe("orphan-plaintext");
    expect(s.matches("hello", f.tokens.get("hello")!)).toBe(true);
  });

  it("prunes hashes for apps that no longer exist", () => {
    const s = store();
    const raw = s.mint("deleted-app", "u-alice");
    const report = reconcileAppTokens(reconcileDeps([], s, files()));
    expect(report.pruned).toEqual(["deleted-app"]);
    expect(s.lookup(raw)).toBeNull();
  });

  it("mints nothing when the unit could not be regenerated", () => {
    // Files first: a token written for a unit that cannot reference it would
    // look healthy forever after.
    const s = store();
    const f = files({ wired: new Set(), failRegenerate: true });
    const report = reconcileAppTokens(reconcileDeps([record()], s, f));

    expect(report.failed).toEqual(["hello"]);
    expect(s.names()).toEqual([]);
    expect(f.tokens.size).toBe(0);
  });

  it("rewires a unit that does not read the token file, WITHOUT rotating a healthy token", () => {
    // The state this pass exists to notice and nothing else can: registration
    // provisions the token before it installs the unit, and an install that
    // fails afterwards keeps the token - so a perfectly good pair can sit
    // behind a unit that injects nothing, forever, if a healthy pair were
    // enough to skip on.
    const s = store();
    const raw = s.mint("hello", "u-alice");
    const f = files({
      wired: new Set(),
      tokens: new Map([["hello", raw]]),
      states: new Map([["hello", "running"]]),
    });

    const report = reconcileAppTokens(reconcileDeps([record()], s, f));

    expect(report.rewired).toEqual(["hello"]);
    expect(report.provisioned).toEqual([]);
    expect(f.regenerated).toEqual(["hello"]);
    // Files only. `regenerate` is the no-activation verb by construction (the
    // supervisor test pins that it issues daemon-reload and nothing else), and
    // nothing else was called here at all.
    expect(f.removed).toEqual([]);
    expect(f.restarted).toEqual([]);
    // The token was fine, so it is left exactly as it was - rotating it would
    // break a running app for no reason.
    expect(f.tokens.get("hello")).toBe(raw);
    expect(s.matches("hello", raw)).toBe(true);
  });

  it("a failed delivery over a MISMATCHED pair leaves neither half behind", () => {
    // Mint replaces the hash before the plaintext is written, so a failure here
    // would otherwise pair a NEW hash with an OLD environment file - a token
    // the app presents that isomux no longer recognises. Both halves go, best
    // effort, and the next boot provisions fresh.
    const s = store();
    s.mint("hello", "u-alice"); // hash for a token...
    const f = files({
      tokens: new Map([["hello", "stale-plaintext"]]), // ...file holds another
      failProvision: true,
    });

    const report = reconcileAppTokens(reconcileDeps([record()], s, f));

    expect(report.failed).toEqual(["hello"]);
    expect(s.names()).toEqual([]); // hash taken back
    expect(f.removed).toEqual(["hello"]); // stale plaintext dropped
    expect(f.tokens.has("hello")).toBe(false);

    // ...and the next boot repairs it, which is what "best effort plus boot
    // repair" has to mean to be worth anything.
    f.failProvision = false;
    reconcileAppTokens(reconcileDeps([record()], s, f));
    expect(s.matches("hello", f.tokens.get("hello")!)).toBe(true);
  });

  it("keeps going after one app fails", () => {
    const s = store();
    const f = files();
    const deps = reconcileDeps(
      [record({ name: "alpha" }), record({ name: "beta" })],
      s,
      f,
    );
    const report = reconcileAppTokens({
      ...deps,
      regenerate: (app) => {
        if (app.name === "alpha") throw new Error("systemd refused");
        f.regenerated.push(app.name);
      },
    });
    expect(report.failed).toEqual(["alpha"]);
    expect(report.provisioned).toEqual(["beta"]);
  });

  it("does not restart a stopped app after giving it a new token", () => {
    // It held a credential (a hash with no plaintext), so a running app would
    // be restarted here: only the state keeps this one at rest.
    const s = store();
    s.mint("hello", "u-alice");
    const f = files({ states: new Map([["hello", "stopped"]]) });
    const report = reconcileAppTokens(reconcileDeps([record()], s, f));
    expect(report.provisioned).toEqual(["hello"]);
    expect(f.restarted).toEqual([]);
  });

  it("reports a restart failure separately from token provisioning", () => {
    const s = store();
    s.mint("hello", "u-alice");
    const f = files({
      states: new Map([["hello", "running"]]),
      failRestart: true,
    });
    const report = reconcileAppTokens(reconcileDeps([record()], s, f));
    expect(report.provisioned).toEqual(["hello"]);
    expect(report.failed).toEqual([]);
    expect(report.restarted).toEqual([]);
    expect(report.restartFailed).toEqual(["hello"]);
    // The new pair stands: a failed restart does not take the token back.
    expect(s.matches("hello", f.tokens.get("hello")!)).toBe(true);
  });
});

describe("app-tokens: boot reconciliation makes systemd's view current", () => {
  it("does not touch systemd at all in an office with no apps", () => {
    const f = files();
    const report = reconcileAppTokens(reconcileDeps([], store(), f));
    expect(f.reloads).toBe(0);
    expect(report.reloaded).toBe(false);
  });

  it("carries on with the per-app work when the reload fails", () => {
    // A reload that refuses is a reason an app might not be running; it is not
    // a reason to leave a pre-token app without a token.
    const s = store();
    const f = files({ wired: new Set() });
    const deps = reconcileDeps([record()], s, f);
    const report = reconcileAppTokens({
      ...deps,
      reloadUnits: () => {
        throw new Error("no user manager here");
      },
    });
    expect(report.reloaded).toBe(false);
    expect(report.provisioned).toEqual(["hello"]);
  });
});
