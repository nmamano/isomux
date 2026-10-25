// The cronjob routes (server/routes/handlers/cron.ts): reads, create, update,
// delete, run now and the schedules prompt, and who sees and manages a job.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName, updateUserById } from "../users.ts";
import {
  saveRuns,
  appendRunLog,
  loadCronjobs,
} from "../cronjob-persistence.ts";
import type { StartServerOpts } from "../isomux-office.ts";
import {
  CODEX_MODELS,
  type BackendModelWire,
  type Cronjob,
  type CronjobRun,
  type LogEntry,
  cronjobRunStreamId,
  type AgentInfo,
  type CronjobListWire,
} from "../../shared/types.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { saveFile } from "../persistence.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import {
  localizeLogParts,
  type LogMessage,
} from "../../shared/i18n/log-message.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { join } from "path";

describe("cronjob REST", () => {
  // Phase 3a slice 2 - Cronjobs on the unified REST surface (opIds cron.*).
  //
  // TDD'd against the typed route table: cronjob metadata + runs reads/CRUD on the
  // /api surface, with the [behavior-change] authz tightenings ENFORCED by the
  // REST route guards (the legacy WS command arms + their shims were retired in
  // 3d.4). Attribution (createdBy/username/userId) is
  // token-derived. The legacy unprefixed /cronjobs reads are retired; their
  // end-state (401 anonymous, 404 authenticated) lives in
  // routes-legacy-retired.test.ts.
  //
  // The cron-run transcript `log_entry` compatibility bridge + RUN-bearer run
  // affordances are covered in routes-cronjobs-runs.test.ts (slice 2b).
  //
  // Seam: startTestServer(). Zero LLM.

  // AddCronjobInput is a factory-local interface; derive it from the method.
  type AddCronjobInput = Parameters<
    TestServer["cronjobManager"]["addCronjob"]
  >[0];

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
  ) {
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
    init: { method?: string; body?: unknown; rawSessionId?: string } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
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

  function createBody(
    over: Partial<AddCronjobInput> = {},
  ): Record<string, unknown> {
    return {
      name: "Nightly",
      schedule: { type: "interval", minutes: 60 },
      prompt: "do the thing",
      cwd: server!.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      ...over,
    };
  }

  function seedJob(srv: TestServer, username: string, name = "Seed"): Cronjob {
    return srv.cronjobManager.addCronjob({
      name,
      schedule: { type: "interval", minutes: 60 },
      prompt: "p",
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username,
      userId: getUserByName(username)?.id ?? null,
    });
  }

  // Persist one completed run plus a single transcript entry for it.
  function seedRun(srv: TestServer, job: Cronjob, runId: string): CronjobRun {
    const run: CronjobRun = {
      id: runId,
      cronjobId: job.id,
      cronjobName: job.name,
      trigger: "scheduled",
      status: "completed",
      startedAt: 1700000000000,
      endedAt: 1700000060000,
      errorReason: null,
      promptSnapshot: job.prompt,
      agentTypeSnapshot: job.agentType,
      modelFamilySnapshot: job.modelFamily,
      effortSnapshot: job.effort,
      cwdSnapshot: job.cwd,
      permissionModeSnapshot: job.permissionMode,
      rootSessionId: "rsess-1",
      currentSessionId: "rsess-1",
      previewText: "All done.",
    };
    saveRuns(job.id, [run]);
    appendRunLog(job.id, runId, "rsess-1", {
      id: "entry-1",
      agentId: runId,
      timestamp: 1700000030000,
      kind: "text",
      content: "summary line",
    });
    return run;
  }

  describe("routes/cron REST: reads", () => {
    it("GET /api/cronjobs/:id/system-prompt returns both prompt sources under the cron read guard", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan", "Prompt source");

      const response = await api(srv, `/api/cronjobs/${job.id}/system-prompt`, {
        rawSessionId: owner.rawSessionId,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ firstUserMessage: "p" });
      expect(
        (response.body as { systemPrompt: string }).systemPrompt,
      ).toContain("Prompt source");

      expect(
        (
          await api(srv, "/api/cronjobs/missing/system-prompt", {
            rawSessionId: owner.rawSessionId,
          })
        ).status,
      ).toBe(404);
      expect(
        (await api(srv, `/api/cronjobs/${job.id}/system-prompt`)).status,
      ).toBe(401);
    });

    // Ported from the retired unprefixed /cronjobs suite: the non-empty runs list
    // and the run-detail transcript shape had no /api coverage.
    it("a seeded run appears in listRuns and getRun returns { run, entries }; an unknown run is 404", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan");
      const seeded = seedRun(srv, job, "run00001");

      const list = await api(srv, `/api/cronjobs/${job.id}/runs`, {
        rawSessionId: owner.rawSessionId,
      });
      expect(
        (list.body as { runs: CronjobRun[] }).runs.map((r) => r.id),
      ).toEqual([seeded.id]);

      const detail = await api(
        srv,
        `/api/cronjobs/${job.id}/runs/${seeded.id}`,
        {
          rawSessionId: owner.rawSessionId,
        },
      );
      expect(detail.status).toBe(200);
      const body = detail.body as { run: CronjobRun; entries: LogEntry[] };
      expect(body.run.id).toBe(seeded.id);
      expect(body.run.status).toBe("completed");
      expect(body.entries.map((e) => e.content)).toEqual(["summary line"]);

      expect(
        (
          await api(srv, `/api/cronjobs/${job.id}/runs/missing`, {
            rawSessionId: owner.rawSessionId,
          })
        ).status,
      ).toBe(404);
    });
  });

  describe("routes/cron REST: create + attribution", () => {
    it("POST /api/cronjobs -> 201 with token-derived createdBy/username/userId; missing fields -> 400, a mismatched model -> 422", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const r = await api(srv, "/api/cronjobs", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: createBody({ name: "Nightly" }),
      });
      expect(r.status).toBe(201);
      const job = r.body as Cronjob;
      expect(job.name).toBe("Nightly");
      expect(job.createdBy).toBe("Morgan");
      expect(job.username).toBe("Morgan");
      expect(job.userId).toBe(getUserByName("Morgan")!.id);

      const before = srv.cronjobManager.listCronjobs().length;
      for (const [body, status, code] of [
        [{ name: "x" }, 400, "invalid_request"],
        // A Claude model on a Codex job: the create runs the model check too.
        [
          createBody({
            name: "Mismatch",
            agentType: "codex",
            modelFamily: "fable-5",
          }),
          422,
          "invalid_model_family",
        ],
      ] as const) {
        const bad = await api(srv, "/api/cronjobs", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body,
        });
        expect([bad.status, bad.body]).toMatchObject([
          status,
          { error: { code } },
        ]);
      }
      expect(srv.cronjobManager.listCronjobs().length).toBe(before);
    });
  });

  describe("routes/cron REST: schedule shape (task 2bc8c847)", () => {
    // Each bad schedule has one fault, and the 422 names that field. Before
    // the fix the manager floored a missing value to NaN (stored as null) and
    // clamped an out-of-range one, both with a 2xx.
    const BAD: Array<[unknown, RegExp]> = [
      // An agent's guess at the shape (task 11e311db live check).
      [{ type: "daily", time: "09:00" }, /\b(hour|minute)\b/],
      [{ type: "daily", minute: 0 }, /\bhour\b/],
      [{ type: "daily", hour: null, minute: 0 }, /\bhour\b/],
      [{ type: "daily", hour: 9 }, /\bminute\b/],
      [{ type: "daily", hour: 9.5, minute: 0 }, /\bhour\b/],
      [{ type: "daily", hour: "9", minute: 0 }, /\bhour\b/],
      [{ type: "daily", hour: 24, minute: 0 }, /\bhour\b/],
      [{ type: "daily", hour: -1, minute: 0 }, /\bhour\b/],
      [{ type: "daily", hour: 9, minute: 60 }, /\bminute\b/],
      [{ type: "weekly", hour: 9, minute: 0 }, /\bweekday\b/],
      [{ type: "weekly", weekday: 7, hour: 9, minute: 0 }, /\bweekday\b/],
      [{ type: "weekly", weekday: 1.5, hour: 9, minute: 0 }, /\bweekday\b/],
      [{ type: "weekly", weekday: 1, minute: 0 }, /\bhour\b/],
      [{ type: "weekly", weekday: 1, hour: 9, minute: 60 }, /\bminute\b/],
      [{ type: "interval" }, /\bminutes\b/],
      [{ type: "interval", minutes: 4 }, /\bminutes\b/],
      [{ type: "interval", minutes: 7.5 }, /\bminutes\b/],
      [{ type: "interval", minutes: "60" }, /\bminutes\b/],
      [{ type: "hourly", minutes: 60 }, /\btype\b/],
      [{ minutes: 60 }, /\btype\b/],
      [null, /\bschedule\b/],
      ["daily", /\bschedule\b/],
    ];
    // Boundaries and one of each type: stored exactly as sent, extra keys
    // dropped.
    const GOOD: Array<[unknown, Cronjob["schedule"]]> = [
      [
        { type: "daily", hour: 0, minute: 0 },
        { type: "daily", hour: 0, minute: 0 },
      ],
      [
        { type: "daily", hour: 23, minute: 59, time: "23:59" },
        { type: "daily", hour: 23, minute: 59 },
      ],
      [
        { type: "weekly", weekday: 0, hour: 9, minute: 30 },
        { type: "weekly", weekday: 0, hour: 9, minute: 30 },
      ],
      [
        { type: "weekly", weekday: 6, hour: 23, minute: 59 },
        { type: "weekly", weekday: 6, hour: 23, minute: 59 },
      ],
      [
        { type: "interval", minutes: 5 },
        { type: "interval", minutes: 5 },
      ],
      [{ type: "none" }, { type: "none" }],
    ];

    function expectNamed(r: Res, field: RegExp, label: string) {
      expect([label, r.status]).toEqual([label, 422]);
      const error = (r.body as { error?: { code?: string; message?: string } })
        .error;
      expect([label, error?.code]).toEqual([label, "invalid_request"]);
      expect([label, error?.message ?? ""]).toEqual([
        label,
        expect.stringMatching(field),
      ]);
    }

    it("POST refuses a schedule with a missing, non-integer or out-of-range field, naming it, and stores nothing", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      for (const [schedule, field] of BAD) {
        const r = await api(srv, "/api/cronjobs", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: createBody({ schedule: schedule as Cronjob["schedule"] }),
        });
        expectNamed(r, field, JSON.stringify(schedule));
      }
      expect(srv.cronjobManager.listCronjobs()).toHaveLength(0);
    });

    it("PATCH refuses the same schedules and leaves the stored one as it was", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan");
      for (const [schedule, field] of BAD) {
        const r = await api(srv, `/api/cronjobs/${job.id}`, {
          method: "PATCH",
          rawSessionId: owner.rawSessionId,
          body: { schedule },
        });
        expectNamed(r, field, JSON.stringify(schedule));
      }
      expect(jobById(srv, job.id)?.schedule).toEqual({
        type: "interval",
        minutes: 60,
      });
    });

    it("POST and PATCH store each valid shape as sent", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan");
      for (const [schedule, stored] of GOOD) {
        const label = JSON.stringify(schedule);
        const created = await api(srv, "/api/cronjobs", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: createBody({ schedule: schedule as Cronjob["schedule"] }),
        });
        expect([label, created.status]).toEqual([label, 201]);
        const id = (created.body as Cronjob).id;
        expect([label, jobById(srv, id)?.schedule]).toEqual([label, stored]);
        const patched = await api(srv, `/api/cronjobs/${job.id}`, {
          method: "PATCH",
          rawSessionId: owner.rawSessionId,
          body: { schedule },
        });
        expect([label, patched.status]).toEqual([label, 200]);
        expect([label, jobById(srv, job.id)?.schedule]).toEqual([
          label,
          stored,
        ]);
      }
    });

    function jobById(srv: TestServer, id: string): Cronjob | undefined {
      return srv.cronjobManager.listCronjobs().find((j) => j.id === id);
    }
  });

  describe("routes/cron REST: ownership tightening", () => {
    it("PATCH /api/cronjobs/:id changes the engine and dependent settings together", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan", "EngineSwitch");

      const result = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: owner.rawSessionId,
        body: {
          agentType: "codex",
          modelFamily: "gpt-5-codex",
          effort: "high",
          permissionMode: "never",
          codexSandbox: "workspace-write",
        },
      });

      expect(result.status).toBe(200);
      expect(result.body as Cronjob).toMatchObject({
        agentType: "codex",
        modelFamily: "gpt-5-codex",
        effort: "high",
        permissionMode: "never",
        codexSandbox: "workspace-write",
      });
    });

    it("changes a cronjob engine to OpenCode and persists no Codex sandbox", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan", "OpenCodeSwitch");

      const result = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: owner.rawSessionId,
        body: {
          agentType: "opencode",
          modelFamily: "provider/model",
          effort: "medium",
          permissionMode: "bypassPermissions",
        },
      });

      expect(result.status).toBe(200);
      expect(result.body as Cronjob).toMatchObject({
        agentType: "opencode",
        modelFamily: "provider/model",
        permissionMode: "bypassPermissions",
      });
      expect((result.body as Cronjob).codexSandbox).toBeUndefined();
      expect(loadCronjobs().find((saved) => saved.id === job.id)).toMatchObject(
        {
          agentType: "opencode",
          modelFamily: "provider/model",
        },
      );
      expect(
        loadCronjobs().find((saved) => saved.id === job.id)?.codexSandbox,
      ).toBeUndefined();
    });

    it("accepts unknown Codex-shaped cron models and rejects Claude-shaped ones", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan", "CodexShape");

      const accepted = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: owner.rawSessionId,
        body: { agentType: "codex", modelFamily: "gpt-7-x" },
      });
      expect(accepted.status).toBe(200);
      expect((accepted.body as Cronjob).modelFamily).toBe("gpt-7-x");

      const rejected = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: owner.rawSessionId,
        body: { modelFamily: "fable-5" },
      });
      expect(rejected.status).toBe(422);
      expect(rejected.body).toMatchObject({
        error: { code: "invalid_model_family" },
      });
      expect(
        loadCronjobs().find((saved) => saved.id === job.id)?.modelFamily,
      ).toBe("gpt-7-x");
    });

    it("rejects an OpenCode engine switch without a provider/model", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan", "OpenCodeWithoutModel");

      const result = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: owner.rawSessionId,
        body: { agentType: "opencode" },
      });

      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        error: { code: "invalid_model_family" },
      });
      expect(loadCronjobs().find((saved) => saved.id === job.id)).toMatchObject(
        {
          agentType: "claude",
          modelFamily: "opus",
        },
      );
    });

    it("a member cannot update/delete/run another user's cronjob via REST (403) but can manage their own", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const member = await srv.seedMember("Mallory");
      const ownersJob = seedJob(srv, "Morgan", "OwnersJob");

      // Member -> owner's job: all blocked.
      expect(
        (
          await api(srv, `/api/cronjobs/${ownersJob.id}`, {
            method: "PATCH",
            rawSessionId: member.rawSessionId,
            body: { name: "HACKED" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api(srv, `/api/cronjobs/${ownersJob.id}`, {
            method: "DELETE",
            rawSessionId: member.rawSessionId,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api(srv, `/api/cronjobs/${ownersJob.id}/runs`, {
            method: "POST",
            rawSessionId: member.rawSessionId,
            body: {},
          })
        ).status,
      ).toBe(403);
      // The owner's job is untouched.
      expect(
        srv.cronjobManager.listCronjobs().find((c) => c.id === ownersJob.id)
          ?.name,
      ).toBe("OwnersJob");

      // Member CAN create + manage their own.
      const own = await api(srv, "/api/cronjobs", {
        method: "POST",
        rawSessionId: member.rawSessionId,
        body: createBody({ name: "Mine" }),
      });
      expect(own.status).toBe(201);
      const ownId = (own.body as Cronjob).id;
      expect(
        (
          await api(srv, `/api/cronjobs/${ownId}`, {
            method: "PATCH",
            rawSessionId: member.rawSessionId,
            body: { name: "MineRenamed" },
          })
        ).status,
      ).toBe(200);

      // Owner can manage anyone's.
      expect(
        (
          await api(srv, `/api/cronjobs/${ownId}`, {
            method: "DELETE",
            rawSessionId: owner.rawSessionId,
          })
        ).status,
      ).toBe(204);
    });
  });

  describe("routes/cron REST: runNow + emit double-signal", () => {
    it("owner POST /api/cronjobs/:id/runs -> 200 {runId}", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const job = seedJob(srv, "Morgan");
      const r = await api(srv, `/api/cronjobs/${job.id}/runs`, {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: {},
      });
      expect(r.status).toBe(200);
      expect(typeof (r.body as { runId?: string }).runId).toBe("string");
    });

    it("a REST cron.create fans out cronjob_added through the emit() helper", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const sock: TestSocket = await srv.connectWs(owner.rawSessionId);
      const created = (
        await api(srv, "/api/cronjobs", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: createBody({ name: "Fanned" }),
        })
      ).body as Cronjob;
      await waitUntil(
        () =>
          sock.messages.some(
            (m) =>
              (m as { type?: string }).type === "cronjob_added" &&
              (m as { cronjob?: Cronjob }).cronjob?.id === created.id,
          ),
        2000,
        "cronjob_added for the new job",
      );
    });
  });

  // Task 141beeb6: a Codex schedule made with no model takes the default of its
  // owner's discovered model list (the listCodexModels seam), not the static
  // CODEX_MODELS[0], which a login can lack.
  describe("routes/cron REST: Codex default model from discovery", () => {
    const LOGIN_MODELS: BackendModelWire[] = [
      { id: CODEX_MODELS[0].value, label: "Static", supportedEfforts: [] },
      {
        id: "gpt-login-default",
        label: "Login default",
        isDefault: true,
        supportedEfforts: [],
      },
    ];
    type DiscoveryInput = Parameters<
      NonNullable<StartServerOpts["listCodexModels"]>
    >[0];

    async function setup() {
      const calls: DiscoveryInput[] = [];
      const srv = await startTestServer({
        startServer: {
          listCodexModels: async (input) => {
            calls.push(input);
            return LOGIN_MODELS;
          },
        },
      });
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      return { srv, owner, calls, userId: getUserByName("Morgan")!.id };
    }

    it("POST a Codex schedule with an empty model -> the login's default", async () => {
      const { srv, owner, calls, userId } = await setup();
      const r = await api(srv, "/api/cronjobs", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: createBody({
          agentType: "codex",
          modelFamily: "",
          effort: "high",
          permissionMode: "never",
        }),
      });
      expect(r.status).toBe(201);
      const job = r.body as Cronjob;
      expect(job.modelFamily).toBe("gpt-login-default");
      expect(
        loadCronjobs().find((saved) => saved.id === job.id)?.modelFamily,
      ).toBe("gpt-login-default");
      expect(calls).toHaveLength(1);
      expect(calls[0].userId).toBe(userId);
      expect(calls[0].cwd).toBe(srv.stateRoot);
    });

    it("POST a Codex schedule with a model keeps it and costs no discovery", async () => {
      const { srv, owner, calls } = await setup();
      const r = await api(srv, "/api/cronjobs", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: createBody({
          agentType: "codex",
          modelFamily: "gpt-5.5",
          effort: "high",
          permissionMode: "never",
        }),
      });
      expect(r.status).toBe(201);
      expect((r.body as Cronjob).modelFamily).toBe("gpt-5.5");
      expect(calls).toHaveLength(0);
    });

    it("PATCH claude->codex with no model -> the login's default, discovered for the job's owner", async () => {
      const { srv, owner, calls, userId } = await setup();
      const job = seedJob(srv, "Morgan", "EngineSwitch");
      const r = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: owner.rawSessionId,
        body: { agentType: "codex", effort: "high", permissionMode: "never" },
      });
      expect(r.status).toBe(200);
      expect(r.body as Cronjob).toMatchObject({
        agentType: "codex",
        modelFamily: "gpt-login-default",
      });
      expect(
        loadCronjobs().find((saved) => saved.id === job.id)?.modelFamily,
      ).toBe("gpt-login-default");
      expect(calls).toHaveLength(1);
      expect(calls[0].userId).toBe(userId);
    });

    it("PATCH a Codex schedule that names no model keeps its model and costs no discovery", async () => {
      const { srv, owner, calls } = await setup();
      const job = seedJob(srv, "Morgan", "CodexJob");
      const toCodex = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: owner.rawSessionId,
        body: { agentType: "codex", modelFamily: "gpt-5.5" },
      });
      expect(toCodex.status).toBe(200);
      for (const body of [
        { name: "Renamed", effort: "low" },
        { agentType: "codex", effort: "high" },
      ]) {
        const r = await api(srv, `/api/cronjobs/${job.id}`, {
          method: "PATCH",
          rawSessionId: owner.rawSessionId,
          body,
        });
        expect(r.status).toBe(200);
        expect((r.body as Cronjob).modelFamily).toBe("gpt-5.5");
      }
      expect(loadCronjobs().find((saved) => saved.id === job.id)?.name).toBe(
        "Renamed",
      );
      expect(calls).toHaveLength(0);
    });
  });
});

