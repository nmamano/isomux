// Step asks end to end (task c71cb60f), through the real server: the agent
// asks its manager to do an Integrations step, the ask carries the step's
// tab, and when the member does the step on its own route the ask closes
// itself, with a system line in the agent's chat. One case per kind, each
// done through the route a member uses (the GitHub link PUT, the provider
// refresh, the MCP OAuth callback, the extension pairing), and one step done
// while the server was down, closed at the next boot.
//
// Seams: fake provider account clients, a fake GitHub, the MCP OAuth stub
// behind connectionTestFetch. No LLM, no network.

import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  extensionSocket,
  memberRequest,
  ownedAgent,
} from "./browser-extension-route-fixture.ts";
import { FakeGithub } from "./fake-github.ts";
import { MCP_URL, stubRig } from "./mcp-oauth-stub.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { createSecretStore } from "../secret-store.ts";
import { createGithubLinkStore } from "../github-sync.ts";
import { officeAuditStore } from "../audit-store.ts";
import { resetOAuthTokens } from "../mcp-oauth-tokens.ts";
import { DEFAULT_GITHUB_SYNC_SECRET } from "../../shared/github-sync.ts";
import type { AskEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  resetOAuthTokens();
});

// What the fake provider CLIs answer to an account read.
const provider = { claude: false, codex: false };
const accountClient = (name: keyof typeof provider) => () =>
  ({
    start: async () => {},
    read: async () => ({ connected: provider[name] }),
    close: async () => {},
  }) as never;

async function boot() {
  provider.claude = false;
  provider.codex = false;
  const gh = new FakeGithub(["acme/widgets"]);
  const rig = stubRig();
  const srv = await startTestServer({
    startServer: {
      githubSyncFetch: (url, init) => gh.fetch(url, init),
      connectionTestFetch: rig.fetch,
      createClaudeAccountClient: accountClient("claude"),
      createCodexAccountClient: accountClient("codex"),
    },
  });
  server = srv;
  // The agent's manager is an office owner, so every kind is theirs to do.
  const owner = await srv.seedOwner("Morgan");
  const agent = await ownedAgent(srv, owner, "Stepper");
  const token = getAgentTokenRaw(agent.id)!;
  return { srv, rig, gh, owner, agent, token };
}

type World = Awaited<ReturnType<typeof boot>>;

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// The agent's POST /asks with a step.
async function ask(w: World, srv: TestServer, step: unknown) {
  const response = await srv.http(`/api/agents/${w.agent.id}/asks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${w.token}`,
    },
    body: JSON.stringify({ text: "Please do this step.", step }),
  });
  return { status: response.status, body: (await json(response)) as AskEntry };
}

// "open", the closed ask's outcome, or the status of a refused read. The
// agent's token is read on each call: a restart issues a new one.
async function askStatus(w: World, srv: TestServer, askId: string) {
  const response = await srv.http(`/api/agents/${w.agent.id}/asks/${askId}`, {
    headers: { Authorization: `Bearer ${getAgentTokenRaw(w.agent.id)}` },
  });
  const body = (await json(response)) as { closed?: { outcome: string } };
  if (response.status !== 200) return String(response.status);
  return body.closed?.outcome ?? "open";
}

async function waitUntil(pred: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(10);
  }
}

// The keys of the step lines in the agent's chat.
const stepLines = (srv: TestServer, agentId: string) =>
  srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => JSON.stringify(e).match(/systemEntries\.stepAsk\.\w+/)?.[0])
    .filter((key): key is string => key !== undefined);

// Opens the step ask, does the step through `doIt`, and waits for the ask
// to close itself.
async function closesItself(
  w: World,
  step: Record<string, unknown>,
  expected: { link: string; step: Record<string, unknown> },
  doIt: () => Promise<void>,
): Promise<string> {
  const opened = await ask(w, w.srv, step);
  expect([
    opened.status,
    opened.body.link,
    opened.body.step as unknown,
  ]).toEqual([201, expected.link, expected.step]);
  expect(await askStatus(w, w.srv, opened.body.id)).toBe("open");
  await doIt();
  await waitUntil(
    async () => (await askStatus(w, w.srv, opened.body.id)) === "done",
    `the ${String(step.kind)} ask closes`,
  );
  // Done now: a second ask for the same step is refused.
  expect((await ask(w, w.srv, step)).status).toBe(409);
  return opened.body.id;
}

