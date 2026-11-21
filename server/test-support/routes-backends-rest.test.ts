// backends.listModels on the unified REST surface.
// POST /api/backends/:agentType/models with JSON {cwd, includeHidden?}
// (agent:manage or agent:spawn + authenticated). An agent without
// agent:manage lists only in the folders it may spawn into (task e340753f).
// Listing models can start a backend and, for
// OpenCode, bootstrap a project for cwd (which loads that folder's project
// plugins), so it is a POST: the Origin check in authenticate() refuses a
// cross-site or app-hostname browser request, and an old cookie-bearing GET
// reaches no backend (task 77ec7e9d). Claude's listModels is a static, offline
// family list, so this is deterministic and zero-LLM; a spy on it counts the
// requests that reach a backend.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw, mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import type { AgentInfo } from "../../shared/types.ts";
import { buildPublicOrigin, sessionCookieName } from "../auth.ts";
import { claudeBackend } from "../backends/claude.ts";
import type { ListModelsOptions } from "../backends/types.ts";
import type { BackendModelWire } from "../../shared/types.ts";

let server: TestServer | null = null;
let restoreSpy: (() => void) | null = null;
afterEach(async () => {
  restoreSpy?.();
  restoreSpy = null;
  await server?.stop();
  server = null;
});

// Counts the listings that reach the Claude backend, and keeps their options.
function spyOnClaudeListModels(): ListModelsOptions[] {
  const calls: ListModelsOptions[] = [];
  const original = claudeBackend.listModels.bind(claudeBackend);
  const spy = spyOn(claudeBackend, "listModels").mockImplementation(
    async (opts: ListModelsOptions) => {
      calls.push(opts);
      return original(opts);
    },
  );
  restoreSpy = () => spy.mockRestore();
  return calls;
}

interface Res {
  status: number;
  body: unknown;
}
async function read(res: Response): Promise<Res> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// The model dialog's own request: the office Origin (the harness sets it) and
// the fetch metadata a same-origin fetch carries.
async function dialogPost(
  srv: TestServer,
  agentType: string,
  body: unknown,
  rawSessionId: string,
): Promise<Res> {
  return read(
    await srv.http(`/api/backends/${agentType}/models`, {
      method: "POST",
      rawSessionId,
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
      },
      body: JSON.stringify(body),
    }),
  );
}

