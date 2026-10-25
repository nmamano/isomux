// GET/PUT /api/office/settings: the owner's contract, and the privileged agents
// and API tokens that share it.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import type { OfficeSettings } from "../../shared/types.ts";
import { mintApiToken } from "../api-tokens.ts";
import { getUserByName, setUserRoleById } from "../users.ts";
import { memberUsageCap } from "../member-usage-cap.ts";

describe("office settings", () => {
  // Phase 3a slice 3a.5 - office.{getSettings,setSettings} on the unified REST
  // surface. Owner-only for humans (office:settings + officeSettingsOwner); who
  // else reaches them is in the next block.
  //
  // What this freezes:
  //   - getSettings returns the editable settings without legacy envFile plus the
  //     optimistic-concurrency `version` over the whole blob.
  //   - setSettings validates COMPLETELY before mutate/emit: an over-long name
  //     returns 400 and does NOT mutate state or emit. Valid save 204 + persists +
  //     emits office_settings_updated.
  //   - name omitted-vs-null at the REST boundary: omitting preserves the current
  //     name, explicit null clears it (the validate-then-apply core's semantics).
  //   - Optimistic concurrency (task 44a2c98d, mirroring memory READ→REPLACE):
  //     the PUT REQUIRES the version from a preceding GET (missing -> 400
  //     invalid_version); a stale version -> 409 version_conflict carrying the
  //     CURRENT version, checked BEFORE field validation (a stale writer is told
  //     to re-read first), and neither failure writes or emits. One version
  //     guards the whole blob (name/member usage cap/terminal recording;
  //     omitted newer fields are preserved for stale clients). The office
  //     instructions are not in it: they have their own route and version.
  //   - The old `prompt` field (renamed in task 379ae5db, removed in task
  //     744fa64a) is refused in a write, and absent from the read.
  //
  // Seam: startTestServer(). Zero LLM.

  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(
    pred: () => boolean,
    timeoutMs = 2000,
    label = "cond",
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pred()) return;
      if (Date.now() > deadline)
        throw new Error(`waitUntil timed out: ${label}`);
      await sleep(10);
    }
  }

  interface Res {
    status: number;
    body: unknown;
  }
  async function api(
    srv: TestServer,
    path: string,
    init: {
      method?: string;
      body?: unknown;
      rawSessionId?: string;
      bearer?: string;
    } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
    const res = await srv.http(path, {
      method: init.method ?? "GET",
      headers,
      rawSessionId: init.rawSessionId,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  // Read the current settings version the way a real writer does (GET first).
  async function officeVersion(
    srv: TestServer,
    rawSessionId: string,
  ): Promise<string> {
    const r = await api(srv, "/api/office/settings", { rawSessionId });
    if (r.status !== 200) throw new Error(`officeVersion -> ${r.status}`);
    return (r.body as { version: string }).version;
  }

  describe("routes/office.getSettings REST", () => {
    it("owner -> 200 without envFile or the office instructions, with the version over the whole blob", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");

      // A legacy migration marker is no longer exposed on the settings wire.
      srv.agentManager.setOfficeSettings("P", "/opt/office.env", "Acme");

      const r = await api(srv, "/api/office/settings", {
        rawSessionId: owner.rawSessionId,
      });
      expect(r.status).toBe(200);
      const s = r.body as OfficeSettings & { version: string };
      // The instructions are read at GET /api/office/instructions.
      expect(s).not.toHaveProperty("prompt");
      expect(s.name).toBe("Acme");
      expect(s).not.toHaveProperty("experimental");
      expect(s.envFile).toBeUndefined();
      // Optimistic-concurrency version over the whole blob, required by the PUT.
      expect(s.version).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe("routes/office.setSettings REST", () => {
    it("owner valid save -> 204, ignores stale envFile, and broadcasts", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      srv.agentManager.setOfficeSettings(null, "/legacy/office.env", null);
      const sock = await srv.connectWs(owner.rawSessionId);

      const version = await officeVersion(srv, owner.rawSessionId);
      const r = await api(srv, "/api/office/settings", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        body: {
          envFile: "/stale/tab.env",
          name: "Acme",
          experimental: { browserPanel: true },
          version,
        },
      });
      expect(r.status).toBe(204);

      const s = srv.agentManager.getOfficeSettings();
      expect(s.envFile).toBe("/legacy/office.env");
      expect(s.name).toBe("Acme");
      expect(s).not.toHaveProperty("experimental");

      // 3b.5 CLOSED the deferred leak: the all-audience office_settings_updated no
      // longer carries envFile (owner-only; owners read it via full_state /
      // office.getSettings). The broadcast carries the public name.
      await waitUntil(
        () =>
          sock.messages.some(
            (m) => (m as { type?: string }).type === "office_settings_updated",
          ),
        2000,
        "office_settings_updated broadcast",
      );
      const evt = sock.messages.find(
        (m) => (m as { type?: string }).type === "office_settings_updated",
      ) as {
        name?: string;
        envFile?: string;
        experimental?: { browserPanel: boolean };
      };
      expect(evt.name).toBe("Acme");
      expect(evt).not.toHaveProperty("experimental");
      expect(evt.envFile).toBeUndefined(); // 3b.5: envFile no longer rides the all-event
    });

    it("name over 60 chars -> 400, state untouched", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const version = await officeVersion(srv, owner.rawSessionId);
      const r = await api(srv, "/api/office/settings", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        body: { envFile: null, name: "x".repeat(61), version },
      });
      expect(r.status).toBe(400);
      expect(srv.agentManager.getOfficeSettings().name).toBeNull();
    });

    it("missing version -> 400 invalid_version, state untouched (write must carry the GET's version)", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const r = await api(srv, "/api/office/settings", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        body: { name: "p", envFile: null },
      });
      expect(r.status).toBe(400);
      expect((r.body as { error?: { code?: string } }).error?.code).toBe(
        "invalid_version",
      );
      expect(srv.agentManager.getOfficeSettings().name).toBeNull();
    });

    it("stale version -> 409 version_conflict with the CURRENT version, nothing written or emitted (checked before field validation)", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      // Writer A reads, then writer B saves - A's version is now stale.
      const staleVersion = await officeVersion(srv, owner.rawSessionId);
      expect(
        (
          await api(srv, "/api/office/settings", {
            method: "PUT",
            rawSessionId: owner.rawSessionId,
            body: {
              envFile: null,
              name: "B",
              version: staleVersion,
            },
          })
        ).status,
      ).toBe(204);
      const sock = await srv.connectWs(owner.rawSessionId);
      // A's write also carries an over-long name: the version guard runs first,
      // so the stale writer hears 409 (re-read), not 400 (fix the name).
      const r = await api(srv, "/api/office/settings", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        body: {
          name: "A".repeat(61),
          version: staleVersion,
        },
      });
      expect(r.status).toBe(409);
      const err = (r.body as { error?: { code?: string; version?: string } })
        .error;
      expect(err?.code).toBe("version_conflict");
      // The 409 carries the CURRENT version so the caller can re-read and retry.
      expect(err?.version).toBe(await officeVersion(srv, owner.rawSessionId));
      // Nothing written, nothing emitted.
      const s = srv.agentManager.getOfficeSettings();
      expect(s.name).toBe("B");
      await sleep(150);
      expect(
        sock.messages.some(
          (m) => (m as { type?: string }).type === "office_settings_updated",
        ),
      ).toBe(false);
    });

    it("name omitted preserves; explicit null clears (shared core, mirrors WS arm)", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");

      expect(
        (
          await api(srv, "/api/office/settings", {
            method: "PUT",
            rawSessionId: owner.rawSessionId,
            body: {
              envFile: null,
              name: "KeepMe",
              version: await officeVersion(srv, owner.rawSessionId),
            },
          })
        ).status,
      ).toBe(204);

      // Omit `name` entirely -> current name preserved.
      expect(
        (
          await api(srv, "/api/office/settings", {
            method: "PUT",
            rawSessionId: owner.rawSessionId,
            body: {
              envFile: null,
              version: await officeVersion(srv, owner.rawSessionId),
            },
          })
        ).status,
      ).toBe(204);
      expect(srv.agentManager.getOfficeSettings().name).toBe("KeepMe");

      // Explicit null -> cleared.
      expect(
        (
          await api(srv, "/api/office/settings", {
            method: "PUT",
            rawSessionId: owner.rawSessionId,
            body: {
              envFile: null,
              name: null,
              version: await officeVersion(srv, owner.rawSessionId),
            },
          })
        ).status,
      ).toBe(204);
      expect(srv.agentManager.getOfficeSettings().name).toBeNull();
    });

    it("refuses the old prompt field before the version check, and writes nothing", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      srv.agentManager.setOfficeSettings("Kept", null, "Kept name");
      const version = await officeVersion(srv, owner.rawSessionId);
      const sock = await srv.connectWs(owner.rawSessionId);
      for (const body of [
        { prompt: "Changed", version },
        { prompt: null, version },
        { prompt: "Changed", name: "Changed", version },
        // A stale version too: the caller hears about the field first.
        { prompt: "Changed", version: "000000000000" },
      ]) {
        const r = await api(srv, "/api/office/settings", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body,
        });
        const err = (
          r.body as { error?: { code?: string; message?: string } } | null
        )?.error;
        expect([body, r.status, err?.code]).toEqual([
          body,
          400,
          "invalid_request",
        ]);
        // The answer points at the field that replaced it.
        expect(err?.message).toContain("instructions");
      }
      expect(srv.agentManager.getOfficeSettings()).toEqual(
        expect.objectContaining({ prompt: "Kept", name: "Kept name" }),
      );
      expect(await officeVersion(srv, owner.rawSessionId)).toBe(version);
      await sleep(150);
      expect(
        sock.messages.some(
          (m) => (m as { type?: string }).type === "office_settings_updated",
        ),
      ).toBe(false);
    });
  });
});

