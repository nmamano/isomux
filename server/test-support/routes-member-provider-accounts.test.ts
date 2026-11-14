// An office owner signs a member in to or out of their own Claude or Codex
// account, through /api/users/:username/provider-accounts (task f183fac3).
//
// Pins: only the owner's browser session reaches these routes (a member, any
// API token and any agent get 403, and a refused call starts nothing and
// signs nobody out); an unknown member is 404; the sign-in runs in the
// MEMBER's personal provider home, never the owner's and never the office
// sign-in (an office scope is refused); the member's own page sees the
// sign-in the owner started, and the owner can cancel one the member started;
// an owner's sign-out shows in the member's "changed for you" list, a start
// does not; the audit row of a start names the member.
//
// Seam: startTestServer() with fake Claude and Codex account clients. A fake
// Claude sign-in finishes when it gets its code: it writes .credentials.json
// in its own directory, and every fake read reports a directory signed in
// exactly when that file is there. Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintApiToken } from "../api-tokens.ts";
import { officeAuditStore } from "../audit-store.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import {
  activatePersonalProvider,
  personalProviderHome,
} from "../provider-homes.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import type { ProviderAccountWire } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

type Auth = { session?: string; bearer?: string };
interface Res {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
}

async function call(
  srv: TestServer,
  method: "GET" | "POST",
  path: string,
  init: Auth & { body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await srv.http(path, {
    method,
    headers,
    rawSessionId: init.session,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // An empty answer.
  }
  return { status: response.status, body, text };
}

const MEMBER_CLAUDE = "member-claude@example.com";
const OWNER_CLAUDE = "owner-claude@example.com";
const OFFICE_CLAUDE = "office-claude@example.com";
const CODE = "member-code-f183";

const credentials = (dir: string) => join(dir, ".credentials.json");
const signIn = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentials(dir), "{}");
};

// What each fake client was made for and asked to do.
interface Log {
  claudeLogins: string[]; // CLAUDE_CONFIG_DIR of each Claude login
  codexLogins: { dir: string; method: string }[]; // CODEX_HOME, method
  codes: { dir: string; code: string }[];
}

// Owner Morgan and member Mia, each with an active personal Claude and Codex
// home. `memberSignedIn` says whether Mia's Claude starts signed in. The
// owner's own Claude is signed in, and so is the office's.
async function office(memberSignedIn: boolean) {
  const log: Log = { claudeLogins: [], codexLogins: [], codes: [] };
  const ids = { owner: "", member: "" };
  const labelOf = (dir: string) =>
    dir === personalProviderHome(ids.member, "claude")
      ? MEMBER_CLAUDE
      : dir === personalProviderHome(ids.owner, "claude")
        ? OWNER_CLAUDE
        : OFFICE_CLAUDE;
  const srv = await startTestServer({
    startServer: {
      createClaudeAccountClient: (env) => {
        const dir = env?.CLAUDE_CONFIG_DIR ?? "";
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          start: async () => {},
          login: async () => {
            log.claudeLogins.push(dir);
            return { authUrl: `https://claude.test/oauth?dir=${dir.length}` };
          },
          submitCode: async (code: string) => {
            log.codes.push({ dir, code });
            signIn(dir);
            finish();
          },
          waitForCompletion: () => done,
          read: async () =>
            dir && existsSync(credentials(dir))
              ? { connected: true, label: labelOf(dir) }
              : { connected: false },
          close: async () => {},
        } as never;
      },
      createCodexAccountClient: (env) => {
        const dir = env?.CODEX_HOME ?? "";
        return {
          start: async () => {},
          login: async (method: string) => {
            log.codexLogins.push({ dir, method });
            return {
              loginId: "login-f183",
              authUrl: "https://auth.openai.test/",
              userCode: method === "device" ? "ABCD-1234" : undefined,
            };
          },
          waitForCompletion: () => new Promise(() => {}),
          cancel: async () => {},
          logout: async () => {},
          read: async () => ({ connected: false }),
          close: async () => {},
        } as never;
      },
    },
  });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Mia");
  ids.owner = getUserByName(owner.username)!.id;
  ids.member = getUserByName(member.username)!.id;
  for (const id of [ids.owner, ids.member])
    for (const provider of ["claude", "codex"] as const)
      activatePersonalProvider(id, provider);
  const memberHome = personalProviderHome(ids.member, "claude");
  const ownerHome = personalProviderHome(ids.owner, "claude");
  signIn(ownerHome);
  if (memberSignedIn) signIn(memberHome);
  const api = async (userId: string) =>
    (await mintApiToken({ userId, name: "API", expiresInDays: null })).token;
  return {
    srv,
    owner,
    member,
    ids,
    log,
    memberHome,
    ownerHome,
    ownerApi: await api(ids.owner),
    memberApi: await api(ids.member),
    base: `/api/users/${encodeURIComponent(member.username)}/provider-accounts`,
  };
}

