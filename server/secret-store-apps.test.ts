// The secret store's app grants (task c7007f8b): a secret can go to apps as
// well as to hosts. A grant is an app name and its creation time, so a later
// app with the same name gets nothing. The store refuses a grant that would
// let one app read two secrets with the same name, and an update that adds a
// grant when the caller may not add one.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSecretStore,
  type AppGrant,
  type SecretScope,
} from "./secret-store.ts";
import { SECRET_MAX_APPS } from "../shared/secret-hosts.ts";

const OFFICE: SecretScope = { kind: "office" };
const ALICE: SecretScope = { kind: "user", userId: "u-alice" };
const BOB: SecretScope = { kind: "user", userId: "u-bob" };
const BOT: AppGrant = { name: "bot", createdAt: 1000 };
const WEB: AppGrant = { name: "web", createdAt: 2000 };
// An app that took the name of a deleted "bot".
const NEW_BOT: AppGrant = { name: "bot", createdAt: 3000 };
const VALUE = "fake-app-grant-value-0001";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function store(isLiveApp?: (grant: AppGrant) => boolean) {
  const root = mkdtempSync(join(tmpdir(), "isomux-secret-apps-"));
  roots.push(root);
  return { root, store: createSecretStore(root, { isLiveApp }) };
}

const body = (over: Record<string, unknown> = {}) => ({
  name: "BOT_TOKEN",
  value: VALUE,
  hosts: [],
  form: { kind: "authorization" },
  apps: [BOT],
  ...over,
});

// What failed, without the value: a field error, or the change kind.
function outcome(change: { ok: boolean } & Record<string, unknown>) {
  if (change.ok) return "ok";
  return change.kind === "invalid" ? change.error : change.kind;
}

const grants = (s: ReturnType<typeof store>["store"], scope: SecretScope) =>
  Object.fromEntries(
    s.readForProxy(scope).map((secret) => [secret.name, secret.apps ?? []]),
  );

describe("a secret needs a host or an app", () => {
  it("takes apps with no host, hosts with no app, or both; refuses neither", () => {
    const { store: s } = store();
    expect(outcome(s.create(ALICE, body()))).toBe("ok");
    expect(
      outcome(
        s.create(
          ALICE,
          body({ name: "HOSTED", hosts: ["api.example.com"], apps: undefined }),
        ),
      ),
    ).toBe("ok");
    expect(
      outcome(
        s.create(ALICE, body({ name: "BOTH", hosts: ["api.example.com"] })),
      ),
    ).toBe("ok");
    for (const apps of [[], undefined])
      expect(outcome(s.create(ALICE, body({ name: "NEITHER", apps })))).toEqual(
        {
          field: "hosts",
          reason: "invalid",
        },
      );
    expect(s.list(ALICE).map((w) => [w.name, w.hosts, w.apps])).toEqual([
      ["BOT_TOKEN", [], ["bot"]],
      ["BOTH", ["api.example.com"], ["bot"]],
      ["HOSTED", ["api.example.com"], []],
    ]);
  });

  it("an update may leave hosts or apps empty, never both", () => {
    const { store: s } = store();
    s.create(ALICE, body({ hosts: ["api.example.com"] }));
    expect(outcome(s.update(ALICE, "BOT_TOKEN", { hosts: [] }))).toBe("ok");
    // The last app with no host left.
    expect(outcome(s.update(ALICE, "BOT_TOKEN", { apps: [] }))).toEqual({
      field: "hosts",
      reason: "invalid",
    });
    expect(
      outcome(
        s.update(ALICE, "BOT_TOKEN", { hosts: ["api.example.com"], apps: [] }),
      ),
    ).toBe("ok");
    expect(s.list(ALICE)[0].apps).toEqual([]);
  });

  it(`takes at most ${SECRET_MAX_APPS} apps`, () => {
    const { store: s } = store();
    const many = Array.from({ length: SECRET_MAX_APPS + 1 }, (_, i) => ({
      name: `app-${i}`,
      createdAt: i,
    }));
    expect(outcome(s.create(ALICE, body({ apps: many })))).toEqual({
      field: "apps",
      reason: "too_long",
    });
    expect(
      outcome(s.create(ALICE, body({ apps: many.slice(0, SECRET_MAX_APPS) }))),
    ).toBe("ok");
  });
});

describe("names the app's own environment needs", () => {
  it("are refused for a secret with apps, at create and when an update adds the first app", () => {
    const { store: s } = store();
    for (const name of [
      "PORT",
      "PATH",
      "HOME",
      "LANG",
      "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
    ]) {
      expect([name, outcome(s.create(ALICE, body({ name })))]).toEqual([
        name,
        { field: "name", reason: "reserved" },
      ]);
      // A host-only secret may use the name: agents get a placeholder, and
      // no app reads it.
      expect([
        name,
        outcome(
          s.create(ALICE, body({ name, hosts: ["api.example.com"], apps: [] })),
        ),
      ]).toEqual([name, "ok"]);
      expect([name, outcome(s.update(ALICE, name, { apps: [BOT] }))]).toEqual([
        name,
        { field: "name", reason: "reserved" },
      ]);
    }
  });
});

