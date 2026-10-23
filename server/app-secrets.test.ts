// App secrets (task c7007f8b): which vault values an app gets, the file its
// unit reads them from, and the sync that keeps the files on the store. The
// store is real, in a temp root; the supervisor is the fake. The file format
// is checked against the container supervisor's parser here and against real
// systemd in app-supervisor.live.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appSecretsDir,
  appSecretsPath,
  createAppSecrets,
  renderSecretsEnv,
  type AppSecretsDeps,
} from "./app-secrets.ts";
import {
  createSecretStore,
  type AppGrant,
  type SecretScope,
} from "./secret-store.ts";
import { createFakeAppSupervisor } from "./test-support/fake-app-supervisor.ts";
import type { AppRecord } from "../shared/types.ts";

const PARSER = fileURLToPath(
  new URL("../deploy/container/supervisor.py", import.meta.url),
);
// Every character that systemd's EnvironmentFile or a shell would treat
// specially, and that checkSecretValue allows.
const HOSTILE = `a b"c'd\\e$f#g\`h\${HOME}%i\\\\j\\"k ;l=m\\n`;
const OFFICE: SecretScope = { kind: "office" };
const ALICE_ID = "u-alice";
const ALICE: SecretScope = { kind: "user", userId: ALICE_ID };
const BOB: SecretScope = { kind: "user", userId: "u-bob" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "isomux-app-secrets-"));
  roots.push(root);
  return root;
}