describe("cronjob rooms", () => {
  // Cronjobs belong to a room (task f0679cfe). Who sees a job, on every
  // surface: the REST list/get, the system prompt, runs and transcripts, the
  // WebSocket state and deltas, run updates and live run entries, run files, and
  // the /isomux-cronjob-system-prompt picker.
  //
  //   SEE    - maker, office owners, members of the job's live room: the whole
  //            job, runs and transcripts included.
  //   MANAGE - maker and office owners only. Room access never widens it.
  //
  // Seam: startTestServer(). Zero LLM.

  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(pred: () => boolean, label: string, ms = 2000) {
    const deadline = Date.now() + ms;
    while (!pred()) {
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
    if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await srv.http(path, {
      method: init.method ?? "GET",
      headers,
      rawSessionId: init.rawSessionId,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  async function spawnAgent(
    srv: TestServer,
    name: string,
    roomId: string,
  ): Promise<AgentInfo> {
    const info = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      roomId,
      undefined,
      undefined,
      undefined,
      undefined,
      "claude",
    );
    if (!info) throw new Error(`spawn ${name} returned null`);
    return info;
  }

  const PROMPT = "PRIVATE_PROMPT_MARKER";

  function createBody(
    srv: TestServer,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      name: "Nightly",
      schedule: { type: "interval", minutes: 60 },
      prompt: PROMPT,
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      ...over,
    };
  }

  function seedJob(
    srv: TestServer,
    username: string,
    roomId: string | undefined,
    name = "Seed",
  ): Cronjob {
    return srv.cronjobManager.addCronjob({
      name,
      schedule: { type: "interval", minutes: 60 },
      prompt: PROMPT,
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username,
      userId: getUserByName(username)?.id ?? null,
      roomId,
    });
  }

  function seedRun(job: Cronjob, runId: string): CronjobRun {
    const run: CronjobRun = {
      id: runId,
      cronjobId: job.id,
      cronjobName: job.name,
      trigger: "scheduled",
      status: "completed",
      startedAt: 1700000000000,
      endedAt: 1700000060000,
      errorReason: null,
      promptSnapshot: job.prompt,
      agentTypeSnapshot: job.agentType,
      modelFamilySnapshot: job.modelFamily,
      effortSnapshot: job.effort,
      cwdSnapshot: job.cwd,
      permissionModeSnapshot: job.permissionMode,
      rootSessionId: "rsess-1",
      currentSessionId: "rsess-1",
      previewText: "transcript excerpt",
    };
    saveRuns(job.id, [run]);
    appendRunLog(job.id, runId, "rsess-1", {
      id: "entry-1",
      agentId: cronjobRunStreamId(runId),
      timestamp: 1700000030000,
      kind: "text",
      content: "transcript line",
    });
    return run;
  }

  // An office with an owner, two rooms, and three members: Alice (room A),
  // Bob (room B), Maker (room A, makes jobs).
  async function office() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const roomA = srv.agentManager.createRoom("Alpha");
    const roomB = srv.agentManager.createRoom("Beta");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const maker = await srv.seedMember("Maker");
    const grant = (name: string, rooms: string[]) =>
      expect(
        updateUserById(getUserByName(name)!.id, { allowedRooms: rooms }).ok,
      ).toBe(true);
    grant("Alice", [roomA]);
    grant("Bob", [roomB]);
    grant("Maker", [roomA]);
    return { srv, owner, alice, bob, maker, roomA, roomB, grant };
  }

  const ids = (r: Res) => (r.body as CronjobListWire[]).map((c) => c.id);
  const typesOf = (sock: TestSocket) =>
    sock.messages.map((m) => (m as { type?: string }).type);

  describe("cron rooms: who sees a cronjob over REST", () => {
    it("a room member gets the whole record without manage authority; a non-member gets 404; the maker and owners may manage", async () => {
      const { srv, owner, alice, bob, maker, roomA } = await office();
      const job = seedJob(srv, "Maker", roomA, "Report");

      const asAlice = await api(srv, `/api/cronjobs/${job.id}`, {
        rawSessionId: alice.rawSessionId,
      });
      expect(asAlice.status).toBe(200);
      expect(asAlice.body).toMatchObject({
        id: job.id,
        name: "Report",
        canManage: false,
        roomId: roomA,
        prompt: PROMPT,
        cwd: srv.stateRoot,
        modelFamily: "opus",
      });

      expect(
        (
          await api(srv, `/api/cronjobs/${job.id}`, {
            rawSessionId: bob.rawSessionId,
          })
        ).status,
      ).toBe(404);
      expect(
        ids(
          await api(srv, "/api/cronjobs", { rawSessionId: bob.rawSessionId }),
        ),
      ).not.toContain(job.id);
      expect(
        (
          await api(srv, "/api/cronjobs/nope", {
            rawSessionId: owner.rawSessionId,
          })
        ).status,
      ).toBe(404);

      for (const who of [maker, owner]) {
        const full = await api(srv, `/api/cronjobs/${job.id}`, {
          rawSessionId: who.rawSessionId,
        });
        expect(full.body).toMatchObject({ canManage: true, prompt: PROMPT });
      }
    });

    it("a roomless job (every stored job written before rooms) is the maker's and office owners' only", async () => {
      const { srv, owner, alice, maker } = await office();
      const job = seedJob(srv, "Maker", undefined, "Legacy");
      expect(job.roomId).toBeUndefined();
      expect(
        ids(
          await api(srv, "/api/cronjobs", { rawSessionId: alice.rawSessionId }),
        ),
      ).not.toContain(job.id);
      for (const who of [maker, owner]) {
        expect(
          ids(
            await api(srv, "/api/cronjobs", { rawSessionId: who.rawSessionId }),
          ),
        ).toContain(job.id);
      }
    });

    it("closing the room leaves the job to its maker and owners, and it keeps its schedule", async () => {
      const { srv, alice, maker } = await office();
      const roomC = srv.agentManager.createRoom("Gamma");
      updateUserById(getUserByName("Alice")!.id, { allowedRooms: [roomC] });
      updateUserById(getUserByName("Maker")!.id, { allowedRooms: [roomC] });
      const job = seedJob(srv, "Maker", roomC, "Orphan");
      expect(
        ids(
          await api(srv, "/api/cronjobs", { rawSessionId: alice.rawSessionId }),
        ),
      ).toContain(job.id);

      expect(srv.agentManager.closeRoom(roomC)).toBe(true);
      expect(
        ids(
          await api(srv, "/api/cronjobs", { rawSessionId: alice.rawSessionId }),
        ),
      ).not.toContain(job.id);
      expect(
        ids(
          await api(srv, "/api/cronjobs", { rawSessionId: maker.rawSessionId }),
        ),
      ).toContain(job.id);
      const stored = srv.cronjobManager
        .listCronjobs()
        .find((c) => c.id === job.id)!;
      expect(stored.enabled).toBe(true);
      expect(stored.roomId).toBe(roomC);
    });
  });

  describe("cron rooms: runs, transcripts and the system prompt follow SEE", () => {
    it("a room member reads the system prompt, the run list and a transcript; a non-member gets 404; listAllRuns follows suit", async () => {
      const { srv, owner, alice, bob, maker, roomA } = await office();
      const job = seedJob(srv, "Maker", roomA);
      seedRun(job, "run00001");

      for (const path of [
        `/api/cronjobs/${job.id}/system-prompt`,
        `/api/cronjobs/${job.id}/runs`,
        `/api/cronjobs/${job.id}/runs/run00001`,
      ]) {
        const denied = await api(srv, path, { rawSessionId: bob.rawSessionId });
        expect(denied.status).toBe(404);
        expect(JSON.stringify(denied.body)).not.toContain(PROMPT);
        for (const who of [alice, maker, owner]) {
          expect(
            (await api(srv, path, { rawSessionId: who.rawSessionId })).status,
          ).toBe(200);
        }
      }

      const allRuns = (who: string) =>
        api(srv, "/api/cron-runs", { rawSessionId: who }).then((r) =>
          (r.body as { jobs: { cronjobId: string }[] }).jobs.map(
            (j) => j.cronjobId,
          ),
        );
      expect(await allRuns(bob.rawSessionId)).not.toContain(job.id);
      expect(await allRuns(alice.rawSessionId)).toContain(job.id);
      expect(await allRuns(maker.rawSessionId)).toContain(job.id);
      expect(await allRuns(owner.rawSessionId)).toContain(job.id);
    });

    it("runs of a deleted job are office owners' only", async () => {
      const { srv, owner, maker, roomA } = await office();
      const job = seedJob(srv, "Maker", roomA);
      seedRun(job, "run00002");
      srv.cronjobManager.deleteCronjob(job.id);
      const path = `/api/cronjobs/${job.id}/runs/run00002`;
      expect(
        (await api(srv, path, { rawSessionId: maker.rawSessionId })).status,
      ).toBe(404);
      expect(
        (await api(srv, path, { rawSessionId: owner.rawSessionId })).status,
      ).toBe(200);
    });

    it("run files follow SEE, and an unknown run's files deny even an owner", async () => {
      const { srv, owner, alice, bob, maker, roomA } = await office();
      const job = seedJob(srv, "Maker", roomA);
      seedRun(job, "run00003");
      const stream = cronjobRunStreamId("run00003");
      const saved = saveFile(
        stream,
        Buffer.from("run output"),
        "text/plain",
        "out.txt",
      )!;
      const orphan = cronjobRunStreamId("run99999");
      saveFile(orphan, Buffer.from("x"), "text/plain", "out.txt");
      const fileStatus = async (who: string, streamId: string) =>
        (
          await srv.http(`/api/files/${streamId}/${saved.filename}`, {
            rawSessionId: who,
          })
        ).status;
      expect(await fileStatus(bob.rawSessionId, stream)).toBe(403);
      expect(await fileStatus(alice.rawSessionId, stream)).toBe(200);
      expect(await fileStatus(maker.rawSessionId, stream)).toBe(200);
      expect(await fileStatus(owner.rawSessionId, stream)).toBe(200);
      expect(await fileStatus(owner.rawSessionId, orphan)).toBe(403);
    });
  });

  describe("cron rooms: create and move", () => {
    it('a member files into a room they can access, gets 404 for one they cannot, and "" means no room', async () => {
      const { srv, maker, roomA, roomB } = await office();
      const inA = await api(srv, "/api/cronjobs", {
        method: "POST",
        rawSessionId: maker.rawSessionId,
        body: createBody(srv, { roomId: roomA }),
      });
      expect(inA.status).toBe(201);
      expect(inA.body).toMatchObject({ roomId: roomA, canManage: true });

      const before = srv.cronjobManager.listCronjobs().length;
      const inB = await api(srv, "/api/cronjobs", {
        method: "POST",
        rawSessionId: maker.rawSessionId,
        body: createBody(srv, { roomId: roomB }),
      });
      expect(inB.status).toBe(404);
      expect(srv.cronjobManager.listCronjobs().length).toBe(before);

      const none = await api(srv, "/api/cronjobs", {
        method: "POST",
        rawSessionId: maker.rawSessionId,
        body: createBody(srv, { roomId: "" }),
      });
      expect(none.status).toBe(201);
      expect(none.body).not.toHaveProperty("roomId");
    });

    it("a privileged agent's cronjob defaults to the agent's room; an explicit room follows task rules", async () => {
      const { srv, roomA, roomB } = await office();
      const makerId = getUserByName("Maker")!.id;
      const bot = await spawnAgent(srv, "CronBot", roomA);
      const token = mintAgentToken(bot.id, makerId, true);
      const created = await api(srv, "/api/cronjobs", {
        method: "POST",
        bearer: token,
        body: createBody(srv),
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ roomId: roomA, canManage: true });

      expect(
        (
          await api(srv, "/api/cronjobs", {
            method: "POST",
            bearer: token,
            body: createBody(srv, { roomId: roomB }),
          })
        ).status,
      ).toBe(404);
    });

    it("the room stays put when the maker agent moves", async () => {
      const { srv, roomA, roomB } = await office();
      const ownerId = getUserByName("Morgan")!.id;
      const bot = await spawnAgent(srv, "Mover", roomA);
      const token = mintAgentToken(bot.id, ownerId, true);
      const created = (
        await api(srv, "/api/cronjobs", {
          method: "POST",
          bearer: token,
          body: createBody(srv),
        })
      ).body as Cronjob;
      expect(created.roomId).toBe(roomA);
      expect(srv.agentManager.moveAgent(bot.id, roomB)).toBe(true);
      expect(
        srv.cronjobManager.listCronjobs().find((c) => c.id === created.id)
          ?.roomId,
      ).toBe(roomA);
    });

    it("only the maker or an owner moves a job; a room member cannot", async () => {
      const { srv, alice, maker, roomA } = await office();
      const job = seedJob(srv, "Maker", roomA);
      expect(
        (
          await api(srv, `/api/cronjobs/${job.id}`, {
            method: "PATCH",
            rawSessionId: alice.rawSessionId,
            body: { roomId: "" },
          })
        ).status,
      ).toBe(403);
      const moved = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: maker.rawSessionId,
        body: { roomId: "" },
      });
      expect(moved.status).toBe(200);
      expect(moved.body).not.toHaveProperty("roomId");
      // An edit without roomId keeps the room.
      const back = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: maker.rawSessionId,
        body: { roomId: roomA },
      });
      expect(back.body).toMatchObject({ roomId: roomA });
      const renamed = await api(srv, `/api/cronjobs/${job.id}`, {
        method: "PATCH",
        rawSessionId: maker.rawSessionId,
        body: { name: "Renamed" },
      });
      expect(renamed.body).toMatchObject({ roomId: roomA, name: "Renamed" });
    });

    it("an API token of the maker sees and manages the job; one of another member does not see it", async () => {
      const { srv, roomA } = await office();
      const job = seedJob(srv, "Maker", undefined);
      const makerToken = await mintApiToken({
        userId: getUserByName("Maker")!.id,
        name: "Laptop",
        expiresInDays: null,
      });
      const aliceToken = await mintApiToken({
        userId: getUserByName("Alice")!.id,
        name: "Laptop",
        expiresInDays: null,
      });
      const asMaker = await api(srv, `/api/cronjobs/${job.id}`, {
        bearer: makerToken.token,
      });
      expect(asMaker.body).toMatchObject({ canManage: true });
      expect(
        (
          await api(srv, `/api/cronjobs/${job.id}`, {
            bearer: aliceToken.token,
          })
        ).status,
      ).toBe(404);
      // Filed into room A, Alice's token sees it without manage authority.
      srv.cronjobManager.updateCronjob(job.id, { roomId: roomA });
      expect(
        (
          await api(srv, `/api/cronjobs/${job.id}`, {
            bearer: aliceToken.token,
          })
        ).body,
      ).toMatchObject({ prompt: PROMPT, canManage: false });
    });
  });

  describe("cron rooms: the WebSocket", () => {
    it("cronjobs_state and deltas are projected per socket; a non-member hears nothing", async () => {
      const { srv, alice, bob, maker, roomA, roomB } = await office();
      const aliceWs = await srv.connectWs(alice.rawSessionId);
      const bobWs = await srv.connectWs(bob.rawSessionId);
      const makerWs = await srv.connectWs(maker.rawSessionId);
      await aliceWs.waitFor("cronjobs_state");
      await bobWs.waitFor("cronjobs_state");

      const job = seedJob(srv, "Maker", roomA, "Live");
      const added = await aliceWs.waitFor("cronjob_added");
      expect(added.cronjob).toMatchObject({
        id: job.id,
        prompt: PROMPT,
        canManage: false,
      });
      const makerAdded = await makerWs.waitFor("cronjob_added");
      expect(makerAdded.cronjob).toMatchObject({
        prompt: PROMPT,
        canManage: true,
      });

      // Moving the job to room B: Alice is told it is gone, Bob learns it.
      srv.cronjobManager.updateCronjob(job.id, { roomId: roomB });
      await waitUntil(
        () =>
          aliceWs.messages.some(
            (m) =>
              (m as { type?: string }).type === "cronjob_deleted" &&
              (m as { id?: string }).id === job.id,
          ),
        "alice cronjob_deleted",
      );
      const bobUpdate = await bobWs.waitFor("cronjob_updated");
      expect(bobUpdate.cronjob).toMatchObject({ id: job.id, canManage: false });
      expect(typesOf(bobWs)).not.toContain("cronjob_added");

      // A connect hydrates only what the socket may see.
      const aliceAgain = await srv.connectWs(alice.rawSessionId);
      const state = await aliceAgain.waitFor("cronjobs_state");
      expect(state.cronjobs as CronjobListWire[]).toEqual([]);
    });

    it("run rows and live run entries reach the maker and room members; a non-member hears none", async () => {
      const { srv, alice, bob, maker, roomA } = await office();
      const job = seedJob(srv, "Maker", roomA, "Runner");
      const aliceWs = await srv.connectWs(alice.rawSessionId);
      const bobWs = await srv.connectWs(bob.rawSessionId);
      const makerWs = await srv.connectWs(maker.rawSessionId);
      await aliceWs.waitFor("cronjobs_state");
      await bobWs.waitFor("cronjobs_state");
      await makerWs.waitFor("cronjobs_state");

      const run = srv.cronjobManager.runCronjobNow(job.id, "Maker")!;
      const sawCompleted = (sock: TestSocket) =>
        sock.messages.some(
          (m) =>
            (m as { type?: string }).type === "cronjob_run_updated" &&
            (m as { run?: CronjobRun }).run?.status === "completed",
        );
      await waitUntil(
        () => sawCompleted(makerWs) && sawCompleted(aliceWs),
        "maker and alice see the run complete",
        5000,
      );
      const stream = cronjobRunStreamId(run.id);
      const sawRunEntry = (sock: TestSocket) =>
        sock.messages.some(
          (m) =>
            (m as { type?: string }).type === "log_entry" &&
            (m as { entry?: { agentId?: string } }).entry?.agentId === stream,
        );
      expect(sawRunEntry(makerWs)).toBe(true);
      expect(sawRunEntry(aliceWs)).toBe(true);
      expect(sawRunEntry(bobWs)).toBe(false);
      expect(typesOf(bobWs)).not.toContain("cronjob_run_updated");
      expect(JSON.stringify(bobWs.messages)).not.toContain(PROMPT);
    });
  });

  describe("cron rooms: /isomux-cronjob-system-prompt", () => {
    async function sendHuman(
      srv: TestServer,
      rawSessionId: string,
      agentId: string,
      text: string,
    ) {
      const res = await srv.http(`/api/agents/${agentId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        rawSessionId,
      });
      expect(res.status).toBeLessThan(400);
    }

    it("lists and resolves only the jobs the typing member may see", async () => {
      const { srv, alice, roomA, roomB } = await office();
      const makersJob = seedJob(srv, "Maker", roomA, "Makers job");
      const morganJob = seedJob(srv, "Morgan", roomA, "Morgan job");
      const betaJob = seedJob(srv, "Morgan", roomB, "Beta job");
      const agent = await spawnAgent(srv, "Picker", roomA);
      const markerFor = (jobId: string) =>
        srv.agentManager
          .getAgentLogs(agent.id)
          .some((entry) => entry.metadata?.cronjobId === jobId);

      const ran = (text: string) =>
        srv.agentManager
          .getAgentLogs(agent.id)
          .some(
            (entry) => entry.kind === "user_message" && entry.content === text,
          );

      // Alice cannot see the room B job.
      const hidden = `/isomux-cronjob-system-prompt ${betaJob.id}`;
      await sendHuman(srv, alice.rawSessionId, agent.id, hidden);
      expect(ran(hidden)).toBe(true);
      expect(markerFor(betaJob.id)).toBe(false);

      await sendHuman(
        srv,
        alice.rawSessionId,
        agent.id,
        "/isomux-cronjob-system-prompt",
      );
      const interaction = srv.agentManager
        .getPendingInteractions()
        .find((item) => item.agentId === agent.id);
      expect(interaction?.choices.map((c) => c.value).sort()).toEqual(
        [makersJob.id, morganJob.id].sort(),
      );

      await sendHuman(
        srv,
        alice.rawSessionId,
        agent.id,
        `/isomux-cronjob-system-prompt ${makersJob.id}`,
      );
      expect(markerFor(makersJob.id)).toBe(true);
    });
  });
});

describe("schedules an ordinary agent makes", () => {
  // Task c4233bfd. An ordinary agent (cron:own, no cron:manage) creates,
  // reads, edits, deletes and runs only the schedules IT made, and each one is
  // capped at the agent's current mode and folder (server/cron-agent-limits.ts;
  // the whole mode table is in server/cron-agent-limits.test.ts). The cap
  // holds at the agent's writes and triggers (403 schedule_exceeds_agent) and
  // at every run start, whoever starts it (a failed run). The room is checked
  // only where a request sets it.
  //
  // Seam: startTestServer(). Zero LLM.

  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  interface Res {
    status: number;
    body: unknown;
  }
  type Caller = { bearer: string } | { rawSessionId: string };
  async function api(
    srv: TestServer,
    path: string,
    caller: Caller,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = {};
    if ("bearer" in caller)
      headers["Authorization"] = `Bearer ${caller.bearer}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await srv.http(path, {
      method: init.method ?? "GET",
      headers,
      ...("rawSessionId" in caller
        ? { rawSessionId: caller.rawSessionId }
        : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }
  const errCode = (r: Res) =>
    (r.body as { error?: { code?: string } } | null)?.error?.code;
  // Status and error code together, so a refusal from an earlier check
  // (a 404 room, a 400 cwd) cannot pass for the cap.
  const outcome = (r: Res) => [r.status, errCode(r) ?? null];
  const CAP_REFUSED = [403, "schedule_exceeds_agent"];

  function createBody(
    cwd: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      name: "Nightly",
      schedule: { type: "interval", minutes: 60 },
      prompt: "do the thing",
      cwd,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      ...over,
    };
  }

  // An office with an owner, rooms A and B, and Alice, who reaches both and
  // manages an ordinary Claude agent in room A with full access in `home`.
  async function office() {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Morgan");
    const roomA = srv.agentManager.createRoom("Alpha");
    const roomB = srv.agentManager.createRoom("Beta");
    const alice = await srv.seedMember("Alice");
    const aliceId = getUserByName("Alice")!.id;
    expect(updateUserById(aliceId, { allowedRooms: [roomA, roomB] }).ok).toBe(
      true,
    );
    const work = mkdtempSync(join(srv.stateRoot, "own-cron-"));
    const home = join(work, "home");
    const sub = join(home, "sub");
    const outside = join(work, "outside");
    for (const dir of [home, sub, outside]) mkdirSync(dir);

    async function spawnAgent(
      name: string,
      opts: {
        permissionMode?: AgentInfo["permissionMode"];
        agentType?: AgentInfo["agentType"];
        codexSandbox?: AgentInfo["codexSandbox"];
        cwd?: string;
        privileged?: boolean;
      } = {},
    ) {
      const info = await srv.agentManager.spawn(
        name,
        opts.cwd ?? home,
        opts.permissionMode ?? "bypassPermissions",
        undefined,
        undefined,
        roomA,
        undefined,
        undefined,
        undefined,
        "Alice",
        opts.agentType ?? "claude",
        opts.codexSandbox,
        aliceId,
      );
      if (!info) throw new Error(`spawn ${name} returned null`);
      if (opts.privileged) await srv.agentManager.setPrivileged(info.id, true);
      return {
        info,
        as: { bearer: mintAgentToken(info.id, aliceId, opts.privileged) },
      };
    }

    const bot = await spawnAgent("Bot");
    return {
      srv,
      roomA,
      roomB,
      aliceId,
      asAlice: { rawSessionId: alice.rawSessionId },
      bot,
      spawnAgent,
      home,
      sub,
      outside,
    };
  }

  async function create(
    srv: TestServer,
    caller: Caller,
    body: Record<string, unknown>,
  ): Promise<CronjobListWire> {
    const made = await api(srv, "/api/cronjobs", caller, {
      method: "POST",
      body,
    });
    expect(made.status).toBe(201);
    return made.body as CronjobListWire;
  }

  const runsOf = (srv: TestServer, jobId: string) =>
    srv.cronjobManager.getRunsForCronjob(jobId);
  const runById = (srv: TestServer, jobId: string, runId: string) =>
    runsOf(srv, jobId).find((r) => r.id === runId);
  // A member's Run now, which the agent cap at the route never sees: only the
  // run-start check can refuse it.
  async function memberRun(
    srv: TestServer,
    asAlice: Caller,
    jobId: string,
  ): Promise<CronjobRun> {
    const res = await api(srv, `/api/cronjobs/${jobId}/runs`, asAlice, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(200);
    const runId = (res.body as { runId: string }).runId;
    const run = runById(srv, jobId, runId);
    if (!run) throw new Error(`run ${runId} not recorded`);
    return run;
  }
  // Whether a run was refused at its start: failed with a reason. A run the
  // check lets through starts (the fake backend may already have completed
  // it) and carries no reason.
  const refusedAtStart = (run: CronjobRun) => [
    run.status === "failed",
    typeof run.errorReason === "string" && run.errorReason.length > 0,
  ];
  const REFUSED_RUN = [true, true];
  const STARTED_RUN = [false, false];
  // A refusal is a catalog message that names the agent, worded for each
  // reader, and errorReason is its English (task ef6b1c31). Returns its key.
  function wordedRefusalKey(run: CronjobRun, agentName: string): string {
    const parts = run.errorReasonMessage;
    expect(parts).toBeDefined();
    const english = localizeLogParts(translatorFor("en"), parts);
    expect(english).toBe(run.errorReason);
    const catalan = localizeLogParts(translatorFor("ca"), parts);
    expect(catalan).toContain(agentName);
    expect(catalan).not.toBe(english);
    return (parts![0] as LogMessage).key;
  }

  it("an ordinary agent creates, reads, edits, runs and deletes its own schedule", async () => {
    const { srv, roomA, aliceId, bot, home } = await office();
    const job = await create(srv, bot.as, createBody(home));
    // The job is Alice's, made by the agent, in the agent's room.
    expect(job).toMatchObject({
      userId: aliceId,
      createdByAgentId: bot.info.id,
      roomId: roomA,
      canManage: true,
    });

    const listed = await api(srv, "/api/cronjobs", bot.as);
    expect(listed.status).toBe(200);
    expect((listed.body as CronjobListWire[]).map((c) => c.id)).toEqual([
      job.id,
    ]);
    const got = await api(srv, `/api/cronjobs/${job.id}`, bot.as);
    expect([got.status, (got.body as CronjobListWire).canManage]).toEqual([
      200,
      true,
    ]);

    const edited = await api(srv, `/api/cronjobs/${job.id}`, bot.as, {
      method: "PATCH",
      body: { prompt: "do the other thing" },
    });
    expect(edited.status).toBe(200);
    expect(
      srv.cronjobManager.listCronjobs().find((c) => c.id === job.id)?.prompt,
    ).toBe("do the other thing");

    const ran = await api(srv, `/api/cronjobs/${job.id}/runs`, bot.as, {
      method: "POST",
      body: {},
    });
    expect(ran.status).toBe(200);
    const runId = (ran.body as { runId: string }).runId;
    expect(refusedAtStart(runById(srv, job.id, runId)!)).toEqual(STARTED_RUN);
    const runs = await api(srv, `/api/cronjobs/${job.id}/runs`, bot.as);
    expect(
      (runs.body as { runs: CronjobRun[] }).runs.map((r) => r.id),
    ).toContain(runId);
    const transcript = await api(
      srv,
      `/api/cronjobs/${job.id}/runs/${runId}`,
      bot.as,
    );
    expect(transcript.status).toBe(200);

    const deleted = await api(srv, `/api/cronjobs/${job.id}`, bot.as, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(srv.cronjobManager.listCronjobs().map((c) => c.id)).not.toContain(
      job.id,
    );
  });

  it("an ordinary agent has no reach over its member's schedule, another agent's, or a privileged agent's, even in its own room", async () => {
    const { srv, roomA, asAlice, bot, spawnAgent, home } = await office();
    const peer = await spawnAgent("Peer");
    const boss = await spawnAgent("Boss", { privileged: true });
    const own = await create(srv, bot.as, createBody(home, { name: "own" }));
    const others = {
      member: await create(
        srv,
        asAlice,
        createBody(home, { name: "member", roomId: roomA }),
      ),
      peer: await create(srv, peer.as, createBody(home, { name: "peer" })),
      privileged: await create(
        srv,
        boss.as,
        createBody(home, { name: "privileged" }),
      ),
    };
    // Every other job sits in room A, the agent's room, made for Alice.
    for (const job of Object.values(others)) expect(job.roomId).toBe(roomA);
    const memberRunId = (await memberRun(srv, asAlice, others.member.id)).id;

    const listed = await api(srv, "/api/cronjobs", bot.as);
    expect((listed.body as CronjobListWire[]).map((c) => c.id)).toEqual([
      own.id,
    ]);
    const allRuns = await api(srv, "/api/cron-runs", bot.as);
    expect(allRuns.status).toBe(200);
    expect(
      (allRuns.body as { jobs: { cronjobId: string }[] }).jobs.map(
        (j) => j.cronjobId,
      ),
    ).not.toContain(others.member.id);

    for (const [who, job] of Object.entries(others)) {
      const statuses = {
        get: (await api(srv, `/api/cronjobs/${job.id}`, bot.as)).status,
        systemPrompt: (
          await api(srv, `/api/cronjobs/${job.id}/system-prompt`, bot.as)
        ).status,
        runs: (await api(srv, `/api/cronjobs/${job.id}/runs`, bot.as)).status,
        patch: (
          await api(srv, `/api/cronjobs/${job.id}`, bot.as, {
            method: "PATCH",
            body: { name: "HIJACKED" },
          })
        ).status,
        runNow: (
          await api(srv, `/api/cronjobs/${job.id}/runs`, bot.as, {
            method: "POST",
            body: {},
          })
        ).status,
        delete: (
          await api(srv, `/api/cronjobs/${job.id}`, bot.as, {
            method: "DELETE",
          })
        ).status,
      };
      expect([who, statuses]).toEqual([
        who,
        {
          get: 404,
          systemPrompt: 404,
          runs: 404,
          patch: 403,
          runNow: 403,
          delete: 403,
        },
      ]);
    }
    expect(
      (
        await api(
          srv,
          `/api/cronjobs/${others.member.id}/runs/${memberRunId}`,
          bot.as,
        )
      ).status,
    ).toBe(404);

    // Nothing changed, and no run started on another's job.
    const stored = srv.cronjobManager.listCronjobs();
    for (const job of Object.values(others)) {
      expect(stored.find((c) => c.id === job.id)?.name).toBe(job.name);
    }
    expect(runsOf(srv, others.peer.id)).toHaveLength(0);
    expect(runsOf(srv, others.privileged.id)).toHaveLength(0);
    expect(runsOf(srv, others.member.id).map((r) => r.id)).toEqual([
      memberRunId,
    ]);

    // Alice and the privileged agent keep today's reach over the agent's job.
    expect((await api(srv, `/api/cronjobs/${own.id}`, boss.as)).status).toBe(
      200,
    );
    expect(
      (
        await api(srv, `/api/cronjobs/${own.id}`, asAlice, {
          method: "PATCH",
          body: { name: "renamed by Alice" },
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a schedule that reaches more than the agent: a wider mode, another folder, a link out of the folder, another room", async () => {
    const { srv, roomB, bot, spawnAgent, home, sub, outside } = await office();
    const before = srv.cronjobManager.listCronjobs().length;
    const linkOut = join(home, "link-out");
    symlinkSync(outside, linkOut);
    const autoBot = await spawnAgent("Auto", { permissionMode: "auto" });
    const codexBot = await spawnAgent("Codex", {
      agentType: "codex",
      permissionMode: "never",
      codexSandbox: "workspace-write",
    });
    const codexJob = (sandbox: string) =>
      createBody(home, {
        agentType: "codex",
        modelFamily: CODEX_MODELS[0].value,
        permissionMode: "never",
        codexSandbox: sandbox,
      });

    const refusals: Array<[string, Caller, Record<string, unknown>]> = [
      ["auto Claude agent, Claude job", autoBot.as, createBody(home)],
      [
        "workspace-write Codex agent, Claude job",
        codexBot.as,
        createBody(home),
      ],
      [
        "workspace-write Codex agent, full-access Codex job",
        codexBot.as,
        codexJob("danger-full-access"),
      ],
      ["a folder outside the agent's", bot.as, createBody(outside)],
      [
        "a link in the agent's folder that points out",
        bot.as,
        createBody(linkOut),
      ],
      ["another room", bot.as, createBody(home, { roomId: roomB })],
    ];
    for (const [label, caller, body] of refusals) {
      const res = await api(srv, "/api/cronjobs", caller, {
        method: "POST",
        body,
      });
      expect([label, ...outcome(res)]).toEqual([label, ...CAP_REFUSED]);
    }
    expect(srv.cronjobManager.listCronjobs()).toHaveLength(before);

    // Within the limits: a narrower Codex job, a folder inside the agent's,
    // and no room.
    await create(srv, codexBot.as, codexJob("read-only"));
    await create(srv, codexBot.as, codexJob("workspace-write"));
    await create(srv, bot.as, createBody(sub));
    const roomless = await create(
      srv,
      bot.as,
      createBody(home, { roomId: "" }),
    );
    expect(roomless.roomId).toBeUndefined();
  });

  it("re-checks the agent's own edits and runs against its current settings; turning the job off and deleting it stay open", async () => {
    const { srv, roomA, roomB, bot, home, outside } = await office();
    const job = await create(srv, bot.as, createBody(home));
    const patch = (body: Record<string, unknown>) =>
      api(srv, `/api/cronjobs/${job.id}`, bot.as, { method: "PATCH", body });

    // Folder and room on an edit, while the agent still has full access.
    expect(outcome(await patch({ cwd: outside }))).toEqual(CAP_REFUSED);
    expect(outcome(await patch({ roomId: roomB }))).toEqual(CAP_REFUSED);
    // The room is checked only where an edit sets it: once the agent moves
    // to room B, an edit of the job filed in room A still passes.
    expect(srv.agentManager.moveAgent(bot.info.id, roomB)).toBe(true);
    expect((await patch({ name: "after the move" })).status).toBe(200);
    expect(
      srv.cronjobManager.listCronjobs().find((c) => c.id === job.id)?.roomId,
    ).toBe(roomA);

    // A hook on the job, while the agent may still run it.
    const hook = (name: string) =>
      api(srv, "/api/webhooks", bot.as, {
        method: "POST",
        body: {
          name,
          scheme: "github-hmac-sha256",
          rules: [{ event: "pull_request" }],
          target: { kind: "cronjob", cronjobId: job.id },
        },
      });
    expect((await hook("before")).status).toBe(201);
    // And a run of it, which the agent may steer while within its limits.
    const ran = await api(srv, `/api/cronjobs/${job.id}/runs`, bot.as, {
      method: "POST",
      body: {},
    });
    expect(ran.status).toBe(200);
    const runPath = `/api/cronjobs/${job.id}/runs/${(ran.body as { runId: string }).runId}`;
    const runsBefore = runsOf(srv, job.id).length;

    // Alice lowers the agent to ask-before-acting.
    await srv.agentManager.editAgent(bot.info.id, {
      permissionMode: "default",
    });
    expect(srv.agentManager.getAgent(bot.info.id)?.permissionMode).toBe(
      "default",
    );

    expect(outcome(await patch({ prompt: "rewrite what it does" }))).toEqual(
      CAP_REFUSED,
    );
    const runNow = await api(srv, `/api/cronjobs/${job.id}/runs`, bot.as, {
      method: "POST",
      body: {},
    });
    expect(outcome(runNow)).toEqual(CAP_REFUSED);
    expect(runsOf(srv, job.id)).toHaveLength(runsBefore);
    // Steering the existing run is refused too.
    const steer = await api(srv, `${runPath}/messages`, bot.as, {
      method: "POST",
      body: { text: "now do more" },
    });
    expect(outcome(steer)).toEqual(CAP_REFUSED);
    const editSteer = await api(srv, `${runPath}/messages/entry-1`, bot.as, {
      method: "PATCH",
      body: { newText: "now do more" },
    });
    expect(outcome(editSteer)).toEqual(CAP_REFUSED);
    // The same caller set the same target before the change, so the 403
    // stands for the cap (the hook routes keep their own error codes).
    expect((await hook("after")).status).toBe(403);

    expect((await patch({ enabled: false })).status).toBe(200);
    expect(
      srv.cronjobManager.listCronjobs().find((c) => c.id === job.id)?.enabled,
    ).toBe(false);
    expect(
      (await api(srv, `/api/cronjobs/${job.id}`, bot.as, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });

  it("refuses a run start the agent's current limits do not cover, whoever starts it: mode lowered, folder swapped for a link out; a privileged or removed maker lifts it", async () => {
    const { srv, asAlice, bot, spawnAgent, home, sub, outside } =
      await office();
    const job = await create(srv, bot.as, createBody(home));
    const inSub = await create(srv, bot.as, createBody(sub, { name: "sub" }));
    const webhookRun = (jobId: string) => {
      const run = srv.cronjobManager.runCronjobFromWebhook(
        jobId,
        {
          webhookId: "hook0001",
          webhookName: "hook",
          deliveryRowId: "delivery1",
        },
        "payload",
      );
      if (!run) throw new Error("no webhook run");
      return run;
    };

    // Within the limits, a member's run starts.
    expect(refusedAtStart(await memberRun(srv, asAlice, job.id))).toEqual(
      STARTED_RUN,
    );

    // The agent's folder entry is swapped for a link out of it: the stored
    // cwd is unchanged, the folder it names is not.
    rmSync(sub, { recursive: true });
    symlinkSync(outside, sub);
    const folderRun = await memberRun(srv, asAlice, inSub.id);
    expect(refusedAtStart(folderRun)).toEqual(REFUSED_RUN);
    const folderKey = wordedRefusalKey(folderRun, bot.info.name);

    // Alice lowers the agent: a member's Run now and a webhook run of its
    // full-access job are refused at the start.
    await srv.agentManager.editAgent(bot.info.id, {
      permissionMode: "default",
    });
    const modeRun = await memberRun(srv, asAlice, job.id);
    expect(refusedAtStart(modeRun)).toEqual(REFUSED_RUN);
    // Two causes, two messages.
    expect(wordedRefusalKey(modeRun, bot.info.name)).not.toBe(folderKey);
    expect(refusedAtStart(webhookRun(job.id))).toEqual(REFUSED_RUN);

    // Made privileged, the agent's cron:manage wins and the job runs.
    await srv.agentManager.setPrivileged(bot.info.id, true);
    expect(refusedAtStart(await memberRun(srv, asAlice, job.id))).toEqual(
      STARTED_RUN,
    );
    await srv.agentManager.setPrivileged(bot.info.id, false);
    expect(refusedAtStart(await memberRun(srv, asAlice, job.id))).toEqual(
      REFUSED_RUN,
    );

    // Removed, the agent no longer limits the job: it is Alice's.
    await srv.agentManager.kill(bot.info.id);
    await sleep(0);
    expect(srv.agentManager.getAgent(bot.info.id)).toBeFalsy();
    expect(refusedAtStart(await memberRun(srv, asAlice, job.id))).toEqual(
      STARTED_RUN,
    );
    // A schedule another ordinary agent made in its own folder is unaffected
    // by Bot's settings.
    const other = await spawnAgent("Other", { cwd: outside });
    const othersJob = await create(srv, other.as, createBody(outside));
    expect(refusedAtStart(await memberRun(srv, asAlice, othersJob.id))).toEqual(
      STARTED_RUN,
    );
  });
});