// A browser request a page on another origin makes with the member's cookie.
// srv.http always sets the office Origin, so this goes to fetch directly.
async function foreignRequest(
  srv: TestServer,
  path: string,
  rawSessionId: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Res> {
  return read(
    await fetch(`${srv.baseUrl}${path}`, {
      method: init.method,
      headers: {
        ...init.headers,
        Cookie: `${sessionCookieName()}=${rawSessionId}`,
        Connection: "close",
      },
      body: init.body,
      redirect: "manual",
    }),
  );
}

describe("routes/backends.listModels REST", () => {
  // The capability pair (agent:manage or agent:spawn, never an app's) is
  // pinned in routes-table.test.ts.
  it("the dialog's own POST lists the models for the resolved cwd and passes includeHidden", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const calls = spyOnClaudeListModels();

    const r = await dialogPost(
      srv,
      "claude",
      { cwd: srv.workDir, includeHidden: true },
      owner.rawSessionId,
    );
    expect(r.status).toBe(200);
    const models = (r.body as { models: BackendModelWire[] }).models;
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.isDefault)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(srv.workDir);
    expect(calls[0].includeHidden).toBe(true);

    // includeHidden is optional and defaults to false.
    const plain = await dialogPost(
      srv,
      "claude",
      { cwd: srv.workDir },
      owner.rawSessionId,
    );
    expect(plain.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].includeHidden).toBe(false);
  });

  it("a request from another site never reaches a backend, while the same cookie works for the dialog", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const calls = spyOnClaudeListModels();
    const office = new URL(buildPublicOrigin().origin);
    const appHostOrigin = `${office.protocol}//someapp.${office.host}`;
    const body = JSON.stringify({ cwd: srv.workDir });

    // The finding's request: a top-level navigation to the old GET, with the
    // cookie, cross-site fetch metadata, an off-site Referer and no Origin.
    const navigation = await foreignRequest(
      srv,
      `/api/backends/claude/models?cwd=${encodeURIComponent(srv.stateRoot)}`,
      owner.rawSessionId,
      {
        method: "GET",
        headers: {
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          Referer: "https://attacker.example/page",
        },
      },
    );
    expect([404, 405]).toContain(navigation.status);
    expect(calls).toHaveLength(0);

    // A cross-site POST, and a same-site POST from an app hostname. Both carry
    // an Origin that is not the office's.
    for (const origin of ["https://attacker.example", appHostOrigin]) {
      const r = await foreignRequest(
        srv,
        "/api/backends/claude/models",
        owner.rawSessionId,
        {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "Sec-Fetch-Site":
              origin === appHostOrigin ? "same-site" : "cross-site",
            "Sec-Fetch-Mode": "cors",
          },
          body,
        },
      );
      expect({
        origin,
        status: r.status,
        code: (r.body as { error?: { code?: string } }).error?.code,
      }).toEqual({ origin, status: 403, code: "bad_origin" });
    }
    expect(calls).toHaveLength(0);

    // The same session cookie is valid: the dialog's request reaches the
    // backend.
    const own = await dialogPost(
      srv,
      "claude",
      { cwd: srv.workDir },
      owner.rawSessionId,
    );
    expect(own.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("a cwd that is not an existing directory is a domain error and starts no backend", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const calls = spyOnClaudeListModels();
    const file = join(srv.stateRoot, "not-a-directory.txt");
    writeFileSync(file, "x");

    for (const cwd of [join(srv.stateRoot, "no-such-folder"), file]) {
      const r = await dialogPost(srv, "claude", { cwd }, owner.rawSessionId);
      expect(r.status).toBe(200);
      const b = r.body as {
        models: BackendModelWire[];
        authError?: boolean;
        error?: string;
      };
      expect(b.models).toEqual([]);
      expect(b.authError).toBe(false);
      expect(typeof b.error).toBe("string");
      expect(b.error!.length).toBeGreaterThan(0);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a body without a usable cwd or with a non-boolean includeHidden", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const calls = spyOnClaudeListModels();

    // An absent or empty cwd would otherwise resolve to the server process's
    // own working directory, a folder the caller never named.
    const bodies: unknown[] = [
      {},
      { cwd: "" },
      { cwd: 42 },
      { cwd: srv.workDir, includeHidden: "true" },
    ];
    for (const body of bodies) {
      const r = await dialogPost(srv, "claude", body, owner.rawSessionId);
      expect({ body, status: r.status }).toEqual({ body, status: 422 });
      expect((r.body as { error?: { code?: string } }).error?.code).toBe(
        "invalid_request",
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("unknown agentType -> 200 with empty models + authError:false (graceful, via the core catch)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r = await dialogPost(
      srv,
      "bogus",
      { cwd: srv.workDir },
      owner.rawSessionId,
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      models: BackendModelWire[];
      authError?: boolean;
      error?: string;
    };
    expect(body.models).toEqual([]);
    expect(body.authError).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});

// An agent's own request: its bearer token, no cookie.
async function agentPost(
  srv: TestServer,
  agentType: string,
  body: unknown,
  bearer: string,
): Promise<Res> {
  return read(
    await srv.http(`/api/backends/${agentType}/models`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

const errCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } }).error?.code;

// Task e340753f: an agent picks a model for the agents it spawns, so it
// lists models where it may spawn. The listing starts the backend in cwd (and,
// for OpenCode, loads cwd's project config), so an agent below full reach
// lists only in its own folder or a folder inside it, like the spawn limit.
describe("routes/backends.listModels for an agent token", () => {
  type Engine = AgentInfo["agentType"];
  type Mode = AgentInfo["permissionMode"];
  type Sandbox = AgentInfo["codexSandbox"];

  async function setup() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const ownerRecord = getUserByName(owner.username);
    if (!ownerRecord) throw new Error("seeded owner record missing");
    const roomId = srv.agentManager.getRooms()[0].id;
    const work = join(srv.workDir, "work");
    const elsewhere = join(srv.workDir, "elsewhere");
    mkdirSync(join(work, "sub"), { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    // A sibling whose path starts with the agent's folder, and a link in the
    // agent's folder that points out of it.
    const sibling = `${work}-other`;
    mkdirSync(sibling, { recursive: true });
    symlinkSync(elsewhere, join(work, "out"));
    let n = 0;
    // An ordinary agent of the owner in `work`, and its token.
    const agentIn = async (
      engine: Engine,
      mode: Mode,
      sandbox?: Sandbox,
    ): Promise<string> => {
      const agent = await srv.agentManager.spawn(
        `Agent${++n}`,
        work,
        mode,
        null,
        undefined,
        roomId,
        undefined,
        engine === "codex" ? "gpt-5.5" : "sonnet",
        undefined,
        owner.username,
        engine,
        sandbox,
        ownerRecord.id,
      );
      if (!agent) throw new Error("agent spawn failed");
      // The enabling condition: an ordinary agent in the stated mode.
      expect(agent.privileged ?? false).toBe(false);
      expect([agent.agentType, agent.permissionMode, agent.cwd]).toEqual([
        engine,
        mode,
        work,
      ]);
      if (sandbox) expect(agent.codexSandbox).toBe(sandbox);
      const bearer = getAgentTokenRaw(agent.id);
      if (!bearer) throw new Error("agent token missing");
      return bearer;
    };
    return { srv, ownerRecord, work, elsewhere, sibling, agentIn };
  }

  it("an agent below full reach lists in its own folder or one inside it, and outside it is refused before any backend starts", async () => {
    const { srv, work, elsewhere, sibling, agentIn } = await setup();
    const bearer = await agentIn("claude", "default");
    const calls = spyOnClaudeListModels();

    for (const cwd of [work, join(work, "sub")]) {
      const r = await agentPost(srv, "claude", { cwd }, bearer);
      expect({ cwd, status: r.status }).toEqual({ cwd, status: 200 });
      const models = (r.body as { models: BackendModelWire[] }).models;
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.isDefault)).toBe(true);
    }
    expect(calls.map((c) => c.cwd)).toEqual([work, join(work, "sub")]);

    // Outside: another folder, a sibling that only shares the path prefix, a
    // link inside that points out, and a folder that does not exist (it
    // cannot be shown to be inside).
    for (const cwd of [
      elsewhere,
      sibling,
      join(work, "out"),
      join(work, "missing"),
    ]) {
      const r = await agentPost(srv, "claude", { cwd }, bearer);
      expect({ cwd, status: r.status, code: errCode(r.body) }).toEqual({
        cwd,
        status: 403,
        code: "spawn_exceeds_agent",
      });
    }
    expect(calls).toHaveLength(2);
  });

  it("an agent at full reach lists in any folder; full reach is per engine", async () => {
    const { srv, elsewhere, agentIn } = await setup();
    const calls = spyOnClaudeListModels();
    const rows: {
      engine: Engine;
      mode: Mode;
      sandbox?: Sandbox;
      ok: boolean;
    }[] = [
      { engine: "claude", mode: "bypassPermissions", ok: true },
      {
        engine: "codex",
        mode: "never",
        sandbox: "danger-full-access",
        ok: true,
      },
      // Codex without approvals but in a sandbox is not full reach.
      { engine: "codex", mode: "never", sandbox: "workspace-write", ok: false },
    ];
    const got = [];
    for (const row of rows) {
      const bearer = await agentIn(row.engine, row.mode, row.sandbox);
      const r = await agentPost(srv, "claude", { cwd: elsewhere }, bearer);
      got.push({ ...row, status: r.status, code: errCode(r.body) });
    }
    expect(got).toEqual(
      rows.map((row) => ({
        ...row,
        status: row.ok ? 200 : 403,
        code: row.ok ? undefined : "spawn_exceeds_agent",
      })),
    );
    expect(calls.map((c) => c.cwd)).toEqual([elsewhere, elsewhere]);
  });

  it("an agent token with no live agent record is refused and starts no backend", async () => {
    const { srv, ownerRecord, work, agentIn } = await setup();
    // The enabling condition: a live agent's token lists in this folder.
    const live = await agentIn("claude", "default");
    const calls = spyOnClaudeListModels();
    expect((await agentPost(srv, "claude", { cwd: work }, live)).status).toBe(
      200,
    );
    // A valid agent token whose agent has no record: its folder and mode are
    // unknown, so it is refused, as a spawn is.
    const ghost = mintAgentToken("agent-no-record", ownerRecord.id);
    const r = await agentPost(srv, "claude", { cwd: work }, ghost);
    expect([r.status, errCode(r.body)]).toEqual([403, "forbidden"]);
    expect(calls).toHaveLength(1);
  });
});