describe("one app cannot read two secrets with the same name", () => {
  it("refuses the second grant whichever scope comes first, and allows the name for another app", () => {
    const { store: s } = store();
    expect(outcome(s.create(ALICE, body()))).toBe("ok");
    expect(outcome(s.create(OFFICE, body()))).toEqual({
      field: "apps",
      reason: "clash",
    });
    expect(outcome(s.create(OFFICE, body({ apps: [WEB] })))).toBe("ok");
    expect(
      outcome(s.update(OFFICE, "BOT_TOKEN", { apps: [WEB, BOT] })),
    ).toEqual({
      field: "apps",
      reason: "clash",
    });
    // The other order: the office secret holds web, a member asks for it.
    expect(outcome(s.create(BOB, body({ apps: [WEB] })))).toEqual({
      field: "apps",
      reason: "clash",
    });
    expect(grants(s, OFFICE)).toEqual({ BOT_TOKEN: [WEB] });
    // A grant to a deleted app of the same name is no clash.
    expect(outcome(s.create(BOB, body({ apps: [NEW_BOT] })))).toBe("ok");
  });
});

describe("a caller that may not add an app", () => {
  const narrow = { addHosts: false, addApps: false };

  it("is refused a grant whose name is held but whose app is another one", () => {
    // A stale grant for a deleted "bot", and a new app "bot": sending the
    // same names re-binds the grant to the new app, which is an add.
    const { store: s } = store();
    s.create(ALICE, body({ hosts: ["api.example.com"], apps: [BOT] }));
    expect(
      outcome(s.update(ALICE, "BOT_TOKEN", { apps: [NEW_BOT] }, narrow)),
    ).toBe("app_added");
    expect(grants(s, ALICE)).toEqual({ BOT_TOKEN: [BOT] });
    // Anyone may add.
    expect(outcome(s.update(ALICE, "BOT_TOKEN", { apps: [NEW_BOT] }))).toBe(
      "ok",
    );
    expect(grants(s, ALICE)).toEqual({ BOT_TOKEN: [NEW_BOT] });
  });
});

describe("grants of apps that are gone", () => {
  it("are not listed, and dropApp and pruneApps remove them from every scope", () => {
    const live = new Set(["web:2000"]);
    const { store: s } = store((g) => live.has(`${g.name}:${g.createdAt}`));
    s.create(ALICE, body({ apps: [BOT, WEB] }));
    s.create(
      OFFICE,
      body({ name: "OFFICE_KEY", apps: [BOT], hosts: ["api.example.com"] }),
    );
    s.create(BOB, body({ name: "BOB_KEY", apps: [NEW_BOT, WEB] }));
    expect(s.list(ALICE)[0].apps).toEqual(["web"]);
    expect(s.list(OFFICE)[0].apps).toEqual([]);
    expect(s.list(BOB)[0].apps).toEqual(["web"]);

    // Another registration of the name keeps its grant.
    s.dropApp(BOT);
    expect(grants(s, ALICE)).toEqual({ BOT_TOKEN: [WEB] });
    expect(grants(s, OFFICE)).toEqual({ OFFICE_KEY: [] });
    expect(grants(s, BOB)).toEqual({ BOB_KEY: [NEW_BOT, WEB] });

    s.pruneApps((g) => live.has(`${g.name}:${g.createdAt}`));
    expect(grants(s, BOB)).toEqual({ BOB_KEY: [WEB] });
    expect(grants(s, ALICE)).toEqual({ BOT_TOKEN: [WEB] });
  });

  it("pruning an app-only secret's last app keeps the secret, which then reaches nothing", () => {
    const { store: s } = store();
    s.create(ALICE, body());
    s.pruneApps(() => false);
    expect(s.list(ALICE).map((w) => [w.name, w.hosts, w.apps])).toEqual([
      ["BOT_TOKEN", [], []],
    ]);
  });
});

describe("a secrets file written before apps existed", () => {
  it("reads, lists no apps, and takes a grant", () => {
    const { root, store: s } = store();
    mkdirSync(join(root, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, "secrets", "office.json"),
      JSON.stringify({
        version: 1,
        secrets: [
          {
            name: "OLD_KEY",
            value: VALUE,
            hosts: ["api.example.com"],
            form: { kind: "authorization" },
            generation: 1,
            createdAt: 1,
            valueSetAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      { mode: 0o600 },
    );
    expect(s.list(OFFICE).map((w) => [w.name, w.apps])).toEqual([
      ["OLD_KEY", []],
    ]);
    expect(outcome(s.update(OFFICE, "OLD_KEY", { apps: [BOT] }))).toBe("ok");
    expect(grants(s, OFFICE)).toEqual({ OLD_KEY: [BOT] });
  });
});
