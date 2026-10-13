// The secrets runtime with the real store and env-loader: what agents get,
// when they must restart, and what the OpenCode profile key and revision see.
// The proxy child is the test child, reached through no network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { rootCertificates } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STATE_ROOT } from "../config.ts";
import {
  buildEnvForUserId,
  environmentSourceKeyForUserId,
  environmentSourceRevisionForUserId,
  setSecretEnvironmentProvider,
} from "../env-loader.ts";
import { createSecretStore, type SecretScope } from "../secret-store.ts";
import { secretsHandlers } from "../routes/handlers/secrets.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvPath,
  writeManagedOfficeEnv,
  writeManagedUserEnv,
} from "../user-env.ts";
import { saveProxyPort, secretMaterialPaths } from "./material.ts";
import {
  createSecretsRuntime,
  type SecretSetChange,
  type SecretsRuntime,
} from "./runtime.ts";

const TEST_CHILD = join(
  import.meta.dir,
  "..",
  "test-support",
  "secret-proxy-test-child.ts",
);
const ALICE = "u-alice";
const BOB = "u-bob";
const OFFICE: SecretScope = { kind: "office" };
const AT_ALICE: SecretScope = { kind: "user", userId: ALICE };
const AT_BOB: SecretScope = { kind: "user", userId: BOB };
// Obvious fakes.
const OFFICE_VALUE = "fake-office-value-0001";
const ALICE_VALUE = "ghp_FAKEaliceFAKEaliceFAKEaliceFAKEal01";
const BOB_VALUE = "fake-bob-value-000000001";
const FIXED = [
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
  "NODE_USE_ENV_PROXY",
];

const store = createSecretStore();
let runtime: SecretsRuntime;
let changes: SecretSetChange[];
let values: string[];
let restoreProvider: Parameters<typeof setSecretEnvironmentProvider>[0];

let logs: string[] = [];

function makeRuntime(
  extra: Partial<Parameters<typeof createSecretsRuntime>[0]> = {},
) {
  return createSecretsRuntime({
    store,
    stateRoot: STATE_ROOT,
    shareRoot: STATE_ROOT,
    serverEnv: {},
    onUse: () => {},
    onSetChanged: (change) => changes.push(change),
    onValues: (next) => {
      values = next;
    },
    log: (code) => logs.push(code),
    childEntry: TEST_CHILD,
    childEnv: { PATH: process.env.PATH ?? "" },
    systemRootsPem: `${rootCertificates[0]}\n`,
    ...extra,
  });
}

function add(scope: SecretScope, name: string, value: string) {
  const result = store.create(scope, {
    name,
    value,
    hosts: ["api.example-stub.test"],
    form: { kind: "authorization" },
  });
  if (!result.ok) throw new Error(`create failed: ${result.kind}`);
}

beforeEach(() => {
  // Other test files in the same process may leave secrets behind.
  rmSync(join(STATE_ROOT, "secrets"), { recursive: true, force: true });
  changes = [];
  values = [];
  logs = [];
  runtime = makeRuntime();
  restoreProvider = setSecretEnvironmentProvider((userId) =>
    runtime.environmentFor(userId),
  );
});

afterEach(async () => {
  await runtime.stop();
  setSecretEnvironmentProvider(restoreProvider);
  for (const path of [
    join(STATE_ROOT, "secrets"),
    managedOfficeEnvPath(),
    managedUserEnvPath(ALICE),
    managedUserEnvPath(BOB),
  ])
    rmSync(path, { recursive: true, force: true });
});

function envText(env: Record<string, string | undefined> | undefined) {
  return JSON.stringify(env ?? {});
}

describe("an office without secrets", () => {
  test("starts no proxy, makes no files, and gives agents the same env, key and revision", async () => {
    writeManagedOfficeEnv({ PLAIN: "office-plain" });
    const off = setSecretEnvironmentProvider(() => null);
    const before = {
      env: buildEnvForUserId(ALICE),
      key: environmentSourceKeyForUserId(ALICE),
      revision: environmentSourceRevisionForUserId(ALICE),
    };
    setSecretEnvironmentProvider(off);
    await runtime.enable();
    expect(existsSync(join(STATE_ROOT, "secrets"))).toBe(false);
    expect(runtime.proxyPort).toBeNull();
    expect(buildEnvForUserId(ALICE)).toEqual(before.env);
    expect(environmentSourceKeyForUserId(ALICE)).toBe(before.key);
    expect(environmentSourceRevisionForUserId(ALICE)).toBe(before.revision);
    expect(changes).toEqual([]);
  });
});

