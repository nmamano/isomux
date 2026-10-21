// Codex 0.160 reads neither OPENAI_API_KEY nor CODEX_API_KEY from the
// environment (task 5e0917f3). An agent whose env holds OPENAI_API_KEY and
// whose CODEX_HOME holds no stored sign-in is signed in with the key over
// JSON-RPC, on an app-server that keeps the login in memory only, so one
// member's key never lands in a shared CODEX_HOME. A stored sign-in wins over
// the key (task 23c1992a), so a subscription is not billed as API use. The
// sign-in card and the office usage probe always read the stored sign-in.
//
// The first block drives JsonRpcLiteClient against a fake app-server (a bun
// script that records its argv and every frame). The others run the bundled
// Codex app-server itself, against local endpoints only: account/read is
// local, and a turn goes to a fake Responses endpoint on 127.0.0.1.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JsonRpcLiteClient } from "./client.ts";
import { CodexAccountClient } from "./account.ts";
import { codexOfficeProbe } from "../../office-usage.ts";

const KEY = "sk-test-envlogin-0123456789abcdef";
const INIT = {
  clientInfo: { name: "isomux", version: "1", title: null },
  capabilities: {
    experimentalApi: true,
    requestAttestation: false,
    optOutNotificationMethods: null,
  },
} as const;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// A fake app-server: answers initialize at once and account/login/start
// after LOGIN_DELAY_MS, with an error that echoes the key when LOGIN_FAILS.
function fakeAppServer(dir: string): string {
  const bin = join(dir, "fake-app-server.ts");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "fs";
writeFileSync(process.env.ARGV_FILE!, JSON.stringify(process.argv.slice(2)));
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    appendFileSync(process.env.FRAMES_FILE!, line + "\\n");
    if (msg.method === "initialize")
      send({ id: msg.id, result: { userAgent: "fake" } });
    else if (msg.method === "account/login/start")
      setTimeout(() => {
        if (process.env.LOGIN_FAILS)
          send({ id: msg.id, error: { code: -32600, message: "refused " + msg.params.apiKey } });
        else send({ id: msg.id, result: { type: "apiKey" } });
      }, Number(process.env.LOGIN_DELAY_MS ?? 0));
    else if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function run(
  env: Record<string, string | undefined>,
  opts: { envApiKeyLogin?: boolean; loginFails?: boolean } = {},
) {
  const dir = tempDir("codex-env-login-");
  const argvFile = join(dir, "argv.json");
  const framesFile = join(dir, "frames");
  writeFileSync(framesFile, "");
  const client = new JsonRpcLiteClient({
    codexBin: fakeAppServer(dir),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: join(dir, "codex-home"),
      ARGV_FILE: argvFile,
      FRAMES_FILE: framesFile,
      LOGIN_DELAY_MS: "300",
      ...(opts.loginFails ? { LOGIN_FAILS: "1" } : {}),
      ...env,
    },
    skipSafetyPreflightForTestProbe: true,
    ...(opts.envApiKeyLogin === undefined
      ? {}
      : { envApiKeyLogin: opts.envApiKeyLogin }),
  });
  const begin = performance.now();
  let failure: unknown;
  try {
    await client.start();
    await client.initialize(INIT);
  } catch (err) {
    failure = err;
  }
  const elapsed = performance.now() - begin;
  // The initialized notification is fire-and-forget: let the fake record it
  // before the close kills it.
  for (let i = 0; i < 100; i++) {
    if (readFileSync(framesFile, "utf8").includes('"initialized"')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await client.close();
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  const frames = readFileSync(framesFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
  return { argv, frames, elapsed, failure };
}

// The pair that keeps the login out of CODEX_HOME, whatever its quoting.
const ephemeral = (argv: string[]) =>
  argv.some(
    (arg, i) =>
      argv[i - 1] === "-c" &&
      arg.includes("cli_auth_credentials_store") &&
      arg.includes("ephemeral"),
  );

describe("JsonRpcLiteClient with OPENAI_API_KEY in its env", () => {
  it("starts a memory-only login store and signs in with the key before initialize returns", async () => {
    const r = await run({ OPENAI_API_KEY: KEY });
    expect(r.failure).toBeUndefined();
    expect(ephemeral(r.argv)).toBe(true);
    expect(r.argv.join(" ")).not.toContain(KEY);
    expect(r.frames.map((f) => f.method)).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
    ]);
    expect(r.frames[2].params).toEqual({ type: "apiKey", apiKey: KEY });
    // initialize() waits for the login's answer (300 ms in the fake).
    expect(r.elapsed).toBeGreaterThanOrEqual(250);
  }, 15_000);

  for (const [name, env, envApiKeyLogin] of [
    ["no key", {}, undefined],
    ["an empty key", { OPENAI_API_KEY: "" }, undefined],
    ["a key, opted out", { OPENAI_API_KEY: KEY }, false],
  ] as const) {
    it(`${name}: the stored sign-in, with no login and no memory-only store`, async () => {
      const r = await run(env, { envApiKeyLogin });
      expect(r.failure).toBeUndefined();
      expect(ephemeral(r.argv)).toBe(false);
      expect(r.frames.map((f) => f.method)).toEqual([
        "initialize",
        "initialized",
      ]);
    }, 15_000);
  }

  it("a refused login fails initialize, and the message does not carry the key", async () => {
    const r = await run({ OPENAI_API_KEY: KEY }, { loginFails: true });
    expect(r.failure).toBeInstanceOf(Error);
    expect((r.failure as Error).message).not.toContain(KEY);
    expect(r.frames.map((f) => f.method)).toContain("account/login/start");
  }, 15_000);
});

describe("the bundled Codex app-server, an OPENAI_API_KEY and an empty CODEX_HOME", () => {
  const env = () => ({
    ...process.env,
    CODEX_HOME: tempDir("codex-env-login-home-"),
    OPENAI_API_KEY: KEY,
  });

  it("a session client is signed in with the key; the sign-in card is not", async () => {
    const homeEnv = env();
    const session = new JsonRpcLiteClient({ env: homeEnv });
    try {
      await session.start();
      await session.initialize(INIT);
      const read = await session.request<{ account: { type: string } | null }>(
        "account/read",
        { refreshToken: false },
      );
      expect(read.account?.type).toBe("apiKey");
    } finally {
      await session.close();
    }
    // Nothing was stored: the card on the same home sees no sign-in.
    const card = new CodexAccountClient(homeEnv);
    try {
      await card.start();
      expect(await card.read()).toEqual({ connected: false });
    } finally {
      await card.close();
    }
  }, 60_000);

  it("the office usage probe reads the stored sign-in, not the key", async () => {
    const probe = codexOfficeProbe(env());
    try {
      expect(await probe.read()).toEqual({ kind: "signed_out" });
    } finally {
      probe.close();
    }
  }, 60_000);
});

// Which credential a turn bills: the bundled app-server sends one turn to a
// fake Responses endpoint, which records the Authorization header and fails
// the turn. A ChatGPT sign-in cannot be stored offline (Codex checks it with
// chatgpt.com), so an auth.json from `codex login --with-api-key` with its
// own key stands in: any auth.json is a stored sign-in.
describe("the bundled Codex app-server, an OPENAI_API_KEY and a turn", () => {
  const STORED = "sk-test-stored-fedcba9876543210";

  async function bearerOfOneTurn(signedIn: boolean): Promise<string | null> {
    let resolveSeen!: (value: string | null) => void;
    const seen = new Promise<string | null>((r) => (resolveSeen = r));
    const mock = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname.endsWith("/responses"))
          resolveSeen(req.headers.get("authorization"));
        return new Response("{}", { status: 400 });
      },
    });
    const home = tempDir("codex-env-login-turn-");
    writeFileSync(
      join(home, "config.toml"),
      [
        'model_provider = "local"',
        "[model_providers.local]",
        'name = "local"',
        `base_url = "http://127.0.0.1:${mock.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "",
      ].join("\n"),
    );
    if (signedIn)
      writeFileSync(
        join(home, "auth.json"),
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: STORED }),
      );
    const client = new JsonRpcLiteClient({
      env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: KEY },
      // The safety hook would rewrite this config.toml; no tool runs here.
      skipSafetyPreflightForTestProbe: true,
    });
    try {
      await client.start();
      await client.initialize(INIT);
      const started = await client.request<{ thread: { id: string } }>(
        "thread/start",
        { cwd: home },
      );
      await client.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "hi", text_elements: [] }],
      });
      return await Promise.race([
        seen,
        new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
      ]);
    } finally {
      await client.close();
      await mock.stop(true);
      // The stored sign-in is read, never replaced by the key.
      if (signedIn) expect(existsSync(join(home, "auth.json"))).toBe(true);
    }
  }

  it("a stored sign-in: the turn uses it, not the key", async () => {
    expect(await bearerOfOneTurn(true)).toBe(`Bearer ${STORED}`);
  }, 60_000);

  it("no stored sign-in: the turn uses the key", async () => {
    expect(await bearerOfOneTurn(false)).toBe(`Bearer ${KEY}`);
  }, 60_000);
});
