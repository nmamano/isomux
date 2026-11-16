// The Claude token of members with their own OS user (claude-member-token.ts,
// slice 4a of task b94dfd25). The properties:
// - the store keeps the token 0600 in the secret store's folder, and each set
//   is a new generation, also within one millisecond; a file that does not
//   read is no token;
// - the shape check is loose (no prefix), the date is the day it was made;
// - no route answers the token;
// - office agents may not read it, and backups leave it out (U1); an office
//   move carries it with the secret store (office-move-scope.test.ts);
// - the logs redact it with the secret store's values, and stop when it is
//   cleared (T3);
// - the owners get one page per phase: a page they closed is not opened again
//   by the hourly check or by the next turn on a rejected token.
import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  createMemberTokenStore,
  madeAtFrom,
  memberTokenPath,
  memberTokenRefusal,
  TOKEN_LIFETIME_MS,
} from "./claude-member-token.ts";
import {
  createMemberTokenPager,
  EXPIRY_NOTICE_MS,
} from "./claude-member-token-pager.ts";
import { memberTokenHandlers } from "./claude-member-token-routes.ts";
import { runBackupOnceForTest } from "./backup.ts";
import {
  redactSecretText,
  setMemberTokenForRedaction,
  setSecretValuesForRedaction,
} from "./log-redaction.ts";
import type { RouteHandlerContext } from "./routes/executor.ts";

const top = mkdtempSync(join(tmpdir(), "claude-member-token-"));
afterAll(() => {
  setMemberTokenForRedaction(null);
  setSecretValuesForRedaction([]);
  rmSync(top, { recursive: true, force: true });
});
let serial = 0;
const root = () => {
  const dir = join(top, `state-${++serial}`);
  mkdirSync(dir);
  return dir;
};

const TOKEN = "sk-test-member-token-aaaaaaaaaaaa";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 16, 15);

describe("the store", () => {
  it("keeps the token 0600 in the secret store's folder, and every set is a new generation", () => {
    const stateRoot = root();
    let changes = 0;
    const store = createMemberTokenStore(stateRoot, () => changes++);
    expect(store.generation()).toBe(0);
    store.set(TOKEN, NOW, NOW);
    const first = store.generation();
    store.set(`${TOKEN}b`, NOW, NOW);
    const path = memberTokenPath(stateRoot);
    expect({
      inSecrets: relative(stateRoot, path).split("/")[0],
      mode: lstatSync(path).mode & 0o777,
      newer: store.generation() > first && first > 0,
      again: createMemberTokenStore(stateRoot).get()?.token,
      changes,
    }).toEqual({
      inSecrets: "secrets",
      mode: 0o600,
      newer: true,
      again: `${TOKEN}b`,
      changes: 2,
    });
    store.clear();
    expect([store.generation(), store.status(), changes]).toEqual([
      0,
      { set: false },
      3,
    ]);
  });

  it("reads a file that is not a token as no token", () => {
    const stateRoot = root();
    mkdirSync(join(stateRoot, "secrets"));
    for (const text of [
      "{",
      JSON.stringify({ token: "a b", madeAt: 1, setAt: 1 }),
      JSON.stringify({ token: TOKEN, madeAt: 1, setAt: 0 }),
    ]) {
      writeFileSync(memberTokenPath(stateRoot), text);
      const store = createMemberTokenStore(stateRoot);
      expect([store.generation(), store.get()]).toEqual([0, null]);
    }
  });

  it("checks the shape loosely and the day it was made", () => {
    const today = Math.floor(NOW / DAY) * DAY;
    expect({
      // Any prefix: a new token format is not refused.
      other: memberTokenRefusal("tok-" + "x".repeat(40)),
      space: memberTokenRefusal(`${TOKEN} x`) !== null,
      newline: memberTokenRefusal(`${TOKEN}\n`) !== null,
      short: memberTokenRefusal("x".repeat(19)) !== null,
      long: memberTokenRefusal("x".repeat(4097)) !== null,
      notText: memberTokenRefusal(42) !== null,
      defaultDay: madeAtFrom(undefined, NOW),
      day: madeAtFrom("2026-11-01", NOW),
      future: typeof madeAtFrom("2026-11-17", NOW),
      yearOld: typeof madeAtFrom("2025-11-16", NOW),
      notADate: typeof madeAtFrom("16/11/2026", NOW),
    }).toEqual({
      other: null,
      space: true,
      newline: true,
      short: true,
      long: true,
      notText: true,
      defaultDay: today,
      day: Date.UTC(2026, 10, 1),
      future: "string",
      yearOld: "string",
      notADate: "string",
    });
  });
});

