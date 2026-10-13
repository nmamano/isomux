// B3 acceptance: each preset end to end. A throwaway office's secrets
// runtime holds a GitHub, a Stripe and a Fly secret on their preset hosts and
// forms; an agent's ordinary tools, started with the environment
// buildEnvForUserId gives an agent, call one read operation each with no
// extra setup.
//
// The preset host names reach one HTTPS stub through the proxy's standIns
// seam, so nothing resolves differently for a real agent. The stub answers
// as the real service would for that call and refuses any other credential.
// Every other host goes to a deny proxy (the company-proxy chain) that
// routes nothing.
//
// Tiers: curl and git run everywhere (CI included); gh, stripe and the SDKs
// run under ISOMUX_TEST_LIVE=1. A tool whose binary is not on PATH skips its
// test. Only tools known to honor HTTPS_PROXY (curl, git, Go CLIs) call a
// preset host name; the SDK checks call a .invalid host, so an SDK that
// bypassed the proxy would fail DNS instead of reaching a real service.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createSecureContext, createServer, type TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STATE_ROOT } from "../config.ts";
import {
  buildEnvForUserId,
  setSecretEnvironmentProvider,
} from "../env-loader.ts";
import { createSecretStore } from "../secret-store.ts";
import { SECRET_PRESETS } from "../../shared/secret-hosts.ts";
import { startCompanyProxy } from "../test-support/secret-proxy-stubs.ts";
import {
  bodyFraming,
  ByteReader,
  readBody,
  readHead,
  serializeHead,
  type HeaderList,
} from "./http1.ts";
import { createCertificateAuthority, createLeafIssuer } from "./x509.ts";
import { createSecretsRuntime, type SecretsRuntime } from "./runtime.ts";
import type { ProxyUse } from "./proxy.ts";

const LIVE = process.env.ISOMUX_TEST_LIVE === "1";
const has = (bin: string) =>
  spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

// Obvious fakes, in each provider's shape.
const VALUES = {
  github: "ghp_FAKEtoolsFAKEtoolsFAKEtoolsFAKEto01",
  stripe: `sk_test_${"FAKEtools".repeat(11)}`,
  fly: `FlyV1 fm2_${"FAKEtools".repeat(7)}`,
  sdk: "fake-sdk-value-FAKEtoolsFAKEtools01",
};
// The member's own GitHub token in their git credential store: git must
// never send it, and the office helper must never change the store.
const MEMBER_OWN = "ghp_FAKEmemberOWNFAKEmemberOWNFAKEmemb01";
const SDK_HOST = "api.sdk-stub.invalid";
const MEMBER = "u-tools";
const SHA = "1111111111111111111111111111111111111111";

interface Seen {
  sni: string;
  method: string;
  target: string;
  headers: HeaderList;
}

function header(seen: Seen, name: string) {
  return seen.headers.find(([n]) => n.toLowerCase() === name)?.[1] ?? "";
}

function basicPassword(auth: string): string | null {
  const match = /^Basic (.+)$/i.exec(auth);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("latin1");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}

function basicUser(auth: string): string | null {
  const match = /^Basic (.+)$/i.exec(auth);
  if (!match) return null;
  return Buffer.from(match[1], "base64").toString("latin1").split(":")[0];
}

