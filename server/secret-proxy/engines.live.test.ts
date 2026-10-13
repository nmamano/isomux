// B2 acceptance, live tier (ISOMUX_TEST_LIVE=1): a throwaway office's
// secrets runtime with the real store, supervisor and proxy child, and real
// processes started with the environment buildEnvForUserId gives an agent.
//
// - curl with a placeholder reaches a listed stub host, which gets the value;
//   the reply comes back scrubbed.
// - printenv shows the placeholder, never the value.
// - Claude's remote MCP server, registered with the placeholder in its
//   header (as integrations A2 now does), reaches the listed host with the
//   value.
// - Claude, Codex and OpenCode, each with a fake key, reach their model host
//   (a stub that answers as api.anthropic.com or api.openai.com) through the
//   proxy as a tunnel, and the stub gets their own key untouched.
//
// No real provider: hosts the proxy does not stand in for go to a deny
// proxy (the company-proxy chain) that routes only the stub hosts.
//
// "Untouched" is proven by trust: the model stubs' CA (A) is in the agents'
// bundle (it stands in for the system roots) but not in the proxy's
// upstream roots (CA B, the listed stub's). A proxy that ended TLS for a
// model host could not reach the stub at all.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, createSecureContext, type Server } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STATE_ROOT } from "../config.ts";
import { CLAUDE_NATIVE_BIN } from "../cwd-utils.ts";
import {
  buildEnvForUserId,
  setSecretEnvironmentProvider,
} from "../env-loader.ts";
import { resolveCodexLauncherPath } from "../backends/codex/native-bin.ts";
import { resolveOpenCodeBinary } from "../backends/opencode/runtime.ts";
import { createSecretStore } from "../secret-store.ts";
import {
  startCompanyProxy,
  startHttpsStub,
} from "../test-support/secret-proxy-stubs.ts";
import {
  bodyFraming,
  ByteReader,
  readBody,
  readHead,
  serializeHead,
} from "./http1.ts";
import { createSecretsRuntime, type SecretsRuntime } from "./runtime.ts";

const LIVE = process.env.ISOMUX_TEST_LIVE === "1";
const HAS_OPENSSL = spawnSync("sh", ["-c", "command -v openssl"]).status === 0;

// Obvious fakes.
const VALUE = "ghp_FAKEliveFAKEliveFAKEliveFAKEliveFA01";
const FAKE_ANTHROPIC = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-live";
const FAKE_OPENAI = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKElive";
const MEMBER = "u-live";
const MODEL_HOSTS = [
  "api.anthropic.com",
  "mcp-proxy.anthropic.com",
  "api.openai.com",
  "chatgpt.com",
  "models.opencode.ai",
  "registry.npmjs.org",
];

interface Seen {
  sni: string;
  target: string;
  headers: [string, string][];
}

// CA A and one leaf per model host, with the openssl CLI: the office's own
// issuer refuses never-listed names, by design.
function mintModelCerts(dir: string) {
  const sh = (args: string[]) => {
    const result = spawnSync("openssl", args, { cwd: dir });
    if (result.status !== 0) throw new Error(`openssl ${args[0]} failed`);
  };
  sh([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "caA.key",
    "-out",
    "caA.pem",
    "-days",
    "2",
    "-subj",
    "/CN=live test CA A",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  ]);
  for (const host of MODEL_HOSTS) {
    sh([
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      `${host}.key`,
      "-out",
      `${host}.csr`,
      "-subj",
      `/CN=${host}`,
    ]);
    writeFileSync(
      join(dir, `${host}.ext`),
      `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid\nsubjectKeyIdentifier=hash\n`,
    );
    sh([
      "x509",
      "-req",
      "-in",
      `${host}.csr`,
      "-CA",
      "caA.pem",
      "-CAkey",
      "caA.key",
      "-CAcreateserial",
      "-out",
      `${host}.pem`,
      "-days",
      "2",
      "-extfile",
      `${host}.ext`,
    ]);
  }
}

