// OAuth MCP servers (server/mcp-oauth.ts, integrations A2b) against a stub
// authorization server and a stub MCP server, both behind the fetch seam: no
// real provider, no network.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { sdkMcpRegistration } from "./backends/claude.ts";
import { codexThreadConfig } from "./backends/codex/adapter.ts";
import { openCodeConfigFor } from "./backends/opencode/supervisor.ts";
import {
  createMcpServerSources,
  mcpServerRows,
  mcpServersForUserId,
} from "./mcp-servers.ts";
import { createMcpOAuth } from "./mcp-oauth.ts";
import { oauthSecretNames } from "../shared/mcp-servers.ts";
import { SECRET_MIN_VALUE_LENGTH } from "../shared/secret-hosts.ts";
import { resetOAuthTokens } from "./mcp-oauth-tokens.ts";
import { mcpServersHandlers } from "./routes/handlers/mcp-servers.ts";
import type { RouteHandlerContext } from "./routes/executor.ts";
import {
  ISSUER,
  LEAK,
  MCP_URL,
  stubRig,
  type StubOptions,
} from "./test-support/mcp-oauth-stub.ts";

const REDIRECT = "https://office.example.test/api/mcp-oauth/callback";
const member = { kind: "user", userId: "u1" } as const;
const office = { kind: "office" } as const;

let root: string;
let clock: number;
let logs: string[];
let spies: ReturnType<typeof spyOn>[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  // The token cache reads Date.now(), so the stub clock starts there.
  clock = Date.now();
  logs = [];
  resetOAuthTokens();
  spies = (["log", "warn", "error"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }),
  );
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function setup(options: StubOptions = {}) {
  const rig = stubRig(options);
  const sources = createMcpServerSources(root);
  const oauth = createMcpOAuth({
    servers: sources.servers,
    secrets: sources.secrets,
    fetch: rig.fetch,
    redirectUri: () => REDIRECT,
    now: () => clock,
  });
  return { rig, sources, oauth };
}

function register(
  oauth: ReturnType<typeof setup>["oauth"],
  body: Record<string, unknown> = {},
) {
  const result = oauth.create(member, {
    name: "mail",
    url: MCP_URL,
    secret: null,
    oauth: {},
    ...body,
  });
  expect(result.ok && result.change.ok).toBe(true);
}

async function signIn(context: ReturnType<typeof setup>) {
  const started = await context.oauth.startSignIn(member, "mail", "u1");
  if (!started.ok) throw new Error(`start: ${started.reason}`);
  const { code, state } = context.rig.authorize(started.authorizationUrl);
  const finished = await context.oauth.finishSignIn(
    "u1",
    new URLSearchParams({ code, state }),
    () => true,
  );
  if (!finished.ok) throw new Error(`finish: ${finished.reason}`);
  return started.authorizationUrl;
}

// What each engine receives for member u1.
function engineShapes(sources: ReturnType<typeof setup>["sources"]) {
  const servers = mcpServersForUserId(sources, "u1");
  return JSON.stringify({
    claude: sdkMcpRegistration("agent-1", servers) ?? null,
    codex: codexThreadConfig(servers),
    opencode: openCodeConfigFor(servers),
  });
}