function pkt(line: string) {
  return (Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line;
}

type Reply = { status: string; headers: HeaderList; body: string };
const json = (status: string, body: unknown): Reply => ({
  status,
  headers: [["Content-Type", "application/json"]],
  body: JSON.stringify(body),
});

// One read call per service, as the real one answers it.
function answer(seen: Seen): Reply {
  const auth = header(seen, "authorization");
  const url = new URL(seen.target, `https://${seen.sni}`);
  switch (seen.sni) {
    case "api.github.com": {
      // gh sends "token <t>", the docs "Bearer <t>".
      const ok =
        auth === `token ${VALUES.github}` || auth === `Bearer ${VALUES.github}`;
      if (!ok)
        return json("401 Unauthorized", {
          message: "Bad credentials",
          status: "401",
        });
      if (url.pathname === "/user")
        return json("200 OK", { login: "stub-user", id: 1, type: "User" });
      return json("404 Not Found", { message: "Not Found" });
    }
    case "github.com": {
      // git smart HTTP: 401 with a Basic challenge first, as for a private
      // repository.
      if (basicPassword(auth) !== VALUES.github)
        return {
          status: "401 Unauthorized",
          headers: [["WWW-Authenticate", 'Basic realm="GitHub"']],
          body: "",
        };
      // A repository the token cannot read: git then runs "erase".
      if (url.pathname.startsWith("/stub-org/denied.git/"))
        return {
          status: "401 Unauthorized",
          headers: [["WWW-Authenticate", 'Basic realm="GitHub"']],
          body: "",
        };
      if (
        url.pathname === "/stub-org/stub-repo.git/info/refs" &&
        url.searchParams.get("service") === "git-upload-pack"
      )
        return {
          status: "200 OK",
          headers: [
            ["Content-Type", "application/x-git-upload-pack-advertisement"],
            ["Cache-Control", "no-cache"],
          ],
          body:
            pkt("# service=git-upload-pack\n") +
            "0000" +
            pkt(`${SHA} HEAD\0symref=HEAD:refs/heads/main agent=stub\n`) +
            pkt(`${SHA} refs/heads/main\n`) +
            "0000",
        };
      return { status: "404 Not Found", headers: [], body: "" };
    }
    case "api.stripe.com": {
      // Stripe takes the key as Bearer or as the Basic user.
      const ok =
        auth === `Bearer ${VALUES.stripe}` || basicUser(auth) === VALUES.stripe;
      if (!ok)
        return json("401 Unauthorized", {
          error: { type: "invalid_request_error", message: "Invalid API Key" },
        });
      if (url.pathname === "/v1/balance")
        return json("200 OK", {
          object: "balance",
          available: [{ amount: 0, currency: "usd" }],
          livemode: false,
          pending: [{ amount: 0, currency: "usd" }],
        });
      return json("404 Not Found", {
        error: { type: "invalid_request_error" },
      });
    }
    case "api.machines.dev": {
      if (auth !== `Bearer ${VALUES.fly}` && auth !== VALUES.fly)
        return json("401 Unauthorized", { error: "unauthorized" });
      if (url.pathname === "/v1/apps")
        return json("200 OK", { total_apps: 0, apps: [] });
      return json("404 Not Found", { error: "not found" });
    }
    case SDK_HOST: {
      if (auth !== `Bearer ${VALUES.sdk}` && basicUser(auth) !== VALUES.sdk)
        return json("401 Unauthorized", { error: "unauthorized" });
      return json("200 OK", { ok: true });
    }
  }
  return json("404 Not Found", {});
}

async function startServiceStub(names: string[]) {
  const ca = createCertificateAuthority();
  const issuer = createLeafIssuer(ca, () => true);
  const contexts = new Map(
    names.map((name) => {
      const leaf = issuer.issue(name);
      return [
        name,
        createSecureContext({ cert: leaf.certPem, key: leaf.keyPem }),
      ];
    }),
  );
  const seen: Seen[] = [];
  const open = new Set<TLSSocket>();
  const server = createServer(
    { SNICallback: (name, done) => done(null, contexts.get(name)) },
    (socket) => {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
      socket.on("error", () => {});
      const reader = new ByteReader(socket);
      void (async () => {
        try {
          for (;;) {
            const head = await readHead(reader);
            if (!head) return void socket.end();
            const [method, target] = head.startLine.split(" ");
            for await (const piece of readBody(
              reader,
              bodyFraming(head.headers, { strict: true }),
            ))
              void piece;
            const request = {
              sni: (socket as unknown as { servername: string }).servername,
              method,
              target,
              headers: head.headers,
            };
            seen.push(request);
            const reply = answer(request);
            const body = Buffer.from(reply.body, "latin1");
            socket.write(
              Buffer.concat([
                serializeHead(`HTTP/1.1 ${reply.status}`, [
                  ...reply.headers,
                  ["Content-Length", String(body.length)],
                ]),
                body,
              ]),
            );
          }
        } catch {
          socket.destroy();
        }
      })();
    },
  );
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
  return {
    ca,
    port,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const socket of open) socket.destroy();
        server.close(() => r());
      }),
  };
}

const preset = (id: string) => SECRET_PRESETS.find((p) => p.id === id)!;
const HOSTS = [
  ...new Set([...SECRET_PRESETS.flatMap((p) => p.hosts), SDK_HOST]),
].sort();

let runtime: SecretsRuntime;
let env: Record<string, string | undefined>;
let stub: Awaited<ReturnType<typeof startServiceStub>>;
let deny: Awaited<ReturnType<typeof startCompanyProxy>>;
let restoreProvider: Parameters<typeof setSecretEnvironmentProvider>[0];
const uses: ProxyUse[] = [];
const scratches: string[] = [];