describe("a step ask closes itself when the member does the step", () => {
  it("a room's GitHub link, saved on the link route", async () => {
    const w = await boot();
    createSecretStore().create(
      { kind: "office" },
      {
        name: DEFAULT_GITHUB_SYNC_SECRET,
        value: w.gh.token,
        hosts: ["api.github.com"],
        form: { kind: "authorization" },
      },
    );
    await closesItself(
      w,
      { kind: "github-link" },
      {
        link: "/integrations/github",
        step: { kind: "github-link", roomId: w.agent.roomId },
      },
      async () => {
        const saved = await memberRequest(
          w.srv,
          w.owner,
          "PUT",
          `/api/rooms/${w.agent.roomId}/github-link`,
          { repo: "acme/widgets", labels: ["isomux"] },
        );
        expect(saved.status).toBe(200);
      },
    );
    expect(stepLines(w.srv, w.agent.id)).toEqual([
      "systemEntries.stepAsk.githubLinked",
    ]);
  });

  it("the office Claude account, seen at the providers refresh", async () => {
    const w = await boot();
    await closesItself(
      w,
      { kind: "provider-sign-in", provider: "claude", scope: "office" },
      {
        link: "/integrations/providers",
        step: { kind: "provider-sign-in", provider: "claude", scope: "office" },
      },
      async () => {
        provider.claude = true;
        const refreshed = await memberRequest(
          w.srv,
          w.owner,
          "POST",
          "/api/me/provider-accounts/refresh",
          {},
        );
        expect(refreshed.status).toBe(200);
      },
    );
    expect(stepLines(w.srv, w.agent.id)).toEqual([
      "systemEntries.stepAsk.providerSignedInOffice",
    ]);
  });

  it("an MCP server's OAuth sign-in, at the callback", async () => {
    const w = await boot();
    const base = `/api/users/${w.owner.username}/mcp-servers`;
    const made = await memberRequest(w.srv, w.owner, "POST", base, {
      name: "mail",
      url: MCP_URL,
      secret: null,
      oauth: {},
    });
    expect(made.status).toBe(201);
    await closesItself(
      w,
      { kind: "mcp-sign-in", name: "mail" },
      {
        link: "/integrations/mcp",
        step: {
          kind: "mcp-sign-in",
          name: "mail",
          scope: "personal",
          ownerUserId: getUserByName(w.owner.username)!.id,
        },
      },
      async () => {
        const started = (await json(
          await memberRequest(w.srv, w.owner, "POST", `${base}/mail/sign-in`),
        )) as { authorizationUrl: string };
        const { code, state } = w.rig.authorize(started.authorizationUrl);
        const back = await w.srv.http(
          `/api/mcp-oauth/callback?code=${code}&state=${state}`,
          { rawSessionId: w.owner.rawSessionId },
        );
        expect(await back.text()).toContain("mcpSignIn=ok");
      },
    );
    expect(stepLines(w.srv, w.agent.id)).toEqual([
      "systemEntries.stepAsk.mcpSignedIn",
    ]);
  });

  it("the manager's Chrome, at the extension pairing", async () => {
    const w = await boot();
    let socket: Awaited<ReturnType<typeof extensionSocket>> | null = null;
    try {
      await closesItself(
        w,
        { kind: "browser-pairing" },
        { link: "/integrations/browser", step: { kind: "browser-pairing" } },
        async () => {
          const { code } = (await json(
            await memberRequest(
              w.srv,
              w.owner,
              "POST",
              "/api/me/browser/pair",
              {},
            ),
          )) as { code: string };
          socket = await extensionSocket(w.srv, {
            kind: "hello",
            version: 4,
            code,
          });
          await socket.wait("paired");
        },
      );
    } finally {
      (
        socket as Awaited<ReturnType<typeof extensionSocket>> | null
      )?.ws.close();
    }
    expect(stepLines(w.srv, w.agent.id)).toEqual([
      "systemEntries.stepAsk.browserPaired",
    ]);
  });
});

describe("a step done while no hook saw it", () => {
  it("stays open until the next boot, which closes it", async () => {
    const w = await boot();
    createSecretStore().create(
      { kind: "office" },
      {
        name: DEFAULT_GITHUB_SYNC_SECRET,
        value: w.gh.token,
        hosts: ["api.github.com"],
        form: { kind: "authorization" },
      },
    );
    const opened = await ask(w, w.srv, { kind: "github-link" });
    expect(opened.status).toBe(201);
    // The link lands in the office database by another path: no route, so
    // no hook runs.
    const ownerId = getUserByName(w.owner.username)!.id;
    const direct = createGithubLinkStore(officeAuditStore().db).set(
      w.agent.roomId,
      { repo: "acme/widgets", labels: ["isomux"] },
      ownerId,
    );
    expect(direct.ok).toBe(true);
    await Bun.sleep(50);
    expect(await askStatus(w, w.srv, opened.body.id)).toBe("open");
    const next = await w.srv.restart();
    server = next;
    await waitUntil(
      async () => (await askStatus(w, next, opened.body.id)) === "done",
      "the boot closes the ask",
    );
    expect(stepLines(next, w.agent.id)).toEqual([
      "systemEntries.stepAsk.githubLinked",
    ]);
  });
});