// Answers like an API that refuses the key; the models list is empty.
function startModelStub(
  dir: string,
): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const contexts = new Map(
    MODEL_HOSTS.map((host) => [
      host,
      createSecureContext({
        cert: readFileSync(join(dir, `${host}.pem`)),
        key: readFileSync(join(dir, `${host}.key`)),
      }),
    ]),
  );
  const seen: Seen[] = [];
  const server = createServer(
    { SNICallback: (name, done) => done(null, contexts.get(name)) },
    (socket) => {
      socket.on("error", () => {});
      const reader = new ByteReader(socket);
      void (async () => {
        try {
          for (;;) {
            const head = await readHead(reader);
            if (!head) return void socket.end();
            const hasBody = head.headers.some(([n]) =>
              /^(content-length|transfer-encoding)$/i.test(n),
            );
            for await (const piece of readBody(
              reader,
              bodyFraming(head.headers, { strict: false, noBody: !hasBody }),
            ))
              void piece;
            const sni = (socket as unknown as { servername: string })
              .servername;
            seen.push({
              sni,
              target: head.startLine.split(" ")[1],
              headers: head.headers,
            });
            const models = sni === "models.opencode.ai";
            const body = models
              ? "{}"
              : JSON.stringify({
                  type: "error",
                  error: {
                    type: "authentication_error",
                    message: "invalid key (stub)",
                  },
                });
            socket.write(
              Buffer.concat([
                serializeHead(
                  `HTTP/1.1 ${models ? "200 OK" : "401 Unauthorized"}`,
                  [
                    ["Content-Type", "application/json"],
                    ["Content-Length", String(Buffer.byteLength(body))],
                  ],
                ),
                Buffer.from(body),
              ]),
            );
          }
        } catch {
          socket.destroy();
        }
      })();
    },
  );
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: (server.address() as { port: number }).port,
        seen,
      }),
    ),
  );
}

let runtime: SecretsRuntime;
let env: Record<string, string | undefined>;
let model: Awaited<ReturnType<typeof startModelStub>>;
let listed: Awaited<ReturnType<typeof startHttpsStub>>;
let deny: Awaited<ReturnType<typeof startCompanyProxy>>;
let restoreProvider: Parameters<typeof setSecretEnvironmentProvider>[0];
const uses: unknown[] = [];

