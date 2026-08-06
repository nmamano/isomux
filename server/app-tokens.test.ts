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
//     exist, and it never starts or restarts anything.
//
// Pure T0: a temp directory, no server, no systemd, no LLM.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  APP_TOKEN_FILE_MODE,
  AppTokenError,
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
  it("mints a token that resolves to its app, and persists only the hash", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");

    expect(raw.length).toBeGreaterThan(20);
    expect(s.lookup(raw)).toEqual({ appName: "hello", userId: "u-alice" });

    // The whole point: the file must not contain the secret anywhere, in any
    // field, under any name.
    const onDisk = readFileSync(tokenFile(), "utf-8");
    expect(onDisk).not.toContain(raw);
    expect(onDisk).toContain(createHash("sha256").update(raw).digest("hex"));
  });

  it("survives a restart: a second store over the same directory resolves it", () => {
    // The property agent tokens deliberately do NOT have, and the reason this
    // store exists: an app outlives the isomux process that started it.
    const raw = store().mint("hello", "u-alice");
    expect(store().lookup(raw)?.appName).toBe("hello");
  });

  it("writes the store 0600", () => {
    store().mint("hello", "u-alice");
    expect(statSync(tokenFile()).mode & 0o777).toBe(APP_TOKEN_FILE_MODE);
  });

  it("mints a token an environment file can hold verbatim", () => {
    // base64url only. A value needing systemd's quoting would come back from
    // the parser as something other than what was hashed - a token that never
    // works and says nothing about why.
    for (let i = 0; i < 25; i++) {
      expect(createAppTokenStore({ dir }).mint(`app-${i}`, null)).toMatch(
        /^[A-Za-z0-9_-]+$/,
      );
    }
  });

  it("gives two apps distinct tokens that resolve to their own names", () => {
    const s = store();
    const a = s.mint("alpha", "u-alice");
    const b = s.mint("beta", "u-bob");
    expect(a).not.toBe(b);
    expect(s.lookup(a)?.appName).toBe("alpha");
    expect(s.lookup(b)?.appName).toBe("beta");
    expect(s.names().sort()).toEqual(["alpha", "beta"]);
  });

  it("re-minting replaces: the old token is dead", () => {
    const s = store();
    const first = s.mint("hello", "u-alice");
    const second = s.mint("hello", "u-alice");
    expect(second).not.toBe(first);
    expect(s.lookup(first)).toBeNull();
    expect(s.lookup(second)?.appName).toBe("hello");
  });

  it("revoke ends the token and leaves the other apps alone", () => {
    const s = store();
    const gone = s.mint("alpha", "u-alice");
    const kept = s.mint("beta", "u-alice");
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

  it("keeps a null owner as null rather than inventing one", () => {
    const s = store();
    expect(s.lookup(s.mint("hello", null))).toEqual({
      appName: "hello",
      userId: null,
    });
  });
});

describe("app-tokens: a corrupt store denies and refuses to be overwritten", () => {
  const corruptions: Array<[string, string]> = [
    ["not JSON at all", "{{{"],
    ["a JSON array", "[]"],
    ["an entry that is not a token record", '{"hello":{"hash":"nope"}}'],
    [
      "a hash that is not a sha256",
      '{"hello":{"hash":"abc","userId":null,"mintedAt":1}}',
    ],
  ];

  for (const [what, contents] of corruptions) {
    it(`denies every lookup when the file is ${what}`, () => {
      writeFileSync(tokenFile(), contents);
      expect(store().lookup("anything")).toBeNull();
      expect(store().names()).toEqual([]);
    });
  }

  it("refuses to mint over a corrupt store, leaving the file untouched", () => {
    // THE FAILURE THIS PREVENTS: mint reads, adds one entry and rewrites the
    // whole file. Treating an unreadable file as an empty one would rewrite it
    // with a single app in it - silently revoking every other app's token and
    // destroying the only copy of the evidence.
    const s = store();
    s.mint("alpha", "u-alice");
    const good = readFileSync(tokenFile(), "utf-8");
    writeFileSync(tokenFile(), good + "corrupted");

    expect(() => store().mint("beta", "u-bob")).toThrow(AppTokenError);
    expect(readFileSync(tokenFile(), "utf-8")).toBe(good + "corrupted");
  });

  it("treats a MISSING file as an empty store (a fresh office), not an error", () => {
    expect(store().lookup("anything")).toBeNull();
    expect(store().names()).toEqual([]);
    expect(store().mint("hello", "u-alice").length).toBeGreaterThan(20);
  });

  it("refuses a generator that produces an env-file-hostile token", () => {
    expect(() =>
      store({ mintRaw: () => 'has spaces and "quotes"' }).mint("hello", null),
    ).toThrow(AppTokenError);
    // Nothing was written for it, so the app is honestly tokenless.
    expect(store().names()).toEqual([]);
  });
});