function newHome() {
  const scratch = mkdtempSync(join(tmpdir(), "b3-tools-run-"));
  scratches.push(scratch);
  return scratch;
}

// An agent's command: a shell with the agent's environment and a fresh home.
async function run(
  script: string,
  extra: Record<string, string> = {},
  scratch = newHome(),
) {
  const child = Bun.spawn(["sh", "-c", script], {
    cwd: scratch,
    env: {
      ...env,
      HOME: scratch,
      XDG_CONFIG_HOME: join(scratch, ".config"),
      XDG_DATA_HOME: join(scratch, ".data"),
      XDG_CACHE_HOME: join(scratch, ".cache"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(scratch, ".gitconfig"),
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_PROMPT_DISABLED: "1",
      STRIPE_CLI_TELEMETRY_OPTOUT: "1",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15000);
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  clearTimeout(timer);
  return { code, out: out + err };
}

// What every tool test checks after its call: the stub got the value in the
// preset's form, the tool printed no value, and the use is in the log.
function expectDelivered(
  sni: string,
  form: (s: Seen) => boolean,
  out: string,
  secret: string,
) {
  const calls = stub.seen.filter((s) => s.sni === sni);
  expect(calls.some(form)).toBe(true);
  for (const value of Object.values(VALUES)) expect(out).not.toContain(value);
  expect(uses.some((u) => u.name === secret && u.host === sni)).toBe(true);
}

function reset() {
  stub.seen.length = 0;
  uses.length = 0;
}

beforeAll(async () => {
  rmSync(join(STATE_ROOT, "secrets"), { recursive: true, force: true });
  stub = await startServiceStub(HOSTS);
  deny = await startCompanyProxy({});
  const store = createSecretStore();
  const sdk = store.create(
    { kind: "user", userId: MEMBER },
    {
      name: "SDK_TOKEN",
      value: VALUES.sdk,
      hosts: [SDK_HOST],
      form: { kind: "authorization" },
    },
  );
  if (!sdk.ok) throw new Error(`create sdk: ${sdk.kind}`);
  for (const id of ["github", "stripe", "fly"] as const) {
    const value = VALUES[id];
    const p = preset(id);
    const result = store.create(
      { kind: "user", userId: MEMBER },
      { name: p.name, value, hosts: p.hosts, form: p.form },
    );
    if (!result.ok) throw new Error(`create ${id}: ${result.kind}`);
  }
  runtime = createSecretsRuntime({
    store,
    stateRoot: STATE_ROOT,
    shareRoot: STATE_ROOT,
    serverEnv: { HTTPS_PROXY: `http://127.0.0.1:${deny.port}` },
    onUse: (use) => uses.push(use),
    onSetChanged: () => {},
    onValues: () => {},
    log: () => {},
    childEntry: join(
      import.meta.dir,
      "..",
      "test-support",
      "secret-proxy-test-child.ts",
    ),
    childEnv: {
      PATH: process.env.PATH ?? "",
      ISOMUX_TEST_PROXY_SEAMS: JSON.stringify({
        standIns: Object.fromEntries(HOSTS.map((h) => [`${h}:443`, stub.port])),
        upstreamRoots: stub.ca.certPem,
      }),
    },
  });
  restoreProvider = setSecretEnvironmentProvider((userId) =>
    runtime.environmentFor(userId),
  );
  await runtime.enable();
  env = buildEnvForUserId(MEMBER)!;
});

afterAll(async () => {
  setSecretEnvironmentProvider(restoreProvider);
  await runtime?.stop();
  await stub?.close();
  await deny?.close();
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
  rmSync(join(STATE_ROOT, "secrets"), { recursive: true, force: true });
});

const sdkReached = (s: Seen) =>
  s.target === "/check" &&
  (header(s, "authorization") === `Bearer ${VALUES.sdk}` ||
    basicUser(header(s, "authorization")) === VALUES.sdk);

describe("each preset end to end: curl and git (stub hosts only)", () => {
  test("the environment holds placeholders in each preset's shape, never a value", () => {
    expect(env.GH_TOKEN).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    expect(env.STRIPE_API_KEY).toMatch(/^sk_test_[A-Za-z0-9]{99}$/);
    expect(env.FLY_API_TOKEN).toMatch(/^FlyV1 fm2_[A-Za-z0-9]{64}$/);
    const text = JSON.stringify(env);
    for (const value of Object.values(VALUES))
      expect(text).not.toContain(value);
  });

  test.skipIf(!has("curl"))(
    "curl: GitHub GET /user with the placeholder as a Bearer token",
    async () => {
      reset();
      const { code, out } = await run(
        'curl -sS --max-time 10 -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user',
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).login).toBe("stub-user");
      expectDelivered(
        "api.github.com",
        (s) => header(s, "authorization") === `Bearer ${VALUES.github}`,
        out,
        "GH_TOKEN",
      );
    },
    20000,
  );

  test.skipIf(!has("curl"))(
    "curl: Stripe GET /v1/balance with the key as the Basic user, as Stripe's docs show",
    async () => {
      reset();
      const { code, out } = await run(
        'curl -sS --max-time 10 -u "$STRIPE_API_KEY:" https://api.stripe.com/v1/balance',
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).object).toBe("balance");
      expectDelivered(
        "api.stripe.com",
        (s) => basicUser(header(s, "authorization")) === VALUES.stripe,
        out,
        "STRIPE_API_KEY",
      );
    },
    20000,
  );

  test.skipIf(!has("curl"))(
    "curl: Fly Machines GET /v1/apps with the placeholder in the documented Bearer form",
    async () => {
      reset();
      const { code, out } = await run(
        'curl -sS --max-time 10 -H "Authorization: Bearer $FLY_API_TOKEN" "https://api.machines.dev/v1/apps?org_slug=personal"',
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).apps).toEqual([]);
      expectDelivered(
        "api.machines.dev",
        (s) => header(s, "authorization") === `Bearer ${VALUES.fly}`,
        out,
        "FLY_API_TOKEN",
      );
    },
    20000,
  );

  test.skipIf(!has("curl"))(
    "curl: Fly Machines GET /v1/apps with the placeholder as the whole header, as flyctl sends a Fly token",
    async () => {
      reset();
      const { code, out } = await run(
        'curl -sS --max-time 10 -H "Authorization: $FLY_API_TOKEN" "https://api.machines.dev/v1/apps?org_slug=personal"',
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).apps).toEqual([]);
      expectDelivered(
        "api.machines.dev",
        (s) => header(s, "authorization") === VALUES.fly,
        out,
        "FLY_API_TOKEN",
      );
    },
    20000,
  );

  test.skipIf(!has("git"))(
    "git over HTTPS: ls-remote gets the placeholder from the office credential helper, and the proxy swaps the Basic password",
    async () => {
      reset();
      const { code, out } = await run(
        "git ls-remote https://github.com/stub-org/stub-repo.git",
      );
      expect(code).toBe(0);
      expect(out).toContain(`${SHA}\trefs/heads/main`);
      expectDelivered(
        "github.com",
        (s) =>
          basicUser(header(s, "authorization")) === "x-access-token" &&
          basicPassword(header(s, "authorization")) === VALUES.github,
        out,
        "GH_TOKEN",
      );
    },
    20000,
  );

  test.skipIf(!has("git"))(
    "git: the member's own credential store is never asked and never changed, after a success or a 401",
    async () => {
      reset();
      const home = newHome();
      const storeFile = join(home, ".git-credentials");
      const stored = `https://stub-member:${MEMBER_OWN}@github.com\n`;
      writeFileSync(storeFile, stored);
      writeFileSync(
        join(home, ".gitconfig"),
        `[credential]\n\thelper = store --file=${storeFile}\n`,
      );
      const ok = await run(
        "git ls-remote https://github.com/stub-org/stub-repo.git",
        {},
        home,
      );
      expect(ok.code).toBe(0);
      expect(readFileSync(storeFile, "utf8")).toBe(stored);
      const denied = await run(
        "git ls-remote https://github.com/stub-org/denied.git",
        {},
        home,
      );
      expect(denied.code).not.toBe(0);
      expect(readFileSync(storeFile, "utf8")).toBe(stored);
      const calls = stub.seen.filter((s) => s.sni === "github.com");
      expect(
        calls.some(
          (s) => basicPassword(header(s, "authorization")) === VALUES.github,
        ),
      ).toBe(true);
      // The member's token never left the machine.
      expect(
        calls.every(
          (s) => basicPassword(header(s, "authorization")) !== MEMBER_OWN,
        ),
      ).toBe(true);
      expect(ok.out + denied.out).not.toContain(VALUES.github);
    },
    20000,
  );

  test.skipIf(!has("git"))(
    "git: a store with no entry for the host stays as it is after a success and a 401: git never stores the placeholder there",
    async () => {
      reset();
      const home = newHome();
      const storeFile = join(home, ".git-credentials");
      // One entry, for another host.
      const stored = `https://stub-member:${MEMBER_OWN}@git.example.test\n`;
      writeFileSync(storeFile, stored);
      writeFileSync(
        join(home, ".gitconfig"),
        `[credential]\n\thelper = store --file=${storeFile}\n`,
      );
      const ok = await run(
        "git ls-remote https://github.com/stub-org/stub-repo.git",
        {},
        home,
      );
      expect(ok.code).toBe(0);
      expect(readFileSync(storeFile, "utf8")).toBe(stored);
      const denied = await run(
        "git ls-remote https://github.com/stub-org/denied.git",
        {},
        home,
      );
      expect(denied.code).not.toBe(0);
      expect(readFileSync(storeFile, "utf8")).toBe(stored);
      expect(ok.out + denied.out).not.toContain(VALUES.github);
    },
    20000,
  );
});