// The container supervisor's reading of a file.
function parse(text: string): Record<string, string> {
  const path = join(tempRoot(), "app.env");
  writeFileSync(path, text);
  const result = spawnSync("python3", [PARSER, "parse-secrets-env", path], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

function app(
  name: string,
  createdAt: number,
  userId: string | null = ALICE_ID,
): AppRecord {
  return {
    name,
    hostLabel: name,
    hostGen: 1,
    port: 40000 + createdAt,
    command: "true",
    cwd: "/",
    dataDir: "/",
    userId,
    username: null,
    createdBy: "test",
    createdAt,
  };
}
const grantOf = (a: AppRecord): AppGrant => ({
  name: a.name,
  createdAt: a.createdAt,
});

function add(
  store: ReturnType<typeof createSecretStore>,
  scope: SecretScope,
  name: string,
  value: string,
  apps: AppRecord[],
  hosts: string[] = [],
) {
  const change = store.create(scope, {
    name,
    value,
    hosts,
    form: { kind: "authorization" },
    apps: apps.map(grantOf),
  });
  if (!change.ok) throw new Error(`create ${name}: ${JSON.stringify(change)}`);
}

// No boot here, so no frozen app-host domain: the apps have no URL.
function fakeSupervisor() {
  const fake = createFakeAppSupervisor();
  fake.appHostDomain = () => null;
  return fake;
}

function setup(over: Partial<AppSecretsDeps> = {}) {
  const root = tempRoot();
  const store = createSecretStore(root);
  const supervisor = fakeSupervisor();
  const apps: AppRecord[] = [];
  const logs: string[] = [];
  const dir = appSecretsDir(root);
  const appSecrets = createAppSecrets({
    store,
    apps: () => apps,
    supervisor,
    dir,
    log: (line) => logs.push(line),
    ...over,
  });
  const install = (a: AppRecord) => {
    apps.push(a);
    supervisor.install(a);
    return a;
  };
  const file = (name: string) => {
    const path = appSecretsPath(dir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  const restarts = () =>
    supervisor.calls.filter((c) => c.startsWith("restart:")).sort();
  return {
    root,
    store,
    supervisor,
    apps,
    logs,
    dir,
    appSecrets,
    install,
    file,
    restarts,
  };
}

describe("the secrets file", () => {
  it("reads back byte for byte through the container supervisor's parser", () => {
    const env = {
      HOSTILE,
      PLAIN: "fake-plain-value-0001",
      QUOTES: `'"'"'`,
      EDGE: `\\`,
    };
    expect(parse(renderSecretsEnv(env))).toEqual(env);
  });

  it("is the same bytes for the same values in any order", () => {
    expect(
      renderSecretsEnv({ B_KEY: "fake-b-0001", A_KEY: "fake-a-0001" }),
    ).toBe(renderSecretsEnv({ A_KEY: "fake-a-0001", B_KEY: "fake-b-0001" }));
  });
});

// After test 1, a file is compared with renderSecretsEnv of what it should
// hold: the renderer is deterministic, and each parse spawns python3.
describe("what an app's file holds", () => {
  it("gives an app the office secrets and its owner's secrets granted to this registration, and nothing else", async () => {
    const t = setup({
      oauthOwned: (scope) => (scope.kind === "office" ? ["OAUTH_OWNED"] : []),
    });
    const bot = t.install(app("bot", 1));
    const ownerless = t.install(app("ownerless", 3, null));
    const old = app("bot", 0);
    const other = app("web", 2);
    add(t.store, OFFICE, "OFFICE_KEY", "fake-office-0001", [bot, ownerless]);
    add(t.store, OFFICE, "OAUTH_OWNED", "fake-oauth-0001", [bot]);
    add(t.store, ALICE, "ALICE_KEY", HOSTILE, [bot]);
    add(t.store, ALICE, "OLD_GRANT", "fake-old-0001", [old]);
    add(t.store, ALICE, "WEB_KEY", "fake-web-0001", [other]);
    add(t.store, ALICE, "HOST_ONLY", "fake-host-0001", [], ["api.example.com"]);
    // Bob's secret granted to Alice's app, as a hand edit would do.
    add(t.store, BOB, "BOB_KEY", "fake-bob-0001", [bot, ownerless]);
    add(t.store, ALICE, "ALICE_TO_OWNERLESS", "fake-alice-0002", [ownerless]);
    await t.appSecrets.sync();
    expect(t.file("bot")).toBe(
      renderSecretsEnv({ ALICE_KEY: HOSTILE, OFFICE_KEY: "fake-office-0001" }),
    );
    // An app with no owner: office secrets only.
    expect(t.file("ownerless")).toBe(
      renderSecretsEnv({ OFFICE_KEY: "fake-office-0001" }),
    );
  });

  it("drops both values of a name that two scopes give one app, and logs no value", async () => {
    const t = setup();
    const bot = t.install(app("bot", 1));
    // Each create is legal alone; together they clash, as a hand edit could
    // leave them. The store refuses the second, so write the office file
    // after the member file through another store with no member file.
    add(t.store, ALICE, "SAME", "fake-member-same-0001", [bot]);
    add(t.store, ALICE, "OTHER", "fake-member-other-0001", [bot]);
    const office = tempRoot();
    const officeStore = createSecretStore(office);
    add(officeStore, OFFICE, "SAME", "fake-office-same-0001", [bot]);
    writeFileSync(
      join(t.root, "secrets", "office.json"),
      readFileSync(join(office, "secrets", "office.json")),
      { mode: 0o600 },
    );
    await t.appSecrets.sync();
    expect(t.file("bot")).toBe(
      renderSecretsEnv({ OTHER: "fake-member-other-0001" }),
    );
    const logged = t.logs.join("\n");
    expect(logged).toContain("SAME");
    expect(logged).not.toContain("fake-member-same-0001");
    expect(logged).not.toContain("fake-office-same-0001");
  });
});

describe("sync", () => {
  it("writes each granted app's file 0600 in a 0700 directory, and removes every other file there", async () => {
    const t = setup();
    const bot = t.install(app("bot", 1));
    t.install(app("idle", 2));
    add(t.store, ALICE, "ALICE_KEY", HOSTILE, [bot]);
    mkdirSync(t.dir, { recursive: true });
    // A deleted app's file, and the file of a live app that holds nothing.
    writeFileSync(appSecretsPath(t.dir, "gone"), 'GONE="fake-gone-0001"\n');
    writeFileSync(appSecretsPath(t.dir, "idle"), 'IDLE="fake-idle-0001"\n');
    await t.appSecrets.sync();
    expect(t.file("bot")).toBe(renderSecretsEnv({ ALICE_KEY: HOSTILE }));
    expect(statSync(appSecretsPath(t.dir, "bot")).mode & 0o777).toBe(0o600);
    expect(statSync(t.dir).mode & 0o777).toBe(0o700);
    expect(t.file("gone")).toBeNull();
    expect(t.file("idle")).toBeNull();
  });

  it("restarts a running or starting app whose file changed, and no other app", async () => {
    const t = setup();
    const running = t.install(app("running", 1));
    const starting = t.install(app("starting", 2));
    const stopped = t.install(app("stopped", 3));
    const failed = t.install(app("failed", 4));
    const untouched = t.install(app("untouched", 5));
    t.supervisor.setRuntime("starting", { state: "starting", restartCount: 0 });
    t.supervisor.setRuntime("stopped", { state: "stopped", restartCount: 0 });
    t.supervisor.setRuntime("failed", { state: "failed", restartCount: 0 });
    add(t.store, ALICE, "UNTOUCHED_KEY", "fake-untouched-0001", [untouched]);
    await t.appSecrets.sync();
    t.supervisor.calls.length = 0;

    add(t.store, ALICE, "NEW_KEY", "fake-new-0001", [
      running,
      starting,
      stopped,
      failed,
    ]);
    await t.appSecrets.sync();
    expect(t.restarts()).toEqual(["restart:running", "restart:starting"]);
    // The stopped app reads the file at its next start.
    expect(t.file("stopped")).toBe(
      renderSecretsEnv({ NEW_KEY: "fake-new-0001" }),
    );

    // Same bytes: no restart. A note is not in the file. (A rotation and a
    // removal restart the app: routes-app-secrets.test.ts.)
    t.supervisor.calls.length = 0;
    t.store.update(ALICE, "NEW_KEY", { note: "Only a note." });
    await t.appSecrets.sync();
    expect(t.restarts()).toEqual([]);
  });

  it("at boot only, regenerates a unit that does not read its file, and no other unit", async () => {
    const t = setup();
    t.install(app("old", 1));
    t.install(app("new", 2));
    t.supervisor.unitsInjectingSecrets.delete("old");
    t.supervisor.calls.length = 0;
    // A change does not look at units: in a container that is a
    // subprocess per app.
    await t.appSecrets.sync();
    expect(
      t.supervisor.calls.filter((c) => c.startsWith("regenerate:")),
    ).toEqual([]);
    await t.appSecrets.sync({ boot: true });
    expect(
      t.supervisor.calls.filter((c) => c.startsWith("regenerate:")),
    ).toEqual(["regenerate:old"]);
  });

  it("prunes grants of apps that are gone", async () => {
    const t = setup();
    const bot = t.install(app("bot", 1));
    add(t.store, ALICE, "ALICE_KEY", "fake-alice-0001", [bot, app("gone", 2)]);
    await t.appSecrets.sync();
    expect(t.store.readForProxy(ALICE)[0].apps).toEqual([grantOf(bot)]);
  });

  it("a failure for one app is logged without a value, and the other apps go on", async () => {
    const fake = fakeSupervisor();
    const t = setup({
      supervisor: {
        unitInjectsSecrets: (name) => fake.unitInjectsSecrets(name),
        regenerate: (a) => fake.regenerate(a),
        states: (names) => fake.states(names),
        restart: (name) => {
          if (name === "broken") throw new Error(`boom ${HOSTILE}`);
          fake.restart(name);
        },
      },
    });
    const broken = app("broken", 1);
    const fine = app("fine", 2);
    for (const a of [broken, fine]) {
      t.apps.push(a);
      fake.install(a);
    }
    add(t.store, ALICE, "KEY", HOSTILE, [broken, fine]);
    await t.appSecrets.sync();
    expect(fake.calls).toContain("restart:fine");
    expect(t.file("fine")).toBe(renderSecretsEnv({ KEY: HOSTILE }));
    const logged = t.logs.join("\n");
    expect(logged).toContain("broken");
    expect(logged).not.toContain(HOSTILE);
    expect(logged).not.toContain("boom");
  });
});
