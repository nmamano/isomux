// A2b acceptance, live tier (ISOMUX_TEST_LIVE=1): a member's OAuth MCP
// server, signed in once against the stub authorization server, reaches a
// real Claude, Codex and OpenCode process with the access token. The refresh
// and a refused refresh change only what mcpServersForUserId gives, which
// server/mcp-oauth.test.ts proves without an engine.
//
// The stub MCP host is a TLS stub that records each request's headers; the
// engines reach it through a CONNECT proxy that routes only the stub hosts,
// and trust only the stub's CA. The proxy refuses every other host, model
// hosts included, so no real provider is called. Each engine gets the server the way
// mcpServersForUserId gives it, in a config file. That proves the shapes
// Isomux builds, not the running office's channels (setMcpServers, the
// app-server thread config, the profile supervisor), which A2 proved.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_NATIVE_BIN } from "./cwd-utils.ts";
import { sdkMcpRegistration } from "./backends/claude.ts";
import { codexThreadConfig } from "./backends/codex/adapter.ts";
import { resolveCodexLauncherPath } from "./backends/codex/native-bin.ts";
import { resolveOpenCodeBinary } from "./backends/opencode/runtime.ts";
import { openCodeConfigFor } from "./backends/opencode/supervisor.ts";
import { createMcpOAuth } from "./mcp-oauth.ts";
import { resetOAuthTokens } from "./mcp-oauth-tokens.ts";
import { createMcpServerSources, mcpServersForUserId } from "./mcp-servers.ts";
import { LEAK, MCP_URL, stubRig } from "./test-support/mcp-oauth-stub.ts";
import {
  startCompanyProxy,
  startHttpsStub,
} from "./test-support/secret-proxy-stubs.ts";

const LIVE = process.env.ISOMUX_TEST_LIVE === "1";
const MEMBER = "u-live-oauth";
const MCP_HOST = new URL(MCP_URL).hostname;
const FAKE_ANTHROPIC = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE-oauth";
const FAKE_OPENAI = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKEoauth";

let root: string;
let stub: Awaited<ReturnType<typeof startHttpsStub>>;
let deny: Awaited<ReturnType<typeof startCompanyProxy>>;
let bundle: string;
const clock = Date.now();
const rig = stubRig();
let sources: ReturnType<typeof createMcpServerSources>;
let oauth: ReturnType<typeof createMcpOAuth>;

function header(headers: [string, string][], name: string): string {
  return headers.find(([n]) => n.toLowerCase() === name)?.[1] ?? "";
}

// The Authorization headers the stub MCP host got since the last call.
function mcpAuthorizations(): string[] {
  const seen = stub.seen
    .filter((s) => s.sni === MCP_HOST && s.target.startsWith("/mcp"))
    .map((s) => header(s.headers, "authorization"));
  stub.seen.length = 0;
  return seen;
}

// True once the stub MCP host has a request with an Authorization header.
function mcpReached(): boolean {
  return stub.seen.some(
    (s) =>
      s.sni === MCP_HOST &&
      s.target.startsWith("/mcp") &&
      header(s.headers, "authorization") !== "",
  );
}

// No engine exits by itself here (its model host is refused), so a run ends
// as soon as the stub MCP host has an authorized request. `ceilingMs` is
// only a safety net for an engine that never gets there.
async function run(
  cmd: string[],
  extra: Record<string, string>,
  ceilingMs: number,
): Promise<string> {
  const scratch = mkdtempSync(join(root, "run-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, ".config"),
    XDG_DATA_HOME: join(scratch, ".data"),
    XDG_CACHE_HOME: join(scratch, ".cache"),
    HTTPS_PROXY: `http://127.0.0.1:${deny.port}`,
    https_proxy: `http://127.0.0.1:${deny.port}`,
    NO_PROXY: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
    SSL_CERT_FILE: bundle,
    NODE_EXTRA_CA_CERTS: bundle,
    CODEX_CA_CERTIFICATE: bundle,
    ...extra,
  };
  const child = Bun.spawn(cmd, {
    cwd: scratch,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const started = Date.now();
  const poll = setInterval(() => {
    if (mcpReached() || Date.now() - started > ceilingMs) child.kill();
  }, 100);
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  clearInterval(poll);
  return out + err;
}

async function claude(): Promise<string> {
  const servers = mcpServersForUserId(sources, MEMBER);
  const config = join(mkdtempSync(join(root, "claude-")), "mcp.json");
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: sdkMcpRegistration("live", servers)?.servers ?? {},
    }),
  );
  return run(
    [
      CLAUDE_NATIVE_BIN,
      "-p",
      "hello",
      "--output-format",
      "json",
      "--mcp-config",
      config,
    ],
    {
      CLAUDE_CONFIG_DIR: mkdtempSync(join(root, "claude-config-")),
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
    },
    45000,
  );
}