describe("the sign-in", () => {
  it("discovers, registers a client, uses PKCE and state, and gives every engine the access token", async () => {
    const context = setup();
    register(context.oauth);
    const authorizationUrl = await signIn(context);
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("client_id")).toBe("client-dcr-1");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("resource")).toBe(MCP_URL);
    expect(url.searchParams.get("scope")).toBe("mail.read");
    expect(url.searchParams.get("state")!.length).toBeGreaterThanOrEqual(43);
    expect(context.rig.registeredRedirects).toEqual([REDIRECT]);
    // No token is on the URL that goes to the browser.
    expect(authorizationUrl).not.toContain(LEAK);

    const token = context.rig.access();
    const shapes = engineShapes(context.sources);
    // Claude, Codex and OpenCode each carry the header.
    expect(shapes.split(`Bearer ${token}`).length - 1).toBe(3);

    const names = oauthSecretNames("mail");
    expect(
      context.sources.secrets.readSecretValues(member, names.refreshToken),
    ).toMatchObject({
      value: context.rig.refreshValue(),
      hosts: ["mcp.example.test"],
    });
    const [server] = context.sources.servers.list(member);
    expect(server.oauth).toEqual({ clientId: "client-dcr-1", signedIn: true });
    const [row] = mcpServerRows(context.sources, "u1", false).filter(
      (r) => r.scope === "personal",
    );
    expect(row).toMatchObject({ oauth: true, problem: null });
    // Nothing a client or a log reads holds a token.
    expect(JSON.stringify(context.sources.servers.list(member))).not.toContain(
      LEAK,
    );
    expect(JSON.stringify(context.sources.secrets.list(member))).not.toContain(
      LEAK,
    );
    expect(
      JSON.stringify(mcpServerRows(context.sources, "u1", true)),
    ).not.toContain(LEAK);
    expect(logs.join("\n")).not.toContain(LEAK);
  });

  it("drops the old refresh token when a new sign-in gives none", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    context.rig.noRefreshToken = true;
    await signIn(context);
    const names = oauthSecretNames("mail");
    expect(
      context.sources.secrets.readSecretValues(member, names.refreshToken),
    ).toBeNull();
    expect(context.sources.servers.oauthOwnedSecrets(member)).toEqual([]);
    expect(context.sources.servers.list(member)[0].oauth?.signedIn).toBe(false);
    // The new access token still works until it expires.
    expect(engineShapes(context.sources)).toContain(
      `Bearer ${context.rig.access()}`,
    );
  });

  it("reuses a registered client while the redirect URI stays the same", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    await signIn(context);
    expect(context.rig.registeredRedirects).toEqual([REDIRECT]);
  });

  it("sends a pasted client's secret as Basic auth and never registers a client", async () => {
    const context = setup({ registration: false });
    register(context.oauth, {
      oauth: {
        clientId: "pasted-client",
        clientSecret: `${LEAK}client-secret`,
      },
    });
    await signIn(context);
    expect(context.rig.registeredRedirects).toEqual([]);
    const auth = context.rig.tokenAuth[0]!;
    expect(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString()).toBe(
      `pasted-client:${LEAK}client-secret`,
    );
    expect(context.rig.tokenBodies[0].get("client_secret")).toBeNull();
  });

  it("refuses a pasted client secret that the store would refuse, and saves nothing", () => {
    const context = setup({ registration: false });
    const result = context.oauth.create(member, {
      name: "mail",
      url: MCP_URL,
      secret: null,
      oauth: {
        clientId: "pasted-client",
        clientSecret: "f".repeat(SECRET_MIN_VALUE_LENGTH - 1),
      },
    });
    expect(result.ok).toBe(false);
    expect(context.sources.servers.list(member)).toEqual([]);
    expect(context.sources.secrets.list(member)).toEqual([]);
  });

  it("needs a pasted client when the server offers no registration", async () => {
    const context = setup({ registration: false });
    register(context.oauth);
    expect(await context.oauth.startSignIn(member, "mail", "u1")).toEqual({
      ok: false,
      reason: "client_needed",
    });
  });

  it("names a redirect the authorization server refuses", async () => {
    const context = setup({ dcrError: "invalid_redirect_uri" });
    register(context.oauth);
    expect(await context.oauth.startSignIn(member, "mail", "u1")).toEqual({
      ok: false,
      reason: "redirect_refused",
    });
  });

  it("refuses metadata whose resource is not the registered URL", async () => {
    const context = setup({ resource: "https://other.example.test/mcp" });
    register(context.oauth);
    expect(await context.oauth.startSignIn(member, "mail", "u1")).toEqual({
      ok: false,
      reason: "resource_mismatch",
    });
  });

  it("refuses authorization-server metadata for another issuer", async () => {
    const context = setup({ issuer: "https://evil.example.test" });
    register(context.oauth);
    expect(await context.oauth.startSignIn(member, "mail", "u1")).toEqual({
      ok: false,
      reason: "issuer_mismatch",
    });
  });

  it("refuses a plain-http endpoint from metadata", async () => {
    const context = setup({ tokenEndpoint: "http://auth.example.test/token" });
    register(context.oauth);
    expect(await context.oauth.startSignIn(member, "mail", "u1")).toEqual({
      ok: false,
      reason: "insecure_endpoint",
    });
  });

  it("refuses an unknown state, an expired one and another member's", async () => {
    const context = setup();
    register(context.oauth);
    const started = await context.oauth.startSignIn(member, "mail", "u1");
    if (!started.ok) throw new Error(started.reason);
    const { code, state } = context.rig.authorize(started.authorizationUrl);
    const query = (s: string) => new URLSearchParams({ code, state: s });
    expect(
      await context.oauth.finishSignIn("u1", query("nope"), () => true),
    ).toMatchObject({
      ok: false,
      reason: "state_unknown",
    });
    expect(
      await context.oauth.finishSignIn("u2", query(state), () => true),
    ).toMatchObject({
      ok: false,
      reason: "wrong_member",
    });
    clock += 11 * 60_000;
    expect(
      await context.oauth.finishSignIn("u1", query(state), () => true),
    ).toMatchObject({
      ok: false,
      reason: "state_expired",
    });
    expect(engineShapes(context.sources)).not.toContain("Bearer");
  });

  it("never writes a secret of the same name that the member made", async () => {
    const context = setup();
    const names = oauthSecretNames("mail");
    expect(
      context.sources.secrets.create(member, {
        name: names.refreshToken,
        value: "member-own-value",
        hosts: ["mcp.example.test"],
        form: { kind: "authorization" },
      }).ok,
    ).toBe(true);
    register(context.oauth);
    const started = await context.oauth.startSignIn(member, "mail", "u1");
    if (!started.ok) throw new Error(started.reason);
    const { code, state } = context.rig.authorize(started.authorizationUrl);
    expect(
      await context.oauth.finishSignIn(
        "u1",
        new URLSearchParams({ code, state }),
        () => true,
      ),
    ).toMatchObject({ ok: false, reason: "secret_exists" });
    expect(
      context.sources.secrets.readSecretValues(member, names.refreshToken)
        ?.value,
    ).toBe("member-own-value");
    expect(engineShapes(context.sources)).not.toContain("Bearer");
  });
});