const personalClaude = (res: Res): ProviderAccountWire | undefined =>
  (res.body?.accounts as ProviderAccountWire[] | undefined)?.find(
    (a) => a.provider === "claude" && a.scope === "personal",
  );

async function until(what: string, check: () => Promise<boolean>) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("an owner's sign-ins for a member", () => {
  it("admits only the owner's browser session, answers 404 for an unknown member, and a refused call changes nothing", async () => {
    const o = await office(true);
    const routes: { method: "GET" | "POST"; rest: string; body?: unknown }[] = [
      { method: "GET", rest: "" },
      { method: "POST", rest: "/refresh" },
      { method: "POST", rest: "/claude/login", body: {} },
      { method: "POST", rest: "/claude/callback", body: { code: CODE } },
      { method: "POST", rest: "/claude/cancel", body: {} },
      { method: "POST", rest: "/claude/disconnect", body: {} },
    ];
    const callers: Record<string, { auth: Auth; on: string }> = {
      memberSessionOnSelf: {
        auth: { session: o.member.rawSessionId },
        on: o.member.username,
      },
      memberSessionOnOwner: {
        auth: { session: o.member.rawSessionId },
        on: o.owner.username,
      },
      ownerApi: { auth: { bearer: o.ownerApi }, on: o.member.username },
      memberApi: { auth: { bearer: o.memberApi }, on: o.member.username },
      ownerPlainAgent: {
        auth: { bearer: mintAgentToken("f183-o-plain", o.ids.owner, false) },
        on: o.member.username,
      },
      ownerPrivilegedAgent: {
        auth: { bearer: mintAgentToken("f183-o-priv", o.ids.owner, true) },
        on: o.member.username,
      },
      memberPrivilegedAgent: {
        auth: { bearer: mintAgentToken("f183-m-priv", o.ids.member, true) },
        on: o.member.username,
      },
    };
    const statuses: Record<string, number> = {};
    for (const route of routes) {
      for (const [name, caller] of Object.entries(callers)) {
        const res = await call(
          o.srv,
          route.method,
          `/api/users/${encodeURIComponent(caller.on)}/provider-accounts${route.rest}`,
          { ...caller.auth, body: route.body },
        );
        statuses[`${route.method} ${route.rest} ${name}`] = res.status;
        // No account of anyone's on a refusal.
        for (const account of [MEMBER_CLAUDE, OWNER_CLAUDE])
          expect(res.text).not.toContain(account);
      }
      statuses[`${route.method} ${route.rest} unknownMember`] = (
        await call(
          o.srv,
          route.method,
          `/api/users/nobody/provider-accounts${route.rest}`,
          { session: o.owner.rawSessionId, body: route.body },
        )
      ).status;
    }
    const expected: Record<string, number> = {};
    for (const route of routes) {
      for (const name of Object.keys(callers))
        expected[`${route.method} ${route.rest} ${name}`] = 403;
      expected[`${route.method} ${route.rest} unknownMember`] = 404;
    }
    expect(statuses).toEqual(expected);
    // Nothing started and nobody was signed out.
    expect(o.log.claudeLogins).toEqual([]);
    expect(o.log.codes).toEqual([]);
    expect(existsSync(credentials(o.memberHome))).toBe(true);
    expect(existsSync(credentials(o.ownerHome))).toBe(true);

    // The owner's session is admitted on the same paths, so each refusal
    // above is about the caller, not a missing route.
    const read = await call(o.srv, "GET", o.base, {
      session: o.owner.rawSessionId,
    });
    expect(read.status).toBe(200);
    expect(personalClaude(read)?.accountLabel).toBe(MEMBER_CLAUDE);
    expect(read.text).not.toContain(OWNER_CLAUDE);
  });

  it("signs the member in: the sign-in runs in the member's home, the member's page sees it, and the code finishes it there", async () => {
    const o = await office(false);
    const owner = { session: o.owner.rawSessionId };
    const started = await call(o.srv, "POST", `${o.base}/claude/login`, {
      ...owner,
      body: {},
    });
    expect(started.status).toBe(200);
    expect(o.log.claudeLogins).toEqual([o.memberHome]);

    // The member's own page shows the running sign-in with its link; the
    // owner's own page has none.
    const memberOwn = await call(o.srv, "GET", "/api/me/provider-accounts", {
      session: o.member.rawSessionId,
    });
    expect(personalClaude(memberOwn)?.login?.phase).toBe("waiting");
    const ownerOwn = await call(o.srv, "GET", "/api/me/provider-accounts", {
      ...owner,
    });
    expect(personalClaude(ownerOwn)?.login).toBeUndefined();
    expect(personalClaude(ownerOwn)?.accountLabel).toBe(OWNER_CLAUDE);
    // The owner's view of the member shows it too.
    const memberView = await call(o.srv, "GET", o.base, { ...owner });
    expect(personalClaude(memberView)?.login?.phase).toBe("waiting");

    const submitted = await call(o.srv, "POST", `${o.base}/claude/callback`, {
      ...owner,
      body: { code: CODE },
    });
    expect(submitted.status).toBe(200);
    expect(o.log.codes).toEqual([{ dir: o.memberHome, code: CODE }]);
    await until("the member's sign-in to finish", async () => {
      const mine = await call(o.srv, "GET", "/api/me/provider-accounts", {
        session: o.member.rawSessionId,
      });
      return personalClaude(mine)?.accountLabel === MEMBER_CLAUDE;
    });
    // The owner's own sign-in is untouched.
    const after = await call(o.srv, "GET", "/api/me/provider-accounts", {
      ...owner,
    });
    expect(personalClaude(after)?.accountLabel).toBe(OWNER_CLAUDE);
  });

  it("starts a Codex sign-in in the member's Codex home with the method asked, and refuses an unknown method", async () => {
    const o = await office(false);
    const owner = { session: o.owner.rawSessionId };
    const bad = await call(o.srv, "POST", `${o.base}/codex/login`, {
      ...owner,
      body: { method: "carrier-pigeon" },
    });
    expect(bad.status).toBe(422);
    expect(o.log.codexLogins).toEqual([]);
    const started = await call(o.srv, "POST", `${o.base}/codex/login`, {
      ...owner,
      body: { method: "device" },
    });
    expect(started.status).toBe(200);
    expect(o.log.codexLogins).toEqual([
      { dir: personalProviderHome(o.ids.member, "codex"), method: "device" },
    ]);
  });

  it("never reaches the office sign-in: an office scope is refused on every write", async () => {
    const o = await office(true);
    const owner = { session: o.owner.rawSessionId };
    const statuses: Record<string, number> = {};
    for (const [rest, body] of [
      ["/claude/login", { scope: "office" }],
      ["/claude/callback", { scope: "office", code: CODE }],
      ["/claude/cancel", { scope: "office" }],
      ["/claude/disconnect", { scope: "office" }],
    ] as const)
      statuses[rest] = (
        await call(o.srv, "POST", `${o.base}${rest}`, { ...owner, body })
      ).status;
    expect(statuses).toEqual({
      "/claude/login": 422,
      "/claude/callback": 422,
      "/claude/cancel": 422,
      "/claude/disconnect": 422,
    });
    expect(o.log.claudeLogins).toEqual([]);
    expect(existsSync(credentials(o.memberHome))).toBe(true);
    // "personal" is the one scope the body may name.
    const personal = await call(o.srv, "POST", `${o.base}/claude/login`, {
      ...owner,
      body: { scope: "personal" },
    });
    expect(personal.status).toBe(200);
    expect(o.log.claudeLogins).toEqual([o.memberHome]);
  });

  it("cancels a sign-in the member started on their own page", async () => {
    const o = await office(false);
    const own = await call(
      o.srv,
      "POST",
      "/api/me/provider-accounts/claude/login",
      { session: o.member.rawSessionId, body: { scope: "personal" } },
    );
    expect(own.status).toBe(200);
    const canceled = await call(o.srv, "POST", `${o.base}/claude/cancel`, {
      session: o.owner.rawSessionId,
      body: {},
    });
    expect(canceled.status).toBe(200);
    const mine = await call(o.srv, "GET", "/api/me/provider-accounts", {
      session: o.member.rawSessionId,
    });
    expect(personalClaude(mine)?.login).toBeUndefined();
  });

  it("signs the member out of their own account only, and the member's changed-for-you list says who did it; a start does not show there", async () => {
    const o = await office(true);
    const owner = { session: o.owner.rawSessionId };
    const feed = async () =>
      (
        (
          await call(o.srv, "GET", "/api/me/integration-changes", {
            session: o.member.rawSessionId,
          })
        ).body as { items: Record<string, unknown>[] }
      ).items;

    // A start, its cancel and a refresh change nothing for the member.
    expect(
      (
        await call(o.srv, "POST", `${o.base}/codex/login`, {
          ...owner,
          body: {},
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(o.srv, "POST", `${o.base}/codex/cancel`, {
          ...owner,
          body: {},
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(o.srv, "POST", `${o.base}/refresh`, { ...owner })).status,
    ).toBe(200);
    expect(await feed()).toEqual([]);

    // The start's audit row names the member, so the log says whose
    // sign-in the owner started.
    const starts = officeAuditStore().list({
      operation: "memberProviderAccounts.start",
    }).items;
    expect(starts.length).toBe(1);
    expect(starts[0].targets).toContain(o.ids.member);

    const out = await call(o.srv, "POST", `${o.base}/claude/disconnect`, {
      ...owner,
      body: {},
    });
    expect(out.status).toBe(200);
    expect(existsSync(credentials(o.memberHome))).toBe(false);
    expect(existsSync(credentials(o.ownerHome))).toBe(true);
    const items = await feed();
    expect(
      items.map(({ by, kind, action, name }) => ({ by, kind, action, name })),
    ).toEqual([
      { by: "Morgan", kind: "provider", action: "removed", name: "claude" },
    ]);
  });
});