async function codex(): Promise<string> {
  const home = mkdtempSync(join(root, "codex-"));
  // The thread config's keys, as config.toml lines.
  const lines: string[] = [];
  for (const [key, value] of Object.entries(
    codexThreadConfig(mcpServersForUserId(sources, MEMBER)),
  )) {
    if (!key.startsWith("mcp_servers.")) continue;
    const server = value as {
      url: string;
      http_headers: Record<string, string>;
    };
    lines.push(
      `[mcp_servers.${JSON.stringify(key.slice("mcp_servers.".length))}]`,
    );
    lines.push(`url = ${JSON.stringify(server.url)}`);
    lines.push(
      `http_headers = { ${Object.entries(server.http_headers)
        .map(([h, v]) => `${JSON.stringify(h)} = ${JSON.stringify(v)}`)
        .join(", ")} }`,
    );
  }
  writeFileSync(join(home, "config.toml"), `${lines.join("\n")}\n`);
  return run(
    [
      process.execPath,
      resolveCodexLauncherPath(),
      "exec",
      "--skip-git-repo-check",
      "hello",
    ],
    {
      CODEX_HOME: home,
      OPENAI_API_KEY: FAKE_OPENAI,
      CODEX_API_KEY: FAKE_OPENAI,
    },
    45000,
  );
}

async function opencode(): Promise<string> {
  const config = join(mkdtempSync(join(root, "opencode-")), "opencode.json");
  writeFileSync(
    config,
    JSON.stringify(openCodeConfigFor(mcpServersForUserId(sources, MEMBER))),
  );
  return run(
    [
      resolveOpenCodeBinary(),
      "run",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "hello",
    ],
    {
      OPENCODE_CONFIG: config,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    45000,
  );
}

describe.skipIf(!LIVE)(
  "an OAuth MCP server reaches real engines with the access token (live; SKIPPED without ISOMUX_TEST_LIVE=1)",
  () => {
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "a2b-live-"));
      resetOAuthTokens();
      stub = await startHttpsStub([MCP_HOST]);
      // Model hosts are refused: no engine reaches a provider.
      deny = await startCompanyProxy({ [`${MCP_HOST}:443`]: stub.port });
      bundle = join(root, "bundle.pem");
      writeFileSync(bundle, stub.ca.certPem);
      mkdirSync(join(root, "state"));
      sources = createMcpServerSources(join(root, "state"));
      oauth = createMcpOAuth({
        servers: sources.servers,
        secrets: sources.secrets,
        fetch: rig.fetch,
        redirectUri: () => "https://office.example.test/api/mcp-oauth/callback",
        now: () => clock,
      });
      const scope = { kind: "user", userId: MEMBER } as const;
      const created = oauth.create(scope, {
        name: "mail",
        url: MCP_URL,
        secret: null,
        oauth: {},
      });
      if (!created.ok || !created.change.ok) throw new Error("create");
      // The sign-in, once: the stub plays the member's browser.
      const started = await oauth.startSignIn(scope, "mail", MEMBER);
      if (!started.ok) throw new Error(started.reason);
      const { code, state } = rig.authorize(started.authorizationUrl);
      const finished = await oauth.finishSignIn(
        MEMBER,
        new URLSearchParams({ code, state }),
        () => true,
      );
      if (!finished.ok) throw new Error(finished.reason);
    });

    afterAll(async () => {
      resetOAuthTokens();
      await stub?.close();
      await deny?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    test("Claude, Codex and OpenCode each send the access token", async () => {
      const token = `Bearer ${rig.access()}`;
      mcpAuthorizations();
      const outputs: string[] = [];
      outputs.push(await claude());
      expect(mcpAuthorizations()).toContain(token);
      outputs.push(await codex());
      expect(mcpAuthorizations()).toContain(token);
      outputs.push(await opencode());
      expect(mcpAuthorizations()).toContain(token);
      for (const out of outputs) expect(out).not.toContain(LEAK);
    }, 150000);
  },
);