describe("the refresh", () => {
  it("replaces the access token and the rotated refresh token without a new sign-in", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    const first = context.rig.access();
    await context.oauth.refreshDue();
    // Not due yet: the same token.
    expect(engineShapes(context.sources)).toContain(`Bearer ${first}`);
    clock += 3600_000 - 60_000;
    await context.oauth.refreshDue();
    const second = context.rig.access();
    expect(second).not.toBe(first);
    const shapes = engineShapes(context.sources);
    expect(shapes).toContain(`Bearer ${second}`);
    expect(shapes).not.toContain(first);
    expect(
      context.sources.secrets.readSecretValues(
        member,
        oauthSecretNames("mail").refreshToken,
      )?.value,
    ).toBe(context.rig.refreshValue());
    expect(context.rig.tokenBodies.at(-1)?.get("resource")).toBe(MCP_URL);
  });

  it("gets a token after a restart from the stored refresh token", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    resetOAuthTokens();
    expect(engineShapes(context.sources)).not.toContain("Bearer");
    await context.oauth.refreshDue();
    expect(engineShapes(context.sources)).toContain(
      `Bearer ${context.rig.access()}`,
    );
  });

  it("shows sign in again when the authorization server refuses the refresh", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    context.rig.refuseRefresh = true;
    clock += 3600_000;
    await context.oauth.refreshDue();
    expect(engineShapes(context.sources)).not.toContain("Bearer");
    const [row] = mcpServerRows(context.sources, "u1", false).filter(
      (r) => r.scope === "personal",
    );
    expect(row.problem).toBe("sign_in_again");
    expect(logs.join("\n")).not.toContain(LEAK);
  });
});

describe("a refresh with an unreadable file", () => {
  it("resolves, logs a fixed line and sends no token, then works once the file is back", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    resetOAuthTokens();
    const path = join(root, "secrets", "users", "u1.json");
    const saved = readFileSync(path, "utf8");
    writeFileSync(path, "{ not json");
    logs.length = 0;
    await context.oauth.refreshDue();
    expect(logs.some((line) => line.includes("could not be read"))).toBe(true);
    expect(logs.join("\n")).not.toContain(LEAK);
    expect(engineShapes(context.sources)).not.toContain("Bearer");
    writeFileSync(path, saved);
    await context.oauth.refreshDue();
    expect(engineShapes(context.sources)).toContain(
      `Bearer ${context.rig.access()}`,
    );
  });
});