describe("an office with secrets", () => {
  test("git asks the office credential helper and gets the placeholder for each authorization-form host", async () => {
    await runtime.enable();
    const create = (
      scope: SecretScope,
      name: string,
      value: string,
      hosts: string[],
      form: { kind: "authorization" } | { kind: "header"; header: string },
    ) => {
      const result = store.create(scope, { name, value, hosts, form });
      if (!result.ok) throw new Error(`create failed: ${result.kind}`);
    };
    // Fly's prefix has a space: the helper's quoting must keep it.
    const FLY_VALUE = `FlyV1 fm2_${"FAKEhelper".repeat(7)}`;
    create(
      OFFICE,
      "OFFICE_GIT",
      FLY_VALUE,
      ["git.example-stub.test", "both.example-stub.test"],
      { kind: "authorization" },
    );
    create(AT_ALICE, "GH_TOKEN", ALICE_VALUE, ["both.example-stub.test"], {
      kind: "authorization",
    });
    create(AT_ALICE, "HEADER_KEY", BOB_VALUE, ["header.example-stub.test"], {
      kind: "header",
      header: "x-api-key",
    });
    await runtime.changed();
    const secrets = runtime.environmentFor(ALICE)!;
    // A member secret wins a host over an office one; a header-form secret
    // has no git helper.
    expect(secrets.gitCredentials).toEqual([
      { host: "both.example-stub.test", placeholder: secrets.member.GH_TOKEN },
      { host: "git.example-stub.test", placeholder: secrets.office.OFFICE_GIT },
    ]);

    // Entries go after the ones the base environment already has.
    const base = {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Base Entry",
    };
    const env = buildEnvForUserId(ALICE, base)!;
    // Per host: an empty helper that resets the list, then ours.
    expect(env.GIT_CONFIG_COUNT).toBe("5");
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_VALUE_0).toBe("Base Entry");
    expect(env.GIT_CONFIG_KEY_1).toBe(
      "credential.https://both.example-stub.test.helper",
    );
    expect(env.GIT_CONFIG_VALUE_1).toBe("");

    // The helper itself, as git runs it (a "!" helper goes to the shell).
    const helper = (index: number, action: string) =>
      spawnSync(
        "sh",
        ["-c", `${env[`GIT_CONFIG_VALUE_${index}`]!.slice(1)} ${action}`],
        {
          encoding: "utf8",
        },
      ).stdout;
    expect(helper(4, "get")).toBe(
      `username=x-access-token\npassword=${secrets.office.OFFICE_GIT}\n`,
    );
    expect(secrets.office.OFFICE_GIT).toStartWith("FlyV1 fm2_");
    expect(helper(4, "store")).toBe("");
    expect(helper(4, "erase")).toBe("");

    const home = mkdtempSync(join(tmpdir(), "b3-git-helper-"));
    const fill = (host: string) =>
      spawnSync("git", ["credential", "fill"], {
        input: `protocol=https\nhost=${host}\n\n`,
        env: { ...env, HOME: home, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
        encoding: "utf8",
      });
    const both = fill("both.example-stub.test");
    expect(both.status).toBe(0);
    expect(both.stdout).toContain(`password=${secrets.member.GH_TOKEN}\n`);
    expect(both.stdout).toContain("username=x-access-token\n");
    expect(fill("git.example-stub.test").stdout).toContain(
      `password=${secrets.office.OFFICE_GIT}\n`,
    );
    // No helper answers another host: git finds no credential.
    expect(fill("header.example-stub.test").status).not.toBe(0);
    expect(envText(env)).not.toContain(ALICE_VALUE);
    expect(envText(env)).not.toContain(FLY_VALUE);
    rmSync(home, { recursive: true, force: true });
  });

  test("a scope whose secrets are all in a named header gets no git configuration", async () => {
    await runtime.enable();
    const result = store.create(AT_BOB, {
      name: "HEADER_KEY",
      value: BOB_VALUE,
      hosts: ["header.example-stub.test"],
      form: { kind: "header", header: "x-api-key" },
    });
    if (!result.ok) throw new Error(`create failed: ${result.kind}`);
    await runtime.changed();
    const env = buildEnvForUserId(BOB, { PATH: "/usr/bin" })!;
    expect(env.HTTPS_PROXY).toBeDefined();
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG"))).toEqual(
      [],
    );
  });

  test("agents get placeholders and the proxy, never a value", async () => {
    await runtime.enable();
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    await runtime.changed();
    const port = runtime.proxyPort;
    expect(port).toBeGreaterThan(0);

    const alice = buildEnvForUserId(ALICE)!;
    expect(alice.OFFICE_KEY).toBeDefined();
    expect(alice.GH_TOKEN).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    expect(alice.HTTPS_PROXY).toBe(`http://127.0.0.1:${port}`);
    for (const name of FIXED) expect(alice[name]).toBeDefined();
    expect(alice.SSL_CERT_FILE).toBe(
      secretMaterialPaths(STATE_ROOT, STATE_ROOT).bundle,
    );
    expect(envText(alice)).not.toContain(OFFICE_VALUE);
    expect(envText(alice)).not.toContain(ALICE_VALUE);

    // Bob has only the office secret; an unowned run too.
    const bob = buildEnvForUserId(BOB)!;
    expect(bob.OFFICE_KEY).toBe(alice.OFFICE_KEY);
    expect(bob.GH_TOKEN).toBeUndefined();
    expect(buildEnvForUserId(null)?.OFFICE_KEY).toBe(alice.OFFICE_KEY);
    expect(values.sort()).toEqual([ALICE_VALUE, OFFICE_VALUE].sort());
  });

  test("precedence: member secret, member variable, office secret, office variable; the fixed set over all", async () => {
    await runtime.enable();
    writeManagedOfficeEnv({
      ALL: "office-var",
      OS: "office-var",
      MV: "office-var",
    });
    writeManagedUserEnv(ALICE, {
      ALL: "member-var",
      MV: "member-var",
      HTTPS_PROXY: "http://company.example:3128",
    });
    add(OFFICE, "ALL", "fake-office-all-0001");
    add(OFFICE, "OS", "fake-office-os-00001");
    add(OFFICE, "MV", "fake-office-mv-00001");
    add(AT_ALICE, "ALL", "fake-member-all-0001");
    await runtime.changed();
    const env = buildEnvForUserId(ALICE)!;
    const secrets = runtime.environmentFor(ALICE)!;
    expect(env.ALL).toBe(secrets.member.ALL);
    expect(env.OS).toBe(secrets.office.OS);
    expect(env.MV).toBe("member-var");
    expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${runtime.proxyPort}`);
  });

  test("two members with personal secrets and no env file get separate OpenCode profiles and only their own placeholders", async () => {
    await runtime.enable();
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    add(AT_BOB, "BOB_KEY", BOB_VALUE);
    await runtime.changed();
    expect(environmentSourceKeyForUserId(ALICE)).not.toBe(
      environmentSourceKeyForUserId(BOB),
    );
    const alice = buildEnvForUserId(ALICE)!;
    const bob = buildEnvForUserId(BOB)!;
    expect(alice.BOB_KEY).toBeUndefined();
    expect(bob.GH_TOKEN).toBeUndefined();
    // An emptied list keeps the file, so the key does not move back.
    const key = environmentSourceKeyForUserId(ALICE);
    store.remove(AT_ALICE, "GH_TOKEN");
    await runtime.changed();
    expect(environmentSourceKeyForUserId(ALICE)).toBe(key);
    // Office secrets never join the key.
    const bobKey = environmentSourceKeyForUserId(BOB);
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    await runtime.changed();
    expect(environmentSourceKeyForUserId(BOB)).toBe(bobKey);
  });
});

describe("restarts", () => {
  test("add and delete mark the scope and move the revision; a rotation in one prefix does neither; a hosts edit moves the revision only", async () => {
    await runtime.enable();
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    await runtime.changed();
    expect(changes).toEqual([[AT_ALICE]]);
    const revision = environmentSourceRevisionForUserId(ALICE);

    changes = [];
    store.rotate(
      AT_ALICE,
      "GH_TOKEN",
      "ghp_FAKErotatedFAKErotatedFAKErotate01",
    );
    await runtime.changed();
    expect(changes).toEqual([]);
    expect(environmentSourceRevisionForUserId(ALICE)).toBe(revision);

    // A hosts edit changes the git helpers: an OpenCode server with the old
    // ones must not be adopted. No restart is marked.
    store.update(AT_ALICE, "GH_TOKEN", { hosts: ["api.other-stub.test"] });
    await runtime.changed();
    expect(changes).toEqual([]);
    const hostsRevision = environmentSourceRevisionForUserId(ALICE);
    expect(hostsRevision).not.toBe(revision);
    store.rotate(
      AT_ALICE,
      "GH_TOKEN",
      "ghp_FAKErotatedFAKErotatedFAKErotate02",
    );
    await runtime.changed();
    expect(environmentSourceRevisionForUserId(ALICE)).toBe(hostsRevision);

    store.rotate(AT_ALICE, "GH_TOKEN", `github_pat_${"F".repeat(82)}`);
    await runtime.changed();
    expect(changes).toEqual([[AT_ALICE]]);
    const rotatedRevision = environmentSourceRevisionForUserId(ALICE);
    expect(rotatedRevision).not.toBe(hostsRevision);

    changes = [];
    store.remove(AT_ALICE, "GH_TOKEN");
    await runtime.changed();
    expect(changes).toEqual([[AT_ALICE]]);
    // Some secrets to none: no proxy variables, and a revision that an
    // adopted OpenCode server with the old proxy variables cannot match.
    expect(runtime.environmentFor(ALICE)).toBeNull();
    expect(environmentSourceRevisionForUserId(ALICE)).not.toBe(rotatedRevision);
  });

  test("a reissue marks the scope and gives a new placeholder for the same value", async () => {
    await runtime.enable();
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    await runtime.changed();
    const before = runtime.environmentFor(ALICE)!.member.GH_TOKEN;
    changes = [];
    expect(store.reissue(AT_ALICE, "GH_TOKEN").ok).toBe(true);
    await runtime.changed();
    expect(changes).toEqual([[AT_ALICE]]);
    const after = runtime.environmentFor(ALICE)!.member.GH_TOKEN;
    expect(after).not.toBe(before);
    expect(runtime.placeholderOf(AT_ALICE, "GH_TOKEN")).toBe(after);
    expect(store.readSecretValues(AT_ALICE, "GH_TOKEN")!.value).toBe(
      ALICE_VALUE,
    );
  });

  test("an office secret marks the office scope, which every agent is in", async () => {
    await runtime.enable();
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    await runtime.changed();
    expect(changes).toEqual([[OFFICE]]);
  });

  test("a restore without the placeholder key gives every scope new placeholders and a new revision", async () => {
    await runtime.enable();
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    await runtime.changed();
    const before = runtime.environmentFor(ALICE)!;
    const revision = environmentSourceRevisionForUserId(ALICE);
    await runtime.stop();
    const paths = secretMaterialPaths(STATE_ROOT, STATE_ROOT);
    rmSync(paths.placeholderKey);
    rmSync(paths.caKey);
    // A new server process: a new runtime on the same state.
    runtime = makeRuntime();
    await runtime.enable();
    const after = runtime.environmentFor(ALICE)!;
    expect(after.office.OFFICE_KEY).not.toBe(before.office.OFFICE_KEY);
    expect(after.member.GH_TOKEN).not.toBe(before.member.GH_TOKEN);
    expect(environmentSourceRevisionForUserId(ALICE)).not.toBe(revision);
    expect(existsSync(paths.caKey)).toBe(true);
  });

  test("a saved port that is taken moves the proxy and marks every agent", async () => {
    const squatter: Server = createServer(() => {});
    const taken = await new Promise<number>((resolve) =>
      squatter.listen(0, "127.0.0.1", () =>
        resolve((squatter.address() as { port: number }).port),
      ),
    );
    try {
      add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
      saveProxyPort(STATE_ROOT, taken);
      await runtime.enable();
      expect(runtime.proxyPort).not.toBe(taken);
      expect(changes).toContainEqual("all");
      expect(buildEnvForUserId(BOB)?.HTTPS_PROXY).toBe(
        `http://127.0.0.1:${runtime.proxyPort}`,
      );
    } finally {
      squatter.close();
    }
  });
});

