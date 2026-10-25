// backends.listModels on the unified REST surface.
// POST /api/backends/:agentType/models with JSON {cwd, includeHidden?}
// (agent:manage + authenticated). Listing models can start a backend and, for
// OpenCode, bootstrap a project for cwd (which loads that folder's project
// plugins), so it is a POST: the Origin check in authenticate() refuses a
// cross-site or app-hostname browser request, and an old cookie-bearing GET
// reaches no backend (task 77ec7e9d). Claude's listModels is a static, offline
// family list, so this is deterministic and zero-LLM; a spy on it counts the
// requests that reach a backend.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
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
  // The capability (agent:manage, which an agent token lacks) is pinned in
  // routes-table.test.ts and identity-tokens.test.ts.
  it("the dialog's own POST lists the models for the resolved cwd and passes includeHidden", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const calls = spyOnClaudeListModels();

    const r = await dialogPost(
      srv,
      "claude",
      { cwd: srv.stateRoot, includeHidden: true },
      owner.rawSessionId,
    );
    expect(r.status).toBe(200);
    const models = (r.body as { models: BackendModelWire[] }).models;
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.isDefault)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(srv.stateRoot);
    expect(calls[0].includeHidden).toBe(true);

    // includeHidden is optional and defaults to false.
    const plain = await dialogPost(
      srv,
      "claude",
      { cwd: srv.stateRoot },
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
    const body = JSON.stringify({ cwd: srv.stateRoot });

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
      { cwd: srv.stateRoot },
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
      { cwd: srv.stateRoot, includeHidden: "true" },
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
      { cwd: srv.stateRoot },
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