describe("a change to the registration", () => {
  it("drops the token when the URL moves to another host", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    expect(engineShapes(context.sources)).toContain("Bearer");
    const result = context.oauth.update(member, "mail", {
      url: "https://elsewhere.example.test/mcp",
    });
    expect(result.ok && result.change.ok).toBe(true);
    const shapes = engineShapes(context.sources);
    expect(shapes).not.toContain("Bearer");
    expect(shapes).not.toContain(LEAK);
    expect(
      context.sources.secrets.readSecretValues(
        member,
        oauthSecretNames("mail").refreshToken,
      ),
    ).toBeNull();
    expect(context.sources.servers.list(member)[0].oauth).toEqual({
      clientId: null,
      signedIn: false,
    });
  });

  it("never sends a token issued for another URL, even when the URL changes outside the flow", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    // The store directly: the flow's own clean-up does not run.
    expect(
      context.sources.servers.update(member, "mail", {
        url: "https://elsewhere.example.test/mcp",
      }).ok,
    ).toBe(true);
    // Left out until a sign-in for the new URL.
    expect(mcpServersForUserId(context.sources, "u1")).toEqual([]);
    const shapes = engineShapes(context.sources);
    expect(shapes).not.toContain("Bearer");
    expect(shapes).not.toContain(LEAK);
  });

  it("deletes the secrets it owns on delete and on a switch away from OAuth", async () => {
    const context = setup();
    register(context.oauth, {
      oauth: {
        clientId: "pasted-client",
        clientSecret: `${LEAK}client-secret`,
      },
    });
    await signIn(context);
    const names = oauthSecretNames("mail");
    expect(
      context.sources.secrets
        .list(member)
        .map((s) => s.name)
        .sort(),
    ).toEqual([names.refreshToken, names.clientSecret].sort());
    const result = context.oauth.update(member, "mail", { oauth: null });
    expect(result.ok && result.change.ok).toBe(true);
    expect(context.sources.secrets.list(member)).toEqual([]);
    expect(engineShapes(context.sources)).not.toContain("Bearer");

    register(context.oauth, { name: "mail2" });
    const started = await context.oauth.startSignIn(member, "mail2", "u1");
    expect(started.ok).toBe(true);
    expect(context.oauth.remove(member, "mail2")).toBe(true);
    expect(context.sources.secrets.list(member)).toEqual([]);
  });
});

describe("a secret delete that fails", () => {
  it("leaves the registration listing its secrets, so they stay away from agents", async () => {
    const context = setup();
    register(context.oauth);
    await signIn(context);
    const owned = context.sources.servers.oauthOwnedSecrets(member);
    expect(owned).toEqual([oauthSecretNames("mail").refreshToken]);
    const failing = spyOn(context.sources.secrets, "remove").mockImplementation(
      () => {
        throw new Error("disk");
      },
    );
    try {
      expect(() => context.oauth.remove(member, "mail")).toThrow();
      expect(() =>
        context.oauth.update(member, "mail", { oauth: null }),
      ).toThrow();
      expect(() =>
        context.oauth.update(member, "mail", {
          url: "https://elsewhere.example.test/mcp",
        }),
      ).toThrow();
    } finally {
      failing.mockRestore();
    }
    expect(context.sources.servers.oauthOwnedSecrets(member)).toEqual(owned);
    expect(context.sources.servers.list(member)[0].url).toBe(MCP_URL);
  });
});