describe("failure paths", () => {
  test("a child that never listens does not hold boot, and agents get no proxy variables", async () => {
    await runtime.stop();
    runtime = makeRuntime({
      childEntry: join(STATE_ROOT, "no-such-proxy-entry.ts"),
      startWaitMs: 300,
    });
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    const bootStart = Date.now();
    await runtime.enable();
    expect(Date.now() - bootStart).toBeLessThan(1500);
    expect(logs).toContain("proxy_not_listening");
    expect(runtime.environmentFor(ALICE)).toBeNull();
    expect(buildEnvForUserId(ALICE)?.HTTPS_PROXY).toBeUndefined();
    expect(logs).toContain("no_proxy_port");
  });

  test("a child that never listens does not hold the first secret route", async () => {
    await runtime.stop();
    runtime = makeRuntime({
      childEntry: join(STATE_ROOT, "no-such-proxy-entry.ts"),
      startWaitMs: 300,
    });
    // No secret at boot: the first create starts the child.
    await runtime.enable();
    const handlers = secretsHandlers({
      store,
      onChanged: () => runtime.changed(),
    });
    const routeStart = Date.now();
    const result = await handlers["secrets.create"]({
      identity: {
        scope: "user",
        userId: ALICE,
        role: "member",
        capabilities: [],
      },
      params: { username: "alice" },
      body: {
        name: "GH_TOKEN",
        value: ALICE_VALUE,
        hosts: ["api.example-stub.test"],
        form: { kind: "authorization" },
      },
      rawBody: "",
      query: new URLSearchParams(),
      req: new Request("http://localhost/"),
    });
    expect(result.kind).toBe("json");
    expect(Date.now() - routeStart).toBeLessThan(1500);
    expect(logs).toContain("proxy_not_listening");
  });

  test("agents that started before the first listen are marked when it comes", async () => {
    await runtime.stop();
    runtime = makeRuntime({ startWaitMs: 1 });
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    await runtime.enable();
    // Boot went on before the child listened.
    expect(runtime.environmentFor(ALICE)).toBeNull();
    const deadline = Date.now() + 2400;
    while (Date.now() < deadline && !changes.includes("all"))
      await Bun.sleep(50);
    expect(changes).toContain("all");
    expect(runtime.environmentFor(ALICE)?.fixed.HTTPS_PROXY).toBe(
      `http://127.0.0.1:${runtime.proxyPort}`,
    );
  });

  test("an unreadable office file leaves every member's environment working, and a killed child comes back", async () => {
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    // A file this version does not read, as after a downgrade.
    writeFileSync(
      join(STATE_ROOT, "secrets", "office.json"),
      '{"version":2,"secrets":[]}\n',
    );
    await runtime.enable();
    const alice = buildEnvForUserId(ALICE)!;
    expect(alice.GH_TOKEN).toMatch(/^ghp_/);
    expect(alice.HTTPS_PROXY).toBe(`http://127.0.0.1:${runtime.proxyPort}`);
    expect(() => buildEnvForUserId(BOB)).not.toThrow();
    expect(buildEnvForUserId(BOB)?.HTTPS_PROXY).toBeUndefined();
    expect(logs).toContain("store_unreadable");

    const port = runtime.proxyPort;
    const first = runtime.proxyPid!;
    process.kill(first, "SIGKILL");
    const deadline = Date.now() + 2400;
    while (
      Date.now() < deadline &&
      (runtime.proxyPid === null || runtime.proxyPid === first)
    )
      await Bun.sleep(50);
    expect(runtime.proxyPid).not.toBeNull();
    expect(runtime.proxyPid).not.toBe(first);
    expect(runtime.proxyPort).toBe(port);
  });
});