async function run(cmd: string[], extra: Record<string, string>, ms: number) {
  const scratch = mkdtempSync(join(tmpdir(), "b2-live-run-"));
  const child = Bun.spawn(cmd, {
    cwd: scratch,
    env: {
      ...env,
      HOME: scratch,
      XDG_CONFIG_HOME: join(scratch, ".config"),
      XDG_DATA_HOME: join(scratch, ".data"),
      XDG_CACHE_HOME: join(scratch, ".cache"),
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), ms);
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  clearTimeout(timer);
  return out + err;
}

function header(seen: { headers: [string, string][] }, name: string) {
  return seen.headers.find(([n]) => n.toLowerCase() === name)?.[1] ?? "";
}

describe.skipIf(!LIVE || !HAS_OPENSSL)(
  "a throwaway office with a secret, real tools and engines (live; SKIPPED without ISOMUX_TEST_LIVE=1 or openssl)",
  () => {
    beforeAll(async () => {
      const certs = mkdtempSync(join(tmpdir(), "b2-live-certs-"));
      mintModelCerts(certs);
      model = await startModelStub(certs);
      listed = await startHttpsStub(["api.stub-listed.test"]);
      deny = await startCompanyProxy(
        Object.fromEntries(MODEL_HOSTS.map((h) => [`${h}:443`, model.port])),
      );
      const store = createSecretStore();
      store.create(
        { kind: "user", userId: MEMBER },
        {
          name: "GH_TOKEN",
          value: VALUE,
          hosts: ["api.stub-listed.test"],
          form: { kind: "authorization" },
        },
      );
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
            standIns: { "api.stub-listed.test:443": listed.port },
            upstreamRoots: listed.ca.certPem,
          }),
        },
        systemRootsPem: readFileSync(join(certs, "caA.pem"), "utf8"),
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
      await listed?.close();
      await deny?.close();
      model?.server.close();
    });

    test("curl with the placeholder reaches the listed host, which gets the value; the reply is scrubbed", async () => {
      const out = await run(
        [
          "curl",
          "-sS",
          "--max-time",
          "10",
          "-H",
          `Authorization: Bearer ${env.GH_TOKEN}`,
          "https://api.stub-listed.test/headers",
        ],
        {},
        15000,
      );
      expect(listed.seen).toHaveLength(1);
      expect(listed.seen[0].headers).toContainEqual([
        "Authorization",
        `Bearer ${VALUE}`,
      ]);
      expect(out).toStartWith("authorization=Bearer ");
      expect(out).not.toContain(VALUE);
      expect(uses).toHaveLength(1);
    }, 20000);

    test("printenv shows the placeholder and never the value", async () => {
      const out = await run(["printenv"], {}, 10000);
      expect(out).toContain(`GH_TOKEN=${env.GH_TOKEN}`);
      expect(out).toContain(`HTTPS_PROXY=${env.HTTPS_PROXY}`);
      expect(out).not.toContain(VALUE);
    }, 15000);

    test("Claude reaches api.anthropic.com through a tunnel with its own key, and its MCP server gets the value", async () => {
      model.seen.length = 0;
      listed.seen.length = 0;
      const mcpConfig = JSON.stringify({
        mcpServers: {
          docs: {
            type: "http",
            url: "https://api.stub-listed.test/mcp",
            headers: { Authorization: `Bearer ${env.GH_TOKEN}` },
          },
        },
      });
      const out = await run(
        [
          CLAUDE_NATIVE_BIN,
          "-p",
          "hello",
          "--output-format",
          "json",
          "--mcp-config",
          mcpConfig,
        ],
        {
          CLAUDE_CONFIG_DIR: join(STATE_ROOT, "live-claude"),
          ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
        },
        15000,
      );
      const call = model.seen.find(
        (s) =>
          s.sni === "api.anthropic.com" && s.target.startsWith("/v1/messages"),
      );
      expect(call).toBeDefined();
      expect(header(call!, "x-api-key")).toBe(FAKE_ANTHROPIC);
      const mcp = listed.seen.find(
        (s) => s.method === "POST" && s.target === "/mcp",
      );
      expect(mcp).toBeDefined();
      expect(header(mcp!, "authorization")).toBe(`Bearer ${VALUE}`);
      expect(out).not.toContain(VALUE);
    }, 30000);

    test("Codex reaches api.openai.com through a tunnel with its own key", async () => {
      model.seen.length = 0;
      mkdirSync(join(STATE_ROOT, "live-codex"), { recursive: true });
      const out = await run(
        [
          process.execPath,
          resolveCodexLauncherPath(),
          "exec",
          "--skip-git-repo-check",
          "hello",
        ],
        {
          CODEX_HOME: join(STATE_ROOT, "live-codex"),
          OPENAI_API_KEY: FAKE_OPENAI,
          CODEX_API_KEY: FAKE_OPENAI,
        },
        25000,
      );
      const call = model.seen.find(
        (s) =>
          s.sni === "api.openai.com" && s.target.startsWith("/v1/responses"),
      );
      expect(call).toBeDefined();
      expect(header(call!, "authorization")).toBe(`Bearer ${FAKE_OPENAI}`);
      expect(out).not.toContain(VALUE);
    }, 30000);

    test("OpenCode reaches api.anthropic.com through a tunnel with its own key", async () => {
      model.seen.length = 0;
      const out = await run(
        [
          resolveOpenCodeBinary(),
          "run",
          "--model",
          "anthropic/claude-sonnet-4-5",
          "hello",
        ],
        {
          ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
        },
        25000,
      );
      const call = model.seen.find(
        (s) =>
          s.sni === "api.anthropic.com" && s.target.startsWith("/v1/messages"),
      );
      expect(call).toBeDefined();
      expect(header(call!, "x-api-key")).toBe(FAKE_ANTHROPIC);
      expect(out).not.toContain(VALUE);
    }, 30000);

    test("no tool reached a host outside the stubs", () => {
      const allowed = new Set(MODEL_HOSTS.map((h) => `${h}:443`));
      // Codex asks for github.com and api.github.com at start; the deny
      // proxy refuses them, as it refuses any host it does not route.
      const others = [...new Set(deny.connects)].filter((c) => !allowed.has(c));
      expect(
        others.every(
          (c) => c === "github.com:443" || c === "api.github.com:443",
        ),
      ).toBe(true);
    });
  },
);