describe("the callback route", () => {
  function callbackCtx(userId: string, query: URLSearchParams) {
    return {
      identity: { scope: "user", userId },
      params: {},
      body: undefined,
      rawBody: "",
      query,
      req: new Request("https://office.example.test/api/mcp-oauth/callback"),
    } as unknown as RouteHandlerContext;
  }

  async function landing(
    context: ReturnType<typeof setup>,
    userId: string,
    query: URLSearchParams,
    audits: string[][],
    owners: string[] = [],
  ): Promise<string> {
    const handlers = mcpServersHandlers({
      store: context.sources.servers,
      oauth: context.oauth,
      auditSignIn: (_ctx, targets) => audits.push(targets),
      isOfficeOwnerUserId: (id) => owners.includes(id),
      userIdForUsername: () => null,
      usernameForUserId: (id) => ({ u1: "alice", u2: "morgan" })[id] ?? null,
    });
    const result = await handlers["mcpOAuth.callback"](
      callbackCtx(userId, query),
    );
    if (result.kind !== "bytes") throw new Error(result.kind);
    return new TextDecoder().decode(result.body);
  }

  it("sends the browser back with a fixed code, audits a finished sign-in only", async () => {
    const context = setup();
    register(context.oauth);
    const started = await context.oauth.startSignIn(member, "mail", "u1");
    if (!started.ok) throw new Error(started.reason);
    const { code, state } = context.rig.authorize(started.authorizationUrl);
    const audits: string[][] = [];
    expect(
      await landing(
        context,
        "u1",
        new URLSearchParams({ code, state: "x" }),
        audits,
      ),
    ).toContain("/integrations?mcpSignIn=state_unknown");
    expect(
      await landing(
        context,
        "u2",
        new URLSearchParams({ code, state }),
        audits,
      ),
    ).toContain("/integrations?mcpSignIn=wrong_member");
    expect(audits).toEqual([]);
    const page = await landing(
      context,
      "u1",
      new URLSearchParams({ code, state }),
      audits,
    );
    expect(page).toContain("/integrations?mcpSignIn=ok");
    expect(page).not.toContain(LEAK);
    // The row names the member's scope by username.
    expect(audits).toEqual([["mail", "alice"]]);
  });

  // Lead ruling, 2026-10-13: an owner starts the sign-in for a member's
  // server and finishes it; the tokens land in the member's scope and the row
  // names the member.
  it("lets an owner sign in to a member's server, and refuses once demoted", async () => {
    const context = setup();
    register(context.oauth);
    const first = await context.oauth.startSignIn(member, "mail", "u2");
    if (!first.ok) throw new Error(first.reason);
    const one = context.rig.authorize(first.authorizationUrl);
    const audits: string[][] = [];
    expect(
      await landing(
        context,
        "u1",
        new URLSearchParams({ code: one.code, state: one.state }),
        audits,
        ["u2"],
      ),
    ).toContain("/integrations?mcpSignIn=wrong_member");
    expect(
      await landing(
        context,
        "u2",
        new URLSearchParams({ code: one.code, state: one.state }),
        audits,
        ["u2"],
      ),
    ).toContain("/integrations?mcpSignIn=ok");
    expect(audits).toEqual([["mail", "alice"]]);
    expect(
      context.sources.secrets.readSecretValues(
        member,
        oauthSecretNames("mail").refreshToken,
      ),
    ).not.toBeNull();

    const second = await context.oauth.startSignIn(member, "mail", "u2");
    if (!second.ok) throw new Error(second.reason);
    const two = context.rig.authorize(second.authorizationUrl);
    const bodies = context.rig.tokenBodies.length;
    expect(
      await landing(
        context,
        "u2",
        new URLSearchParams({ code: two.code, state: two.state }),
        audits,
      ),
    ).toContain("/integrations?mcpSignIn=wrong_member");
    expect(context.rig.tokenBodies.length).toBe(bodies);
    expect(audits).toHaveLength(1);
  });

  it("refuses an office flow once the member is no longer an owner", async () => {
    const context = setup();
    expect(
      context.oauth.create(office, {
        name: "mail",
        url: MCP_URL,
        secret: null,
        oauth: {},
      }).ok,
    ).toBe(true);
    const started = await context.oauth.startSignIn(office, "mail", "u1");
    if (!started.ok) throw new Error(started.reason);
    const { code, state } = context.rig.authorize(started.authorizationUrl);
    expect(
      await landing(context, "u1", new URLSearchParams({ code, state }), []),
    ).toContain("/integrations?mcpSignIn=wrong_member");
    expect(context.rig.tokenBodies).toEqual([]);
  });
});