// --- the identity -----------------------------------------------------------

describe("app-tokens: the identity a token resolves to", () => {
  it("is APP scope, carries the app name and its owner, and holds NO capabilities", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    const identity = appIdentityFromToken(raw, s)!;

    expect(identity.scope).toBe("app");
    expect(identity.appName).toBe("hello");
    // Truthful, and never an authority: every guard is scope-gated, which the
    // guard matrix and the whole-table reachability test pin.
    expect(identity.userId).toBe("u-alice");
    expect(identity.role).toBe("member");
    expect(identity.capabilities).toEqual(APP_CAPABILITIES);
    expect(identity.capabilities.length).toBe(0);
    expect(identity.agentId).toBeUndefined();
  });

  it("is null for a token that was revoked or never existed", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    s.revoke("hello");
    expect(appIdentityFromToken(raw, s)).toBeNull();
    expect(appIdentityFromToken("garbage", s)).toBeNull();
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
  failProvision: boolean;
  failRegenerate: boolean;
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
  failProvision: false,
  failRegenerate: false,
  ...over,
});

describe("app-tokens: boot reconciliation", () => {
  it("gives an app registered before tokens existed one, and rewrites its unit", () => {
    const s = store();
    const f = files({ wired: new Set() }); // a unit with no EnvironmentFile line
    const report = reconcileAppTokens(reconcileDeps([record()], s, f));

    expect(report.provisioned).toEqual(["hello"]);
    const raw = f.tokens.get("hello")!;
    expect(s.lookup(raw)).toEqual({ appName: "hello", userId: "u-alice" });
    // The unit is rewritten too, because a pre-token unit has no reference to
    // the environment file at all - writing the file alone would inject
    // nothing, and the NEXT pass would see a matching pair and skip it forever.
    expect(f.regenerated).toEqual(["hello"]);
  });

  it("leaves a healthy pair behind a wired unit completely alone", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    const f = files({ tokens: new Map([["hello", raw]]) });

    const report = reconcileAppTokens(reconcileDeps([record()], s, f));
    expect(report.provisioned).toEqual([]);
    expect(f.regenerated).toEqual([]); // nothing rewritten, nothing bounced
    expect(f.tokens.get("hello")).toBe(raw); // same token, not rotated
  });

  it("rotates a pair that DISAGREES - the case a presence check would miss", () => {
    const s = store();
    s.mint("hello", "u-alice"); // hash from one token...
    const f = files({ tokens: new Map([["hello", "a-different-token"]]) }); // ...file holds another

    reconcileAppTokens(reconcileDeps([record()], s, f));
    const now = f.tokens.get("hello")!;
    expect(now).not.toBe("a-different-token");
    expect(s.matches("hello", now)).toBe(true);
  });

  it("rotates when the file is gone, and when the hash is gone", () => {
    const s = store();
    // hash without file
    s.mint("hello", "u-alice");
    const f1 = files();
    reconcileAppTokens(reconcileDeps([record()], s, f1));
    expect(s.matches("hello", f1.tokens.get("hello")!)).toBe(true);

    // file without hash
    const s2 = store();
    const f2 = files({ tokens: new Map([["hello", "orphan-plaintext"]]) });
    reconcileAppTokens(reconcileDeps([record()], s2, f2));
    expect(f2.tokens.get("hello")).not.toBe("orphan-plaintext");
    expect(s2.matches("hello", f2.tokens.get("hello")!)).toBe(true);
  });

  it("prunes hashes for apps that no longer exist", () => {
    const s = store();
    const raw = s.mint("deleted-app", "u-alice");
    const report = reconcileAppTokens(reconcileDeps([], s, files()));
    expect(report.pruned).toEqual(["deleted-app"]);
    expect(s.lookup(raw)).toBeNull();
  });

  it("takes the hash back when the plaintext could not be written", () => {
    // The unrepairable state this exists to prevent: a hash whose plaintext was
    // lost. isomux cannot reproduce a token it does not keep, so the app could
    // never authenticate and `has a token` would keep the next pass from
    // fixing it.
    const s = store();
    const f = files({ failProvision: true });
    const report = reconcileAppTokens(reconcileDeps([record()], s, f));

    expect(report.failed).toEqual(["hello"]);
    expect(s.names()).toEqual([]); // absent, not half-provisioned
    expect(f.tokens.size).toBe(0);
    expect(f.removed).toEqual(["hello"]);

    // ...and the next boot fixes it.
    f.failProvision = false;
    reconcileAppTokens(reconcileDeps([record()], s, f));
    expect(s.matches("hello", f.tokens.get("hello")!)).toBe(true);
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
    const f = files({ wired: new Set(), tokens: new Map([["hello", raw]]) });

    const report = reconcileAppTokens(reconcileDeps([record()], s, f));

    expect(report.rewired).toEqual(["hello"]);
    expect(report.provisioned).toEqual([]);
    expect(f.regenerated).toEqual(["hello"]);
    // Files only. `regenerate` is the no-activation verb by construction (the
    // supervisor test pins that it issues daemon-reload and nothing else), and
    // nothing else was called here at all.
    expect(f.removed).toEqual([]);
    // The token was fine, so it is left exactly as it was - rotating it would
    // break a running app for no reason.
    expect(f.tokens.get("hello")).toBe(raw);
    expect(s.matches("hello", raw)).toBe(true);
  });

  it("stops rewiring once the unit reads the file (it converges, it does not loop)", () => {
    const s = store();
    const raw = s.mint("hello", "u-alice");
    const f = files({ wired: new Set(), tokens: new Map([["hello", raw]]) });
    reconcileAppTokens(reconcileDeps([record()], s, f));
    f.regenerated.length = 0;
    const second = reconcileAppTokens(reconcileDeps([record()], s, f));
    expect(second).toEqual({
      checked: 1,
      reloaded: true,
      provisioned: [],
      rewired: [],
      pruned: [],
      failed: [],
    });
    expect(f.regenerated).toEqual([]);
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
});

describe("app-tokens: boot reconciliation makes systemd's view current", () => {
  it("reloads the unit files once, before inspecting anything", () => {
    // The fact no on-disk check can establish: the user systemd manager
    // outlives isomux, so a unit written by a previous run whose daemon-reload
    // never completed is a perfect file systemd has never read. Without this,
    // an app whose registration failed at exactly that step stays invisible to
    // systemd forever, because every later pass sees a healthy pair behind a
    // wired unit and skips.
    const s = store();
    const raw = s.mint("hello", "u-alice");
    const f = files({ tokens: new Map([["hello", raw]]) });

    const report = reconcileAppTokens(reconcileDeps([record()], s, f));

    expect(f.reloads).toBe(1);
    expect(report.reloaded).toBe(true);
    // ...and nothing else happened: no rewrite, no rotation.
    expect(f.regenerated).toEqual([]);
    expect(f.tokens.get("hello")).toBe(raw);
  });

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