describe("the routes", () => {
  const ctx = (body?: unknown) => ({ body }) as unknown as RouteHandlerContext;
  it("never answer the token, and refuse a bad token or date", async () => {
    const store = createMemberTokenStore(root());
    const routes = memberTokenHandlers({
      tokens: () => store,
      anyIsolated: () => true,
      now: () => NOW,
    });
    const answers = [
      await routes["office.memberToken.set"](
        ctx({ token: TOKEN, madeOn: "2026-11-01" }),
      ),
      await routes["office.memberToken.get"](ctx()),
      await routes["office.memberToken.set"](ctx({ token: "short" })),
      await routes["office.memberToken.set"](
        ctx({ token: `${TOKEN}c`, madeOn: "2027-01-01" }),
      ),
    ];
    expect({
      leaked: JSON.stringify(answers).includes(TOKEN),
      view: answers[1],
      codes: answers.slice(2).map((a) => (a as { code?: string }).code),
      stored: store.get()?.token,
    }).toEqual({
      leaked: false,
      view: {
        kind: "json",
        status: undefined,
        body: {
          set: true,
          inUse: true,
          madeAt: Date.UTC(2026, 10, 1),
          expiresAt: Date.UTC(2026, 10, 1) + TOKEN_LIFETIME_MS,
        },
      },
      codes: ["invalid_token", "invalid_date"],
      stored: TOKEN,
    });
  });
});

describe("where it is kept (U1)", () => {
  it("is left out of a backup copy", async () => {
    const parent = root();
    const stateRoot = join(parent, ".isomux");
    mkdirSync(stateRoot);
    writeFileSync(join(stateRoot, "state.txt"), "state");
    createMemberTokenStore(stateRoot).set(TOKEN, NOW, NOW);
    const backupDir = join(parent, "backups");
    const name = await runBackupOnceForTest(
      {
        backupDir,
        stateRootParent: parent,
        stateRootName: ".isomux",
        retention: 7,
        minHeadroomBytes: 10,
      },
      { now: () => NOW, availableBytes: () => 1e12 },
    );
    const copy = join(backupDir, name, ".isomux");
    expect([
      readFileSync(join(copy, "state.txt"), "utf8"),
      existsSync(join(copy, "secrets", "claude-member-token.json")),
    ]).toEqual(["state", false]);
  });
});

describe("the logs (T3)", () => {
  it("redact the token with the secret store's values, in any order of setting, and stop when it is cleared", () => {
    setSecretValuesForRedaction(["store-secret-value-1234"]);
    setMemberTokenForRedaction(TOKEN);
    // The secret store's values change after the token was set.
    setSecretValuesForRedaction(["store-secret-value-5678"]);
    const both = redactSecretText(`a ${TOKEN} b store-secret-value-5678`);
    setMemberTokenForRedaction(null);
    const cleared = redactSecretText(`a ${TOKEN}`);
    expect([
      both.includes(TOKEN),
      both.includes("store-secret-value-5678"),
      cleared.includes(TOKEN),
    ]).toEqual([false, false, true]);
  });
});

// A pager that models the office's: a raise opens a page unless one is open
// with that key; the owner can close it.
function fakePager() {
  const open = new Set<string>();
  const opened: string[] = [];
  return {
    opened,
    raise(userId: string, key: string) {
      if (open.has(`${userId} ${key}`)) return;
      open.add(`${userId} ${key}`);
      opened.push(`${userId} ${key}`);
    },
    close(userId: string, key: string) {
      open.delete(`${userId} ${key}`);
    },
    // The owner answers the page.
    dismiss(userId: string, key: string) {
      open.delete(`${userId} ${key}`);
    },
  };
}

describe("the owners' pages", () => {
  function setup(madeAt: number, isolated = true) {
    let now = madeAt;
    const store = createMemberTokenStore(root());
    store.set(TOKEN, madeAt, madeAt);
    const pager = fakePager();
    const pages = createMemberTokenPager({
      tokens: () => store,
      pager,
      owners: () => ["owner-1", "owner-2"],
      anyIsolated: () => isolated,
      now: () => now,
    });
    return { store, pager, pages, at: (t: number) => (now = t) };
  }

  it("pages each owner once 14 days before the expiry, again at the expiry, and not every hour after they close it", () => {
    const s = setup(NOW);
    const expiry = NOW + TOKEN_LIFETIME_MS;
    s.at(expiry - EXPIRY_NOTICE_MS - DAY);
    s.pages.check();
    expect(s.pager.opened).toEqual([]);
    s.at(expiry - EXPIRY_NOTICE_MS + 1);
    s.pages.check();
    expect(s.pager.opened.length).toBe(2);
    s.pager.dismiss("owner-1", "claude-member-token:expiry");
    for (let hour = 1; hour <= 24; hour++) {
      s.at(expiry - EXPIRY_NOTICE_MS + hour * 3600_000);
      s.pages.check();
    }
    expect(s.pager.opened.length).toBe(2);
    s.at(expiry + 1);
    s.pages.check();
    expect(s.pager.opened.length).toBeGreaterThan(2);
  });

  it("pages no one while no member has their own OS user", () => {
    const s = setup(NOW, false);
    s.at(NOW + TOKEN_LIFETIME_MS + 1);
    s.pages.check();
    expect(s.pager.opened).toEqual([]);
  });

  it("pages a rejection once per token, and again for a new token", () => {
    const s = setup(NOW);
    s.pages.rejected();
    s.pager.dismiss("owner-1", "claude-member-token:rejected");
    s.pager.dismiss("owner-2", "claude-member-token:rejected");
    // Her next turns on the same token.
    s.pages.rejected();
    s.pages.rejected();
    expect(s.pager.opened.length).toBe(2);
    s.store.set(`${TOKEN}d`, NOW, NOW + 1);
    s.pages.changed();
    s.pages.rejected();
    expect(s.pager.opened.length).toBe(4);
  });
});