describe.skipIf(!LIVE)(
  "each preset end to end: gh, stripe and the SDKs (live; SKIPPED without ISOMUX_TEST_LIVE=1)",
  () => {
    test.skipIf(!has("gh"))(
      "gh: gh auth token prints the placeholder, and gh api user reaches GitHub with the value",
      async () => {
        reset();
        const token = await run("gh auth token");
        expect(token.out.trim()).toBe(env.GH_TOKEN!);
        const { code, out } = await run("gh api user");
        expect(code).toBe(0);
        expect(JSON.parse(out).login).toBe("stub-user");
        expectDelivered(
          "api.github.com",
          (s) =>
            s.target === "/user" &&
            header(s, "authorization") === `token ${VALUES.github}`,
          out,
          "GH_TOKEN",
        );
      },
      30000,
    );

    test.skipIf(!has("stripe"))(
      "stripe: stripe balance retrieve reaches Stripe with the value",
      async () => {
        reset();
        const { code, out } = await run("stripe balance retrieve");
        expect(code).toBe(0);
        expect(JSON.parse(out.split("\n")[0]).object).toBe("balance");
        expectDelivered(
          "api.stripe.com",
          (s) =>
            s.target.startsWith("/v1/balance") &&
            (header(s, "authorization") === `Bearer ${VALUES.stripe}` ||
              basicUser(header(s, "authorization")) === VALUES.stripe),
          out,
          "STRIPE_API_KEY",
        );
      },
      30000,
    );

    test.skipIf(!has("node"))(
      "Node fetch",
      async () => {
        reset();
        const { code, out } = await run(
          `node -e 'fetch("https://${SDK_HOST}/check", { headers: { authorization: "Bearer " + process.env.SDK_TOKEN } }).then((r) => r.text()).then((t) => console.log(t))'`,
        );
        expect(code).toBe(0);
        expect(JSON.parse(out).ok).toBe(true);
        expectDelivered(SDK_HOST, sdkReached, out, "SDK_TOKEN");
      },
      20000,
    );

    test.skipIf(!has("node"))(
      "Node https.get (its own HTTP client, not fetch)",
      async () => {
        reset();
        const { code, out } = await run(
          `node -e 'require("node:https").get("https://${SDK_HOST}/check", { headers: { authorization: "Bearer " + process.env.SDK_TOKEN } }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => console.log(b)); })'`,
        );
        expect(code).toBe(0);
        expect(JSON.parse(out).ok).toBe(true);
        expectDelivered(SDK_HOST, sdkReached, out, "SDK_TOKEN");
      },
      20000,
    );

    test("Bun fetch", async () => {
      reset();
      const { code, out } = await run(
        `"${process.execPath}" -e 'const r = await fetch("https://${SDK_HOST}/check", { headers: { authorization: "Bearer " + process.env.SDK_TOKEN } }); console.log(await r.text())'`,
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).ok).toBe(true);
      expectDelivered(SDK_HOST, sdkReached, out, "SDK_TOKEN");
    }, 20000);

    test.skipIf(
      spawnSync("python3", ["-I", "-c", "import requests"]).status !== 0,
    )(
      "Python requests, with the token as the Basic user",
      async () => {
        reset();
        const { code, out } = await run(
          `python3 -I -c 'import os, requests; r = requests.get("https://${SDK_HOST}/check", auth=(os.environ["SDK_TOKEN"], ""), timeout=10); print(r.text)'`,
        );
        expect(code).toBe(0);
        expect(JSON.parse(out).ok).toBe(true);
        expectDelivered(SDK_HOST, sdkReached, out, "SDK_TOKEN");
      },
      20000,
    );
  },
);

test("no tool reached a host outside the stubs", () => {
  expect(deny.connects).toEqual([]);
});
