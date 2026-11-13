// GET /api/users/:username/connections: an office owner reads a member's
// connections list, sign-in accounts included, to help them (task b85f4051).
// Account emails are identity, so only an owner's browser session reads them:
// unlike env/names, an owner's API token and agents are refused too.

import { afterEach, describe, expect, it } from "bun:test";
import { mintApiToken } from "../api-tokens.ts";
import {
  recordClaudeConnectorsFromSession,
  resetClaudeConnectorsForTests,
} from "../claude-connectors.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import {
  activatePersonalProvider,
  personalProviderHome,
} from "../provider-homes.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import type { ConnectionsListRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  resetClaudeConnectorsForTests();
});

async function get(
  srv: TestServer,
  path: string,
  auth: { session?: string; bearer?: string },
) {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  const response = await srv.http(path, {
    method: "GET",
    headers,
    rawSessionId: auth.session,
  });
  return { status: response.status, text: await response.text() };
}

const MEMBER_CLAUDE = "member-claude@example.com";
const MEMBER_CODEX = "member-codex@example.com";
const OWNER_CLAUDE = "owner-claude@example.com";
const OWNER_CODEX = "owner-codex@example.com";
const OFFICE_ACCOUNT = "office-account@example.com";

// A two-member office where both have their own Claude and Codex sign-ins,
// each with a distinct account, and a claude.ai connector on each Claude one.
async function office() {
  const ids = { owner: "", member: "" };
  // The account each sign-in directory reports; the office one otherwise.
  const label = (dir: string | undefined, provider: "claude" | "codex") => {
    if (dir === personalProviderHome(ids.member, provider))
      return provider === "claude" ? MEMBER_CLAUDE : MEMBER_CODEX;
    if (dir === personalProviderHome(ids.owner, provider))
      return provider === "claude" ? OWNER_CLAUDE : OWNER_CODEX;
    return OFFICE_ACCOUNT;
  };
  const srv = await startTestServer({
    startServer: {
      createClaudeAccountClient: (env) =>
        ({
          start: async () => {},
          read: async () => ({
            connected: true,
            label: label(env?.CLAUDE_CONFIG_DIR, "claude"),
          }),
          close: async () => {},
        }) as never,
      createCodexAccountClient: (env) =>
        ({
          start: async () => {},
          read: async () => ({
            connected: true,
            label: label(env?.CODEX_HOME, "codex"),
          }),
          close: async () => {},
        }) as never,
    },
  });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Member");
  ids.owner = getUserByName(owner.username)!.id;
  ids.member = getUserByName(member.username)!.id;
  for (const id of [ids.owner, ids.member])
    for (const provider of ["claude", "codex"] as const)
      activatePersonalProvider(id, provider);
  const connector = (id: string, name: string) =>
    expect(
      recordClaudeConnectorsFromSession(
        {
          agentType: "claude",
          launchedClaudeConfigDir: personalProviderHome(id, "claude"),
        },
        {
          mcpServers: [
            {
              name: `claude.ai ${name}`,
              status: "connected",
              source: "claudeai",
            },
          ],
          apiKeySource: "none",
          from: "status",
        },
      ),
    ).toBe(true);
  connector(ids.member, "Member Drive");
  connector(ids.owner, "Owner Gmail");
  return { srv, owner, member, ids };
}

const path = (username: string) =>
  `/api/users/${encodeURIComponent(username)}/connections`;

describe("a member's connections, for an office owner", () => {
  it("gives the owner's session the member's personal sign-in accounts and connectors, and none of the owner's own", async () => {
    const { srv, owner, member } = await office();
    const read = await get(srv, path(member.username), {
      session: owner.rawSessionId,
    });
    expect(read.status).toBe(200);
    const list = JSON.parse(read.text) as ConnectionsListRes;
    const personal = (engine: "claude" | "codex") =>
      list.signIns.find((s) => s.scope === "personal" && s.engine === engine)
        ?.account;
    expect(personal("claude")).toBe(MEMBER_CLAUDE);
    expect(personal("codex")).toBe(MEMBER_CODEX);
    const connectors = list.claudeConnectors.find(
      (c) => c.scope === "personal",
    );
    expect(connectors?.names.join("|")).toContain("Member Drive");
    // The member's list, built for the member: nothing of the caller's own.
    for (const own of [OWNER_CLAUDE, OWNER_CODEX, "Owner Gmail"])
      expect(read.text).not.toContain(own);
    // The owner's own list still carries the owner's own accounts, so the
    // two lists are built per user and not from the caller.
    const mine = await get(srv, "/api/me/connections", {
      session: owner.rawSessionId,
    });
    expect(mine.text).toContain(OWNER_CLAUDE);
    expect(mine.text).not.toContain(MEMBER_CLAUDE);
  });

  it("refuses a member, every API token and every agent, and answers 404 for an unknown member", async () => {
    const { srv, owner, member, ids } = await office();
    const ownerApi = await mintApiToken({
      userId: ids.owner,
      name: "Owner API",
      expiresInDays: null,
    });
    const memberApi = await mintApiToken({
      userId: ids.member,
      name: "Member API",
      expiresInDays: null,
    });
    const callers: Record<string, { session?: string; bearer?: string }> = {
      memberSessionOnSelf: { session: member.rawSessionId },
      ownerApi: { bearer: ownerApi.token },
      memberApi: { bearer: memberApi.token },
      ownerPlainAgent: { bearer: mintAgentToken("o-plain", ids.owner, false) },
      // Has the owner's reach on env/names; not here.
      ownerPrivilegedAgent: {
        bearer: mintAgentToken("o-priv", ids.owner, true),
      },
      memberPlainAgent: {
        bearer: mintAgentToken("m-plain", ids.member, false),
      },
      memberPrivilegedAgent: {
        bearer: mintAgentToken("m-priv", ids.member, true),
      },
    };
    const statuses: Record<string, number> = {};
    const bodies: string[] = [];
    for (const [name, auth] of Object.entries(callers)) {
      const read = await get(srv, path(member.username), auth);
      statuses[name] = read.status;
      bodies.push(read.text);
    }
    // A member reading the owner's list, by session.
    const onOwner = await get(srv, path(owner.username), {
      session: member.rawSessionId,
    });
    statuses.memberSessionOnOwner = onOwner.status;
    bodies.push(onOwner.text);
    statuses.unknownMember = (
      await get(srv, path("nobody"), { session: owner.rawSessionId })
    ).status;
    // The owner's session is admitted in the same office, so a refusal
    // above is about the caller, not a missing route.
    statuses.ownerSession = (
      await get(srv, path(member.username), { session: owner.rawSessionId })
    ).status;

    expect(statuses).toEqual({
      memberSessionOnSelf: 403,
      ownerApi: 403,
      memberApi: 403,
      ownerPlainAgent: 403,
      ownerPrivilegedAgent: 403,
      memberPlainAgent: 403,
      memberPrivilegedAgent: 403,
      memberSessionOnOwner: 403,
      unknownMember: 404,
      ownerSession: 200,
    });
    for (const body of bodies)
      for (const account of [
        MEMBER_CLAUDE,
        MEMBER_CODEX,
        OWNER_CLAUDE,
        OWNER_CODEX,
      ])
        expect(body).not.toContain(account);
  });
});
