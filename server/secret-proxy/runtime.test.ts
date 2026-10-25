// The secrets runtime with the real store and env-loader: what agents get,
// when they must restart, and what the OpenCode profile key and revision see.
// The proxy child is the test child, reached through no network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  connectThrough,
  proxyBasic,
  startCompanyProxy,
  startEchoStub,
} from "../test-support/secret-proxy-stubs.ts";
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

// An agent's HTTPS_PROXY without the proxy password.
function proxyAddress(url: string | undefined) {
  if (url === undefined) return url;
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

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
    // The proxy address gets an empty helper list; per host: an empty helper
    // that resets the list, then ours.
    expect(env.GIT_CONFIG_COUNT).toBe("6");
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_VALUE_0).toBe("Base Entry");
    expect(env.GIT_CONFIG_KEY_1).toBe(
      `credential.${proxyAddress(env.HTTPS_PROXY)}.helper`,
    );
    expect(env.GIT_CONFIG_VALUE_1).toBe("");
    expect(env.GIT_CONFIG_KEY_2).toBe(
      "credential.https://both.example-stub.test.helper",
    );
    expect(env.GIT_CONFIG_VALUE_2).toBe("");

    // The helper itself, as git runs it (a "!" helper goes to the shell).
    const helper = (index: number, action: string) =>
      spawnSync(
        "sh",
        ["-c", `${env[`GIT_CONFIG_VALUE_${index}`]!.slice(1)} ${action}`],
        {
          encoding: "utf8",
        },
      ).stdout;
    expect(helper(5, "get")).toBe(
      `username=x-access-token\npassword=${secrets.office.OFFICE_GIT}\n`,
    );
    expect(secrets.office.OFFICE_GIT).toStartWith("FlyV1 fm2_");
    expect(helper(5, "store")).toBe("");
    expect(helper(5, "erase")).toBe("");

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

  test("git never stores the proxy password in a member's credential store, also for a scope with no git helper", async () => {
    await runtime.enable();
    const result = store.create(AT_BOB, {
      name: "HEADER_KEY",
      value: BOB_VALUE,
      hosts: ["header.example-stub.test"],
      form: { kind: "header", header: "x-api-key" },
    });
    if (!result.ok) throw new Error(`create failed: ${result.kind}`);
    await runtime.changed();
    const env = buildEnvForUserId(BOB, { PATH: process.env.PATH ?? "" })!;
    const proxy = new URL(env.HTTPS_PROXY!);
    const home = mkdtempSync(join(tmpdir(), "proxy-git-store-"));
    try {
      const storeFile = join(home, ".git-credentials");
      writeFileSync(
        join(home, ".gitconfig"),
        `[credential]\n\thelper = store --file=${storeFile}\n`,
      );
      // What git does after a request through HTTPS_PROXY succeeds.
      const approve = (protocol: string, host: string) =>
        spawnSync("git", ["credential", "approve"], {
          input: `protocol=${protocol}\nhost=${host}\nusername=${proxy.username}\npassword=${proxy.password}\n\n`,
          env: { ...env, HOME: home, GIT_TERMINAL_PROMPT: "0" },
          encoding: "utf8",
        }).status;
      expect(approve("http", proxy.host)).toBe(0);
      expect(existsSync(storeFile)).toBe(false);
      // The member's store helper itself works: another address is stored.
      expect(approve("http", "company.example-stub.test:3128")).toBe(0);
      expect(readFileSync(storeFile, "utf8")).toContain(
        "company.example-stub.test",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
    expect(proxyAddress(alice.HTTPS_PROXY)).toBe(`http://127.0.0.1:${port}`);
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
    expect(proxyAddress(env.HTTPS_PROXY)).toBe(
      `http://127.0.0.1:${runtime.proxyPort}`,
    );
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

  test("a removed member's file marks their scope and drops their values", async () => {
    await runtime.enable();
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    add(AT_BOB, "BOB_TOKEN", BOB_VALUE);
    await runtime.changed();
    expect(values).toContain(ALICE_VALUE);
    changes = [];
    store.removeMember(ALICE);
    await runtime.changed();
    expect(changes).toEqual([[AT_ALICE]]);
    expect(runtime.environmentFor(ALICE)).toBeNull();
    expect(values).not.toContain(ALICE_VALUE);
    expect(values).toContain(BOB_VALUE);
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
      expect(proxyAddress(buildEnvForUserId(BOB)?.HTTPS_PROXY)).toBe(
        `http://127.0.0.1:${runtime.proxyPort}`,
      );
    } finally {
      squatter.close();
    }
  });
});

// Task 91296ea8: every OS user on the box can reach the proxy's loopback
// port; only the office's agents have the password in their HTTPS_PROXY.
describe("the proxy password", () => {
  const passwordOf = (userId: string) =>
    new URL(buildEnvForUserId(userId)!.HTTPS_PROXY!).password;

  test("a CONNECT without it gets 407 and never reaches the company proxy; one with an agent's HTTPS_PROXY chains", async () => {
    const target = "unlisted.example-stub.test:22";
    const echo = await startEchoStub();
    const company = await startCompanyProxy({ [target]: echo.port });
    try {
      await runtime.stop();
      runtime = makeRuntime({
        serverEnv: {
          HTTPS_PROXY: `http://dummyuser:dummypass@127.0.0.1:${company.port}`,
        },
      });
      add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
      await runtime.enable();
      const env = buildEnvForUserId(ALICE)!;
      expect(env.https_proxy).toBe(env.HTTPS_PROXY);
      const agentProxy = new URL(env.HTTPS_PROXY!);
      const port = Number(agentProxy.port);
      expect(port).toBe(runtime.proxyPort!);

      const stranger = await connectThrough(port, target, []);
      if (!("refused" in stranger)) {
        stranger.socket.destroy();
        throw new Error("the proxy opened a tunnel without the password");
      }
      expect(stranger.refused.status).toBe(407);
      expect(company.connects).toEqual([]);

      const agent = await connectThrough(port, target, [
        proxyBasic(
          decodeURIComponent(agentProxy.password),
          decodeURIComponent(agentProxy.username),
        ),
      ]);
      if ("refused" in agent)
        throw new Error(`refused ${agent.refused.status}`);
      agent.socket.write("ping");
      expect((await agent.reader.read(16))?.toString()).toBe("ping");
      agent.socket.destroy();
      expect(company.connects).toEqual([target]);
      expect(company.authorizations).toEqual([
        `Basic ${Buffer.from("dummyuser:dummypass").toString("base64")}`,
      ]);
    } finally {
      await company.close();
      await echo.close();
    }
  });

  test("is the same after a restart, and another office's key gives another one", async () => {
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    await runtime.enable();
    const first = passwordOf(ALICE);
    // A bearer another OS user cannot guess.
    expect(first.length).toBeGreaterThanOrEqual(32);

    await runtime.stop();
    runtime = makeRuntime();
    await runtime.enable();
    expect(passwordOf(ALICE)).toBe(first);

    // New secret material: a new placeholder key, as in another office.
    await runtime.stop();
    rmSync(join(STATE_ROOT, "secrets"), { recursive: true, force: true });
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    runtime = makeRuntime();
    await runtime.enable();
    expect(passwordOf(ALICE).length).toBeGreaterThanOrEqual(32);
    expect(passwordOf(ALICE)).not.toBe(first);
  });

  test("the OpenCode revision covers the proxy URL agents get", async () => {
    // A restart adopts a running OpenCode server whose revision matches, so
    // a server started before the password existed must not match.
    add(OFFICE, "OFFICE_KEY", OFFICE_VALUE);
    await runtime.enable();
    const secrets = runtime.environmentFor(ALICE)!;
    expect(secrets.revision).toContain(secrets.fixed.HTTPS_PROXY);
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
      userIdForUsername: () => ALICE,
      isOfficeOwnerUserId: () => false,
      auditReveal: () => {},
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
    expect(proxyAddress(runtime.environmentFor(ALICE)?.fixed.HTTPS_PROXY)).toBe(
      `http://127.0.0.1:${runtime.proxyPort}`,
    );
  });

  test("an unreadable office file leaves every member's environment working", async () => {
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    // A file this version does not read, as after a downgrade.
    writeFileSync(
      join(STATE_ROOT, "secrets", "office.json"),
      '{"version":2,"secrets":[]}\n',
    );
    await runtime.enable();
    const alice = buildEnvForUserId(ALICE)!;
    expect(alice.GH_TOKEN).toMatch(/^ghp_/);
    expect(proxyAddress(alice.HTTPS_PROXY)).toBe(
      `http://127.0.0.1:${runtime.proxyPort}`,
    );
    expect(() => buildEnvForUserId(BOB)).not.toThrow();
    expect(buildEnvForUserId(BOB)?.HTTPS_PROXY).toBeUndefined();
    expect(logs).toContain("store_unreadable");
  });
});

// Integrations A2b: an OAuth MCP server's refresh token and client secret
// are secrets the registration owns, never an agent's.
describe("secrets an OAuth registration owns", () => {
  const OWNED = "MCP_MAIL_OAUTH";
  const OWNED_CLIENT = "MCP_MAIL_OAUTH_CLIENT";
  const OWNED_VALUE = "fake-oauth-refresh-runtime-0001";
  const CLIENT_VALUE = "fake-oauth-client-runtime-0001";

  async function withOwned(owned: (scope: SecretScope) => string[] | null) {
    await runtime.stop();
    runtime = makeRuntime({ oauthOwned: owned });
    setSecretEnvironmentProvider((userId) => runtime.environmentFor(userId));
    add(AT_ALICE, OWNED, OWNED_VALUE);
    add(AT_ALICE, OWNED_CLIENT, CLIENT_VALUE);
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    await runtime.enable();
  }
  const listed = (scope: SecretScope) =>
    scope.kind === "user" && scope.userId === ALICE
      ? [OWNED, OWNED_CLIENT]
      : [];

  test("get no placeholder in an agent's environment; a plain secret in the scope still does", async () => {
    await withOwned(listed);
    const env = buildEnvForUserId(ALICE)!;
    expect(env[OWNED]).toBeUndefined();
    expect(env[OWNED_CLIENT]).toBeUndefined();
    expect(env.GH_TOKEN).toMatch(/^ghp_/);
    expect(envText(env)).not.toContain(OWNED_VALUE);
    // Log redaction still masks the owned values.
    expect(values).toContain(OWNED_VALUE);
  });

  test("do not show in a printenv of the agent's environment", async () => {
    await withOwned(listed);
    const env = buildEnvForUserId(ALICE)!;
    const printed = Bun.spawnSync(["printenv"], { env }).stdout.toString();
    expect(printed).toContain("GH_TOKEN=");
    expect(printed).not.toContain(OWNED);
    expect(printed).not.toContain(OWNED_VALUE);
  });

  test("are not in the proxy snapshot", async () => {
    await withOwned(listed);
    const names = runtime.snapshotSecrets().map((s) => s.name);
    expect(names).toContain("GH_TOKEN");
    expect(names).not.toContain(OWNED);
    expect(names).not.toContain(OWNED_CLIENT);
  });

  test("restart no agent when the flow rotates one", async () => {
    await withOwned(listed);
    await runtime.changed();
    changes = [];
    const revision = environmentSourceRevisionForUserId(ALICE);
    // Another prefix: a plain secret's placeholder would change here.
    store.rotate(AT_ALICE, OWNED, `github_pat_${"F".repeat(82)}`);
    await runtime.changed();
    expect(changes).toEqual([]);
    expect(environmentSourceRevisionForUserId(ALICE)).toBe(revision);
  });

  test("give git no credential helper; a plain secret on the same host does", async () => {
    await withOwned(listed);
    // The one plain secret on the host sorts after the owned names, so
    // without the filter an owned secret would take the host's slot.
    store.remove(AT_ALICE, "GH_TOKEN");
    add(AT_ALICE, "ZZ_PLAIN", "fake-plain-same-host-0001");
    const secrets = runtime.environmentFor(ALICE)!;
    expect(secrets.gitCredentials).toEqual([
      { host: "api.example-stub.test", placeholder: secrets.member.ZZ_PLAIN },
    ]);
  });

  test("stay out when the registrations cannot be read", async () => {
    await withOwned(() => null);
    const env = buildEnvForUserId(ALICE)!;
    expect(env[OWNED]).toBeUndefined();
    expect(env[OWNED_CLIENT]).toBeUndefined();
    expect(env.GH_TOKEN).toMatch(/^ghp_/);
    expect(runtime.snapshotSecrets().map((s) => s.name)).toEqual(["GH_TOKEN"]);
  });
});

// Task c7007f8b: a secret with apps and no hosts goes to apps only. Agents
// get no placeholder for it, so adding, rotating or removing one changes no
// agent; log redaction still masks its value.
describe("secrets that only apps read", () => {
  const BOT = { name: "bot", createdAt: 1 };
  const APP_VALUE = "fake-app-only-value-0001";
  const OFFICE_APP_VALUE = "fake-office-app-only-0001";

  function addAppOnly(scope: SecretScope, name: string, value: string) {
    const result = store.create(scope, {
      name,
      value,
      hosts: [],
      form: { kind: "authorization" },
      apps: [BOT],
    });
    if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  }

  test("give agents the environment of an office without secrets, and mark no restart", async () => {
    writeManagedOfficeEnv({ PLAIN: "office-plain" });
    const off = setSecretEnvironmentProvider(() => null);
    const before = {
      env: buildEnvForUserId(ALICE),
      key: environmentSourceKeyForUserId(ALICE),
      revision: environmentSourceRevisionForUserId(ALICE),
    };
    setSecretEnvironmentProvider(off);
    await runtime.enable();
    addAppOnly(OFFICE, "OFFICE_APP_KEY", OFFICE_APP_VALUE);
    addAppOnly(AT_ALICE, "APP_KEY", APP_VALUE);
    await runtime.changed();
    store.rotate(AT_ALICE, "APP_KEY", "fake-app-only-rotated-0001");
    await runtime.changed();
    expect(changes).toEqual([]);
    // No proxy and no CA: nothing for agents to send.
    expect(runtime.proxyPort).toBeNull();
    expect(existsSync(secretMaterialPaths(STATE_ROOT, STATE_ROOT).bundle)).toBe(
      false,
    );
    expect(runtime.environmentFor(ALICE)).toBeNull();
    expect(buildEnvForUserId(ALICE)).toEqual(before.env);
    expect(environmentSourceRevisionForUserId(ALICE)).toBe(before.revision);
    expect(runtime.snapshotSecrets()).toEqual([]);
    // Log redaction still masks both values.
    expect(values.sort()).toEqual(
      ["fake-app-only-rotated-0001", OFFICE_APP_VALUE].sort(),
    );
    store.remove(AT_ALICE, "APP_KEY");
    await runtime.changed();
    expect(changes).toEqual([]);
  });

  test("start no proxy at boot when they are the office's only secrets", async () => {
    addAppOnly(AT_ALICE, "APP_KEY", APP_VALUE);
    await runtime.enable();
    expect(runtime.proxyPort).toBeNull();
    expect(existsSync(secretMaterialPaths(STATE_ROOT, STATE_ROOT).bundle)).toBe(
      false,
    );
    expect(values).toEqual([APP_VALUE]);
  });

  test("have no placeholder and no snapshot entry beside a host secret of the same scope", async () => {
    await runtime.enable();
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    addAppOnly(AT_ALICE, "APP_KEY", APP_VALUE);
    await runtime.changed();
    const env = buildEnvForUserId(ALICE)!;
    expect(env.GH_TOKEN).toMatch(/^ghp_/);
    expect(env.APP_KEY).toBeUndefined();
    expect(envText(env)).not.toContain(APP_VALUE);
    expect(runtime.placeholderOf(AT_ALICE, "GH_TOKEN")).not.toBeNull();
    expect(runtime.placeholderOf(AT_ALICE, "APP_KEY")).toBeNull();
    expect(runtime.snapshotSecrets().map((s) => s.name)).toEqual(["GH_TOKEN"]);
  });

  test("an app added to or removed from a host secret marks no restart and keeps the revision", async () => {
    await runtime.enable();
    add(AT_ALICE, "GH_TOKEN", ALICE_VALUE);
    await runtime.changed();
    changes = [];
    const revision = environmentSourceRevisionForUserId(ALICE);
    store.update(AT_ALICE, "GH_TOKEN", { apps: [BOT] });
    await runtime.changed();
    store.update(AT_ALICE, "GH_TOKEN", { apps: [] });
    await runtime.changed();
    expect(changes).toEqual([]);
    expect(environmentSourceRevisionForUserId(ALICE)).toBe(revision);
  });
});