describe("office settings for agents and API tokens", () => {
  // Privileged agents change the office settings (Nil, 2026-10-14): the office
  // name, the member usage cap switch and the members' share,
  // on GET/PUT /api/office/settings, while the manager is an office owner; so does
  // an office owner's API token (Lead, 2026-10-14). The check is live on each
  // request. Everyone else keeps the owner-only rule, the
  // legacy envFile stays out of the wire, and the other office:admin routes stay
  // with humans.

  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  interface Res {
    status: number;
    body: unknown;
  }

  async function call(
    srv: TestServer,
    method: string,
    path: string,
    init: { session?: string; bearer?: string; body?: unknown } = {},
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
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // 204 has no body.
    }
    return { status: response.status, body };
  }

  interface Settings {
    name: string | null;
    version: string;
    memberUsageCap: boolean;
    memberUsageShare: number;
  }

  async function office() {
    server = await startTestServer();
    const srv = server;
    const morgan = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Member");
    const morganId = getUserByName(morgan.username)!.id;
    const memberId = getUserByName(member.username)!.id;
    return {
      srv,
      morgan,
      member,
      morganId,
      ownerAgent: mintAgentToken("morgan-privileged", morganId, true),
      ownerPlain: mintAgentToken("morgan-plain", morganId, false),
      memberAgent: mintAgentToken("member-privileged", memberId, true),
    };
  }

  async function read(srv: TestServer, bearer: string): Promise<Settings> {
    const res = await call(srv, "GET", "/api/office/settings", { bearer });
    expect(res.status).toBe(200);
    return res.body as Settings;
  }

  // The version from a read and only the changed fields, as the agent reference
  // page tells an agent to write.
  async function change(
    srv: TestServer,
    bearer: string,
    fields: Partial<Settings> & Record<string, unknown>,
  ): Promise<number> {
    const current = await read(srv, bearer);
    const res = await call(srv, "PUT", "/api/office/settings", {
      bearer,
      body: { version: current.version, ...fields },
    });
    return res.status;
  }

  describe("an owner's privileged agent", () => {
    it("changes each of the three office settings", async () => {
      const o = await office();
      const bearer = o.ownerAgent;
      const before = await read(o.srv, bearer);

      expect(await change(o.srv, bearer, { name: "Acme" })).toBe(204);
      expect(o.srv.agentManager.getOfficeSettings().name).toBe("Acme");

      const share = before.memberUsageShare === 50 ? 60 : 50;
      expect(await change(o.srv, bearer, { memberUsageShare: share })).toBe(
        204,
      );
      expect((await read(o.srv, bearer)).memberUsageShare).toBe(share);

      // Last: while the cap is on, the GET reads the providers.
      expect(before.memberUsageCap).toBe(false);
      expect(await change(o.srv, bearer, { memberUsageCap: true })).toBe(204);
      expect(memberUsageCap().isEnabled()).toBe(true);

      // The earlier changes hold.
      expect(o.srv.agentManager.getOfficeSettings().name).toBe("Acme");
      expect(memberUsageCap().share()).toBe(share);
      // No reset needed: the next startTestServer wipes STATE_ROOT, and
      // startServer drops the cap module (resetMemberUsageCap).
    });

    it("keeps the office instructions on a settings write, and its row keeps no prompt text", async () => {
      const o = await office();
      const instructions = await call(
        o.srv,
        "GET",
        "/api/office/instructions",
        {
          bearer: o.ownerAgent,
        },
      );
      expect(
        (
          await call(o.srv, "PUT", "/api/office/instructions", {
            bearer: o.ownerAgent,
            body: {
              instructions: "Line one\n\n- two  ü",
              version: (instructions.body as { version: string }).version,
            },
          })
        ).status,
      ).toBe(200);
      expect(await change(o.srv, o.ownerAgent, { name: "Renamed" })).toBe(204);
      expect(o.srv.agentManager.getOfficeSettings()).toEqual(
        expect.objectContaining({
          prompt: "Line one\n\n- two  ü",
          name: "Renamed",
        }),
      );
      // A settings write no longer touches the instructions, so its audit row
      // carries no prompt text; office.setInstructions rows do.
      const audit = await call(
        o.srv,
        "GET",
        "/api/audit-log?operation=office.setSettings",
        { session: o.morgan.rawSessionId },
      );
      const [row] = (audit.body as { items: Record<string, unknown>[] }).items;
      expect(row.operation).toBe("office.setSettings");
      expect(Object.keys(row)).not.toContain("promptContent");
    });

    it("never reads or changes the legacy envFile", async () => {
      const o = await office();
      o.srv.agentManager.setOfficeSettings(null, "/legacy/office.env", null);
      const settings = await read(o.srv, o.ownerAgent);
      expect(Object.keys(settings)).not.toContain("envFile");
      expect(
        await change(o.srv, o.ownerAgent, {
          name: "P",
          envFile: "/agent/chosen.env",
        }),
      ).toBe(204);
      expect(o.srv.agentManager.getOfficeSettings()).toEqual(
        expect.objectContaining({ name: "P", envFile: "/legacy/office.env" }),
      );
      expect(Object.keys(await read(o.srv, o.ownerAgent))).not.toContain(
        "envFile",
      );
    });

    it("is checked live: after its manager loses the owner role, the next GET and PUT get 403", async () => {
      const o = await office();
      expect(await change(o.srv, o.ownerAgent, { name: "Before" })).toBe(204);
      const { version } = await read(o.srv, o.ownerAgent);
      expect(setUserRoleById(o.morganId, "member")).toBe(true);
      expect(
        (
          await call(o.srv, "GET", "/api/office/settings", {
            bearer: o.ownerAgent,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(o.srv, "PUT", "/api/office/settings", {
            bearer: o.ownerAgent,
            body: { name: "After", version },
          })
        ).status,
      ).toBe(403);
      expect(o.srv.agentManager.getOfficeSettings().name).toBe("Before");
    });

    it("gets no other office:admin route", async () => {
      const o = await office();
      for (const [method, path, body] of [
        ["GET", "/api/office/access", undefined],
        ["GET", "/api/office/update", undefined],
        ["POST", "/api/storage/prune", {}],
      ] as const) {
        const res = await call(o.srv, method, path, {
          bearer: o.ownerAgent,
          body,
        });
        expect([method, path, res.status]).toEqual([method, path, 403]);
      }
    });

    it("is named in the audit row of its write", async () => {
      const o = await office();
      expect(await change(o.srv, o.ownerAgent, { name: "Acme" })).toBe(204);
      const audit = await call(
        o.srv,
        "GET",
        "/api/audit-log?operation=office.setSettings",
        { session: o.morgan.rawSessionId },
      );
      const row = (
        audit.body as {
          items: { actor: { kind: string; id: string; ownerId?: string } }[];
        }
      ).items[0];
      expect(row.actor).toEqual(
        expect.objectContaining({
          kind: "agent",
          id: "morgan-privileged",
          ownerId: o.morganId,
        }),
      );
    });
  });

  describe("an owner's API token", () => {
    it("reads and changes the office settings, as its owner's privileged agent does", async () => {
      const o = await office();
      const { token } = await mintApiToken({
        userId: o.morganId,
        name: "Morgan token",
        expiresInDays: null,
      });
      const settings = await read(o.srv, token);
      expect(Object.keys(settings)).not.toContain("envFile");
      expect(await change(o.srv, token, { name: "Via token" })).toBe(204);
      expect(o.srv.agentManager.getOfficeSettings().name).toBe("Via token");
      expect(setUserRoleById(o.morganId, "member")).toBe(true);
      expect(
        (await call(o.srv, "GET", "/api/office/settings", { bearer: token }))
          .status,
      ).toBe(403);
    });
  });

  describe("every other caller keeps the owner-only rule", () => {
    it("refuses a member's privileged agent, an owner's ordinary agent, a member's API token and a member on GET and PUT", async () => {
      const o = await office();
      const { version } = await read(o.srv, o.ownerAgent);
      const { token: memberApi } = await mintApiToken({
        userId: getUserByName(o.member.username)!.id,
        name: "Member token",
        expiresInDays: null,
      });
      for (const [who, auth] of [
        ["member's privileged agent", { bearer: o.memberAgent }],
        ["owner's ordinary agent", { bearer: o.ownerPlain }],
        ["member's API token", { bearer: memberApi }],
        ["member", { session: o.member.rawSessionId }],
      ] as const) {
        const get = await call(o.srv, "GET", "/api/office/settings", auth);
        const put = await call(o.srv, "PUT", "/api/office/settings", {
          ...auth,
          body: { name: "X", version },
        });
        expect([who, get.status, put.status]).toEqual([who, 403, 403]);
      }
      expect(o.srv.agentManager.getOfficeSettings().name).toBeNull();
    });
  });
});
