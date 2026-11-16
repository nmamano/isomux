// The rescue kit inside the office (task cdd7883d, slice 4): the lockdown
// route and the owner export, through a real server.
//
// Who (Nil, 2026-11-06, ask 77c72505): an owner's browser session, or an
// agent whose manager is an owner by the live record. Not a member or a
// member's agent, an owner's agent with a permission pack (it may read text
// from strangers), an owner's API token, a cron run, or an app. The export's
// bytes go to an owner's browser session only.
//
// The harness never stops its own process: the lockdown's stop is a recorder.
// The export child is a fake except in one test, which runs the real one.
// server/office-lockdown-route.test.ts owns the lock steps' order and reason
// rules; server/office-export-jobs.test.ts owns the jobs' lifecycle.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_ROOT } from "../config.ts";
import { spawnSync } from "node:child_process";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import {
  LOCK_MARKER_FILE,
  LOCKED_HEADER,
  LOCKED_READY_BODY,
} from "../lockdown.ts";
import { EXPORTS_SUBDIR, type ExportChild } from "../office-export-jobs.ts";
import type { AgentInfo } from "../../shared/types.ts";
import type { MoveSeams } from "../isomux-office.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import {
  MOVE_CANCELLED_FILE,
  MOVE_STATE_FILE,
  parseMoveCode,
} from "../office-move.ts";
import { MOVE_UNITS_FILE, type AgentUnit } from "../office-move-units.ts";
import { MOVE_SCRATCH_DIR } from "../office-move-scope.ts";

let server: TestServer | null = null;
let scratch = "";
afterEach(async () => {
  await server?.stop();
  server = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

// A fake export child the test finishes by hand.
interface HeldChild {
  outFile: string;
  finish(content: string): void;
}

interface Bed {
  srv: TestServer;
  exportBase: string;
  stops: () => number;
  children: HeldChild[];
}

async function boot(
  opts: {
    realChild?: boolean;
    beforeBoot?: (exportBase: string) => void;
    move?: MoveSeams;
    fakeBackend?: FakeBackend;
  } = {},
): Promise<Bed> {
  scratch = mkdtempSync(join(tmpdir(), "office-rescue-routes-"));
  const exportBase = join(scratch, "backups");
  opts.beforeBoot?.(exportBase);
  let stops = 0;
  const children: HeldChild[] = [];
  const spawnExportChild = ({ outFile }: { outFile: string }): ExportChild => {
    let exit!: (code: number) => void;
    const done = () =>
      new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    children.push({
      outFile,
      finish(content) {
        writeFileSync(outFile, content, { mode: 0o600 });
        exit(0);
      },
    });
    return {
      exited: new Promise<number>((r) => (exit = r)),
      stdout: done(),
      stderr: done(),
      kill: () => exit(143),
    };
  };
  const srv = await startTestServer({
    ...(opts.fakeBackend ? { fakeBackend: opts.fakeBackend } : {}),
    startServer: {
      rescue: {
        requestStop: () => {
          stops++;
        },
        exportBaseDir: exportBase,
        ...(opts.realChild ? {} : { spawnExportChild }),
        ...(opts.move ? { move: opts.move } : {}),
      },
    },
  });
  server = srv;
  return { srv, exportBase, stops: () => stops, children };
}

async function spawn(
  srv: TestServer,
  name: string,
  manager: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.workDir,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    manager,
    "codex",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

type Caller = { bearer: string } | { session: string };

interface Res {
  status: number;
  body: unknown;
  headers: Headers;
  bytes: Uint8Array;
}

async function call(
  srv: TestServer,
  method: string,
  path: string,
  who: Caller,
  payload?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if ("bearer" in who) headers.Authorization = `Bearer ${who.bearer}`;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    ...("session" in who ? { rawSessionId: who.session } : {}),
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers, bytes };
}

// Status and error code, so a 403 from the guard reads apart from a 401.
const outcome = (r: Res) => ({
  status: r.status,
  code: (r.body as { error?: { code?: string } } | null)?.error?.code ?? null,
});

interface Cast {
  ownerId: string;
  owner: Caller;
  member: Caller;
  ownerAgent: Caller & { agentId: string };
  limitedOwnerAgent: Caller;
  memberAgent: Caller;
  ownerApiToken: Caller;
  cronRun: Caller;
  app: Caller;
}

// Everyone who might call the rescue routes, in one office.
async function cast(srv: TestServer): Promise<Cast> {
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Riley");
  const ownerId = getUserByName("Morgan")!.id;
  const memberId = getUserByName("Riley")!.id;

  // An app its builder (an owner's agent) registered; the app's token acts
  // for that agent. Registration rotates the builder's token, so the
  // builder's own token is minted after it.
  const builder = await spawn(srv, "Builder", "Morgan");
  const reg = await call(
    srv,
    "POST",
    "/api/apps",
    { bearer: mintAgentToken(builder.id, builder.userId) },
    { name: "rescue-app", command: "bun run serve.ts", cwd: srv.workDir },
  );
  expect(reg.status).toBe(201);
  const appToken = srv.appSupervisor.tokenFiles.get("rescue-app");
  if (!appToken) throw new Error("no app token file");

  const helper = await spawn(srv, "Helper", "Morgan");
  const reader = await spawn(srv, "Reader", "Morgan");
  const aide = await spawn(srv, "Aide", "Riley");
  const api = await mintApiToken({
    userId: ownerId,
    name: "full access",
    expiresInDays: 30,
  });
  return {
    ownerId,
    owner: { session: owner.rawSessionId },
    member: { session: member.rawSessionId },
    ownerAgent: {
      bearer: mintAgentToken(helper.id, ownerId),
      agentId: helper.id,
    },
    // Below Standard, with the fixed grant (task 82da687b): an owner's agent
    // the guard refuses for its stop.
    limitedOwnerAgent: {
      bearer: mintAgentToken(reader.id, ownerId, {
        access: "office",
        pack: { areas: { agents: "write", tasks: "write", asks: "write" } },
      }),
    },
    memberAgent: { bearer: mintAgentToken(aide.id, memberId) },
    ownerApiToken: { bearer: api.token },
    cronRun: { bearer: mintRunToken("job-1", "run-1", ownerId) },
    app: { bearer: appToken },
  };
}

const REFUSED = [
  "member",
  "memberAgent",
  "limitedOwnerAgent",
  "ownerApiToken",
  "cronRun",
  "app",
] as const;

const lockAudits = () =>
  officeAuditStore().list({ operation: "office.lockdown", limit: 10 }).items;

// A route every caller below can read while the office is open.
async function unlockedProbe(srv: TestServer, who: Caller): Promise<number> {
  return (await call(srv, "GET", "/api/tasks", who)).status;
}

describe("the lockdown route", () => {
  it("refuses a member, a member's agent, an owner's limited agent, an owner's API token, a cron run and an app with 403, and the office stays open", async () => {
    const b = await boot();
    const c = await cast(b.srv);

    const got = Object.fromEntries(
      await Promise.all(
        REFUSED.map(async (name) => [
          name,
          outcome(
            await call(b.srv, "POST", "/api/office/lockdown", c[name], {
              reason: "intrusion",
            }),
          ),
        ]),
      ),
    );
    expect(got).toEqual(
      Object.fromEntries(
        REFUSED.map((name) => [name, { status: 403, code: "forbidden" }]),
      ),
    );
    // Open: the owner and an agent still read, no marker, no row, no stop.
    expect(await unlockedProbe(b.srv, c.owner)).toBe(200);
    expect(await unlockedProbe(b.srv, c.ownerAgent)).toBe(200);
    expect(existsSync(join(b.srv.stateRoot, LOCK_MARKER_FILE))).toBe(false);
    expect(lockAudits()).toEqual([]);
    expect(b.stops()).toBe(0);
  });

  it("an owner's session locks the office: 202, the marker and one audit row with the reason, open sockets close, every later request is the locked 503, /readyz says locked, and the stop is asked once", async () => {
    const b = await boot();
    const c = await cast(b.srv);
    const ws = await b.srv.connectWs((c.owner as { session: string }).session);
    const closed = new Promise<boolean>((resolve) => {
      ws.raw.addEventListener("close", () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });

    // A missing reason is 422 and locks nothing.
    const bad = await call(b.srv, "POST", "/api/office/lockdown", c.owner, {});
    expect(bad.status).toBe(422);
    expect(await unlockedProbe(b.srv, c.owner)).toBe(200);

    const res = await call(b.srv, "POST", "/api/office/lockdown", c.owner, {
      reason: " leaked token ",
    });
    expect({ status: res.status, body: res.body }).toEqual({
      status: 202,
      body: { locked: true },
    });

    const marker = JSON.parse(
      readFileSync(join(b.srv.stateRoot, LOCK_MARKER_FILE), "utf8"),
    );
    expect(marker.reason).toBe("leaked token");
    expect(marker.by).toContain("Morgan");
    const rows = lockAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor.kind).toBe("member");
    expect(rows[0].actor.id).toBe(c.ownerId);
    expect(rows[0].lockdown).toEqual({ reason: "leaked token" });

    expect(await closed).toBe(true);
    for (const who of [c.owner, c.ownerAgent, c.ownerApiToken]) {
      const after = await call(b.srv, "GET", "/api/tasks", who);
      expect([after.status, after.headers.get(LOCKED_HEADER)]).toEqual([
        503,
        "1",
      ]);
    }
    const again = await call(b.srv, "POST", "/api/office/lockdown", c.owner, {
      reason: "twice",
    });
    expect(again.status).toBe(503);
    const ready = await b.srv.http("/readyz");
    expect([ready.status, await ready.text()]).toEqual([
      200,
      LOCKED_READY_BODY,
    ]);
    // A new WebSocket does not open.
    await expect(
      b.srv.connectWs((c.owner as { session: string }).session),
    ).rejects.toThrow();

    const deadline = performance.now() + 2_000;
    while (b.stops() < 1 && performance.now() < deadline) await Bun.sleep(10);
    expect(b.stops()).toBe(1);
  });

  it("an owner's agent locks the office; the marker names the agent and its manager, and the audit row names the agent", async () => {
    const b = await boot();
    const c = await cast(b.srv);

    const res = await call(
      b.srv,
      "POST",
      "/api/office/lockdown",
      c.ownerAgent,
      {
        reason: "prompt injection in a task",
      },
    );
    expect(res.status).toBe(202);

    const marker = JSON.parse(
      readFileSync(join(b.srv.stateRoot, LOCK_MARKER_FILE), "utf8"),
    );
    expect(marker.by).toContain("Helper");
    expect(marker.by).toContain("Morgan");
    const rows = lockAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor.kind).toBe("agent");
    expect(rows[0].actor.id).toBe(c.ownerAgent.agentId);
    expect(rows[0].lockdown).toEqual({ reason: "prompt injection in a task" });
    expect((await call(b.srv, "GET", "/api/tasks", c.owner)).status).toBe(503);
  });
});

describe("the owner export routes", () => {
  it("are refused to the same callers as the lockdown, and follow the manager's live role: the same agent token gets 202 once its member is an owner", async () => {
    const b = await boot();
    const c = await cast(b.srv);

    for (const name of REFUSED)
      expect({
        name,
        ...outcome(await call(b.srv, "POST", "/api/office/exports", c[name])),
      }).toEqual({ name, status: 403, code: "forbidden" });
    expect(b.children).toHaveLength(0);

    updateUserById(getUserByName("Riley")!.id, { role: "owner" });
    const promoted = await call(
      b.srv,
      "POST",
      "/api/office/exports",
      c.memberAgent,
    );
    expect(promoted.status).toBe(202);
    expect(b.children).toHaveLength(1);
  });

  it("an owner's agent starts an export and reads its status but cannot download it; the owner's session downloads it; a second start while one runs is 409; an unknown id is 404", async () => {
    const b = await boot();
    const c = await cast(b.srv);

    const started = await call(
      b.srv,
      "POST",
      "/api/office/exports",
      c.ownerAgent,
    );
    expect(started.status).toBe(202);
    const id = (started.body as { id: string }).id;
    expect(typeof id).toBe("string");
    const busy = await call(b.srv, "POST", "/api/office/exports", c.owner);
    expect(busy.status).toBe(409);
    const running = await call(
      b.srv,
      "GET",
      `/api/office/exports/${id}`,
      c.ownerAgent,
    );
    expect([running.status, (running.body as { state: string }).state]).toEqual(
      [200, "running"],
    );

    b.children[0].finish("the office, packed");
    let state = "running";
    const deadline = performance.now() + 2_000;
    while (state === "running" && performance.now() < deadline) {
      await Bun.sleep(10);
      const s = await call(b.srv, "GET", `/api/office/exports/${id}`, c.owner);
      state = (s.body as { state: string }).state;
    }
    expect(state).toBe("ready");

    const refused = await call(
      b.srv,
      "GET",
      `/api/office/exports/${id}/download`,
      c.ownerAgent,
    );
    expect(outcome(refused)).toEqual({ status: 403, code: "forbidden" });
    expect(new TextDecoder().decode(refused.bytes)).not.toContain(
      "the office, packed",
    );

    const download = await call(
      b.srv,
      "GET",
      `/api/office/exports/${id}/download`,
      c.owner,
    );
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(download.bytes)).toBe("the office, packed");
    expect(download.headers.get("content-disposition") ?? "").toMatch(
      /^attachment/,
    );
    expect(download.headers.get("cache-control") ?? "").toContain("no-store");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    // Several downloads in its hour: a broken one can retry.
    const retry = await call(
      b.srv,
      "GET",
      `/api/office/exports/${id}/download`,
      c.owner,
    );
    expect(retry.status).toBe(200);

    for (const path of [
      "/api/office/exports/no-such-export",
      "/api/office/exports/no-such-export/download",
    ])
      expect((await call(b.srv, "GET", path, c.owner)).status).toBe(404);
  });

  it("the boot deletes what an earlier run left in exports/", async () => {
    let stray = "";
    await boot({
      beforeBoot: (exportBase) => {
        const exportsDir = join(exportBase, EXPORTS_SUBDIR);
        mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
        stray = join(exportsDir, "left-by-a-crash.tar.gz");
        writeFileSync(stray, "old office");
      },
    });
    expect(stray).not.toBe("");
    expect(existsSync(stray)).toBe(false);
  });

  it("a harness boot without the rescue seams never sweeps the host's backup folder, even when ISOMUX_BACKUP_DIR names it", async () => {
    // An agent shell inherits the office's environment: a test run there
    // must not delete the live office's export.
    scratch = mkdtempSync(join(tmpdir(), "office-rescue-routes-"));
    const hostExports = join(scratch, "host-backups", EXPORTS_SUBDIR);
    mkdirSync(hostExports, { recursive: true, mode: 0o700 });
    const live = join(hostExports, "live-export.tar.gz");
    writeFileSync(live, "the live office, packed");
    const saved = process.env.ISOMUX_BACKUP_DIR;
    process.env.ISOMUX_BACKUP_DIR = join(scratch, "host-backups");
    try {
      server = await startTestServer();
    } finally {
      if (saved === undefined) delete process.env.ISOMUX_BACKUP_DIR;
      else process.env.ISOMUX_BACKUP_DIR = saved;
    }
    expect(existsSync(live)).toBe(true);
  });

  it("the real child exports the running office: the downloaded archive holds a task made through the API a moment before", async () => {
    const b = await boot({ realChild: true });
    const owner = await b.srv.seedOwner("Morgan");
    const who = { session: owner.rawSessionId };
    const task = await call(b.srv, "POST", "/api/tasks", who, {
      title: "rescue-export-live-task",
    });
    expect(task.status).toBeLessThan(300);

    const started = await call(b.srv, "POST", "/api/office/exports", who);
    expect(started.status).toBe(202);
    const id = (started.body as { id: string }).id;
    let status: { state: string; error?: string } = { state: "running" };
    const deadline = performance.now() + 20_000;
    while (status.state === "running" && performance.now() < deadline) {
      await Bun.sleep(100);
      status = (await call(b.srv, "GET", `/api/office/exports/${id}`, who))
        .body as { state: string; error?: string };
    }
    expect(status).toMatchObject({ state: "ready" });

    const download = await call(
      b.srv,
      "GET",
      `/api/office/exports/${id}/download`,
      who,
    );
    expect(download.status).toBe(200);
    const archive = join(scratch, "download.tar.gz");
    writeFileSync(archive, download.bytes);
    const text = spawnSync("tar", ["-xzOf", archive], { encoding: "utf8" });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("rescue-export-live-task");
  }, 40_000);
});

// Moving the office (task 78733adf, slice 1). The owner's routes follow the
// rescue kit's callers, except the mint: only an owner's browser session gets
// the code, like the export's bytes. The new box's routes (/api/move/*) are
// public, before the auth wall: server/office-move-routes.test.ts owns their
// rules; here they run once through the whole server, for the wiring.
describe("the move routes", () => {
  // The office runs as a user unit with Restart=always, has no agent-made
  // units, and its preflight steps answer at once.
  function moveSeams(): MoveSeams & {
    calls: string[][];
    stops: AgentUnit[][];
  } {
    const calls: string[][] = [];
    const stops: AgentUnit[][] = [];
    return {
      calls,
      stops,
      // The redeem checks the state root on disk inside the office user's
      // home (slice 2b): this office's home is the folder that holds it.
      home: dirname(STATE_ROOT),
      runUnits: (argv) => {
        calls.push(argv);
        if (argv.includes("show") && argv.some((a) => a.includes("Restart")))
          return {
            code: 0,
            stdout: argv.includes("--value") ? "always\n" : "Restart=always\n",
            stderr: "",
          };
        return { code: 0, stdout: "", stderr: "" };
      },
      exec: async () => ({ code: 0, stdout: "0\t.\n", timedOut: false }),
      requestStop: (units) => {
        stops.push(units);
      },
      cgroupText:
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/isomux.service\n",
      aptHistoryPath: "/nonexistent/apt-history.log",
    };
  }

  // The new box's side, as plain HTTP with no cookie: the public routes.
  async function moveCall(
    srv: TestServer,
    method: string,
    path: string,
    opts: { session?: string; body?: unknown } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = {};
    if (opts.session) headers.Authorization = `Bearer ${opts.session}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await srv.http(path, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let body: unknown = null;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = null;
    }
    return { status: res.status, body, headers: res.headers, bytes };
  }

  const moveAudits = () =>
    [
      "office.mintMoveCode",
      "office.pairMove",
      "office.lockForMove",
      "office.cancelMove",
    ].flatMap((operation) =>
      officeAuditStore()
        .list({ operation, limit: 10 })
        .items.map(() => operation),
    );

  it("only an owner's browser session mints the code: every other caller, an owner's agent included, gets 403 and nothing is written", async () => {
    const b = await boot({ move: moveSeams() });
    const c = await cast(b.srv);
    for (const name of [...REFUSED, "ownerAgent"] as const)
      expect({
        name,
        ...outcome(await call(b.srv, "POST", "/api/office/move/code", c[name])),
      }).toEqual({ name, status: 403, code: "forbidden" });
    expect(existsSync(join(b.srv.stateRoot, MOVE_STATE_FILE))).toBe(false);

    const minted = await call(b.srv, "POST", "/api/office/move/code", c.owner);
    expect(minted.status).toBe(200);
    const body = minted.body as {
      code: string;
      origin: string;
      expiresAt: number;
      loopbackOrigin: boolean;
    };
    expect(parseMoveCode(body.code)?.origin).toBe(body.origin);
    // The harness answers on loopback: a new box could not reach it.
    expect(body.loopbackOrigin).toBe(true);
    expect(moveAudits()).toEqual(["office.mintMoveCode"]);
  });

  it("owners and their agents read and cancel the move; the read never shows the code, its key or a hash; the rescue kit's refused callers get 403", async () => {
    const b = await boot({ move: moveSeams() });
    const c = await cast(b.srv);
    const minted = (await call(b.srv, "POST", "/api/office/move/code", c.owner))
      .body as { code: string };
    const parts = parseMoveCode(minted.code)!;

    for (const name of REFUSED)
      for (const method of ["GET", "DELETE"])
        expect({
          name,
          method,
          ...outcome(await call(b.srv, method, "/api/office/move", c[name])),
        }).toEqual({ name, method, status: 403, code: "forbidden" });

    const read = await call(b.srv, "GET", "/api/office/move", c.ownerAgent);
    expect(read.status).toBe(200);
    expect((read.body as { state: string }).state).toBe("code");
    const text = JSON.stringify(read.body);
    for (const secret of [minted.code, parts.token, parts.key])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/tokenHash|sessionHash|"key"/);

    const cancelled = await call(
      b.srv,
      "DELETE",
      "/api/office/move",
      c.ownerAgent,
    );
    expect([cancelled.status, cancelled.body]).toEqual([
      200,
      { cancelled: true },
    ]);
    expect(
      (
        (await call(b.srv, "GET", "/api/office/move", c.owner)).body as {
          state: string;
        }
      ).state,
    ).toBe("none");
  });

  it("the new box pairs, runs the preflight and locks over the public routes with no sign-in; the office locks without quarantining a sign-in, and the stop gets the units", async () => {
    const seams = moveSeams();
    const b = await boot({ move: seams });
    const c = await cast(b.srv);
    const minted = (await call(b.srv, "POST", "/api/office/move/code", c.owner))
      .body as { code: string };
    expect((await moveCall(b.srv, "GET", "/api/move/status")).status).toBe(401);

    // The new box tells its own home path; the redeem refuses another one, so
    // learn this office's from the refusal first.
    const probe = await moveCall(b.srv, "POST", "/api/move/redeem", {
      body: {
        token: parseMoveCode(minted.code)!.token,
        newBox: { release: null, commit: null, homePath: "/nowhere" },
      },
    });
    expect(probe.status).toBe(409);
    const ours = (
      probe.body as {
        ours: {
          release: string | null;
          commit: string | null;
          homePath: string;
        };
      }
    ).ours;
    const paired = await moveCall(b.srv, "POST", "/api/move/redeem", {
      body: { token: parseMoveCode(minted.code)!.token, newBox: ours },
    });
    expect(paired.status).toBe(200);
    const session = (paired.body as { session: string }).session;

    const started = await moveCall(b.srv, "POST", "/api/move/preflight", {
      session,
    });
    expect(started.status).toBe(202);
    const id = (started.body as { id: string }).id;
    let state = "running";
    const deadline = performance.now() + 5_000;
    while (state === "running" && performance.now() < deadline) {
      await Bun.sleep(10);
      state = (
        (await moveCall(b.srv, "GET", `/api/move/preflight/${id}`, { session }))
          .body as { state: string }
      ).state;
    }
    expect(state).toBe("ready");

    const locked = await moveCall(b.srv, "POST", "/api/move/lock", {
      session,
      body: { preflightId: id },
    });
    expect(locked.status).toBe(202);
    // The process is locked at once, for the owner too.
    const after = await call(b.srv, "GET", "/api/tasks", c.owner);
    expect([after.status, after.headers.get(LOCKED_HEADER)]).toEqual([
      503,
      "1",
    ]);
    const stopDeadline = performance.now() + 2_000;
    while (seams.stops.length === 0 && performance.now() < stopDeadline)
      await Bun.sleep(10);
    expect(seams.stops).toEqual([[]]);
    // Nothing quarantined, no lock marker: the sign-ins move with the office.
    expect(existsSync(join(b.srv.stateRoot, "sessions.json"))).toBe(true);
    expect(existsSync(join(b.srv.stateRoot, LOCK_MARKER_FILE))).toBe(false);
    expect(moveAudits()).toEqual([
      "office.mintMoveCode",
      "office.pairMove",
      "office.lockForMove",
    ]);
  });

  it("the preflight shows the agents whose turn runs, and the lock refuses when another agent starts one (SRE item 9)", async () => {
    // A turn that never ends by itself.
    const parking = new FakeBackend({
      session: {
        onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      },
    });
    const b = await boot({ move: moveSeams(), fakeBackend: parking });
    const c = await cast(b.srv);
    const worker = await spawn(b.srv, "Mapper", "Morgan");
    const late = await spawn(b.srv, "Gateway", "Morgan");
    const startTurn = async (id: string) => {
      const r = await call(
        b.srv,
        "POST",
        `/api/agents/${id}/messages`,
        { bearer: getAgentTokenRaw(c.ownerAgent.agentId)! },
        { text: "work" },
      );
      expect(r.status).toBe(200);
      const deadline = performance.now() + 3_000;
      while (
        b.srv.agentManager.getAllAgents().find((a) => a.id === id)?.state !==
          "thinking" &&
        performance.now() < deadline
      )
        await Bun.sleep(10);
      expect(
        b.srv.agentManager.getAllAgents().find((a) => a.id === id)?.state,
      ).toBe("thinking");
    };
    await startTurn(worker.id);

    const minted = (await call(b.srv, "POST", "/api/office/move/code", c.owner))
      .body as { code: string };
    const token = parseMoveCode(minted.code)!.token;
    const probe = await moveCall(b.srv, "POST", "/api/move/redeem", {
      body: {
        token,
        newBox: { release: null, commit: null, homePath: "/nowhere" },
      },
    });
    const ours = (probe.body as { ours: unknown }).ours;
    const session = (
      (
        await moveCall(b.srv, "POST", "/api/move/redeem", {
          body: { token, newBox: ours },
        })
      ).body as { session: string }
    ).session;
    const id = (
      (await moveCall(b.srv, "POST", "/api/move/preflight", { session }))
        .body as { id: string }
    ).id;
    let status: {
      state: string;
      result?: { turnsInFlight: { agentId: string }[] };
    } = {
      state: "running",
    };
    const deadline = performance.now() + 5_000;
    while (status.state === "running" && performance.now() < deadline) {
      await Bun.sleep(10);
      status = (
        await moveCall(b.srv, "GET", `/api/move/preflight/${id}`, { session })
      ).body as typeof status;
    }
    expect(status.result?.turnsInFlight.map((t) => t.agentId)).toEqual([
      worker.id,
    ]);

    await startTurn(late.id);
    const locked = await moveCall(b.srv, "POST", "/api/move/lock", {
      session,
      body: { preflightId: id },
    });
    expect(outcome(locked)).toEqual({ status: 409, code: "turns_changed" });
    expect(JSON.stringify(locked.body)).toContain(late.id);
    expect((await call(b.srv, "GET", "/api/tasks", c.owner)).status).toBe(200);
  });

  // Slice 4: the running office serves the live pass to the paired box,
  // and [R] C3 an owner's cancel or a lockdown ends it: the scratch, which
  // lists every path, is deleted.
  async function livePull(
    b: { srv: TestServer },
    c: Awaited<ReturnType<typeof cast>>,
  ) {
    const minted = (await call(b.srv, "POST", "/api/office/move/code", c.owner))
      .body as { code: string };
    const token = parseMoveCode(minted.code)!.token;
    const probe = await moveCall(b.srv, "POST", "/api/move/redeem", {
      body: {
        token,
        newBox: { release: null, commit: null, homePath: "/nowhere" },
      },
    });
    const ours = (probe.body as { ours: unknown }).ours;
    const session = (
      (
        await moveCall(b.srv, "POST", "/api/move/redeem", {
          body: { token, newBox: ours },
        })
      ).body as { session: string }
    ).session;
    const note = join(dirname(STATE_ROOT), "live-note.txt");
    writeFileSync(note, "live");
    const started = await moveCall(b.srv, "POST", "/api/move/manifest", {
      session,
    });
    expect(started.status).toBe(202);
    const id = (started.body as { id: string }).id;
    let state = "running";
    const deadline = performance.now() + 10_000;
    while (state === "running" && performance.now() < deadline) {
      await Bun.sleep(10);
      state = (
        (
          await moveCall(
            b.srv,
            "GET",
            `/api/move/manifest/${encodeURIComponent(id)}`,
            { session },
          )
        ).body as { state: string }
      ).state;
    }
    expect(state).toBe("ready");
    const batch = await moveCall(b.srv, "POST", "/api/move/batch", {
      session,
      body: { manifestId: id, batch: 0, items: [{ path: "live-note.txt" }] },
    });
    expect(batch.status).toBe(200);
    expect(existsSync(join(b.srv.stateRoot, MOVE_SCRATCH_DIR))).toBe(true);
    return { session, note };
  }

  it("slice 4: while paired, the running office serves the manifest and a batch; the owner's read shows servedAt; one audit row; the owner's cancel deletes the scratch", async () => {
    const b = await boot({ move: moveSeams() });
    const c = await cast(b.srv);
    const { note } = await livePull(b, c);
    try {
      const read = await call(b.srv, "GET", "/api/office/move", c.owner);
      expect(typeof (read.body as { servedAt?: unknown }).servedAt).toBe(
        "number",
      );
      expect(
        officeAuditStore().list({ operation: "office.movePulled", limit: 10 })
          .items,
      ).toHaveLength(1);
      expect(
        (await call(b.srv, "DELETE", "/api/office/move", c.owner)).status,
      ).toBe(200);
      expect(existsSync(join(b.srv.stateRoot, MOVE_SCRATCH_DIR))).toBe(false);
    } finally {
      rmSync(note, { force: true });
    }
  });

  it("slice 4: a lockdown while paired deletes the move scratch", async () => {
    const b = await boot({ move: moveSeams() });
    const c = await cast(b.srv);
    const { note } = await livePull(b, c);
    try {
      const res = await call(b.srv, "POST", "/api/office/lockdown", c.owner, {
        reason: "test",
      });
      expect(res.status).toBe(202);
      const deadline = performance.now() + 3_000;
      while (
        existsSync(join(b.srv.stateRoot, MOVE_SCRATCH_DIR)) &&
        performance.now() < deadline
      )
        await Bun.sleep(10);
      expect(existsSync(join(b.srv.stateRoot, MOVE_SCRATCH_DIR))).toBe(false);
    } finally {
      rmSync(note, { force: true });
    }
  });

  it("the owner's cancel ends the pairing: the new box's session stops working", async () => {
    const b = await boot({ move: moveSeams() });
    const c = await cast(b.srv);
    const minted = (await call(b.srv, "POST", "/api/office/move/code", c.owner))
      .body as { code: string };
    const probe = await moveCall(b.srv, "POST", "/api/move/redeem", {
      body: {
        token: parseMoveCode(minted.code)!.token,
        newBox: { release: null, commit: null, homePath: "/nowhere" },
      },
    });
    const ours = (probe.body as { ours: unknown }).ours;
    const session = (
      (
        await moveCall(b.srv, "POST", "/api/move/redeem", {
          body: { token: parseMoveCode(minted.code)!.token, newBox: ours },
        })
      ).body as { session: string }
    ).session;
    expect(
      (await moveCall(b.srv, "GET", "/api/move/status", { session })).status,
    ).toBe(200);

    expect(
      (await call(b.srv, "DELETE", "/api/office/move", c.owner)).status,
    ).toBe(200);
    expect(
      (await moveCall(b.srv, "GET", "/api/move/status", { session })).status,
    ).toBe(401);
    expect(moveAudits()).toContain("office.cancelMove");
  });

  it("the first normal boot after a cancel by code puts the units back, drops the records and audits the cancel", async () => {
    const seams = moveSeams();
    const b = await boot({ move: seams });
    await b.srv.seedOwner("Morgan");
    const units: AgentUnit[] = [
      {
        name: "tailscaled.service",
        fragmentPath: "/home/isomux/.config/systemd/user/tailscaled.service",
        unitFileState: "enabled",
        activeState: "active",
        transient: false,
      },
    ];
    // What the MOVE-locked server's cancel leaves.
    writeFileSync(
      join(b.srv.stateRoot, MOVE_UNITS_FILE),
      JSON.stringify(units),
    );
    writeFileSync(
      join(b.srv.stateRoot, MOVE_CANCELLED_FILE),
      JSON.stringify({ at: new Date().toISOString() }),
    );
    seams.calls.length = 0;
    server = await b.srv.restart();

    const touched = seams.calls.filter((a) => a.includes("tailscaled.service"));
    expect(touched.some((a) => a.includes("enable"))).toBe(true);
    expect(
      touched.some(
        (a) =>
          a.includes("start") || (a.includes("enable") && a.includes("--now")),
      ),
    ).toBe(true);
    expect(existsSync(join(server.stateRoot, MOVE_UNITS_FILE))).toBe(false);
    expect(existsSync(join(server.stateRoot, MOVE_CANCELLED_FILE))).toBe(false);
    expect(moveAudits()).toEqual(["office.cancelMove"]);
  });

  // Slice 2b, the new office's side, through the whole server: only an
  // owner's browser session starts a move-in, and the office's real
  // freshness read (users, agents, apps, tasks) refuses this office, which
  // has members, agents and an app, before any request to the old office.
  it("a move-in: only an owner's session starts it; an office with members, agents and apps gets 409 office_not_fresh and the old office is never called", async () => {
    const fetched: string[] = [];
    const seams = {
      ...moveSeams(),
      moveIn: {
        fetch: async (url: string) => {
          fetched.push(url);
          return Response.json(
            { error: { code: "move_code_invalid", message: "x" } },
            { status: 403 },
          );
        },
      },
    };
    const b = await boot({ move: seams });
    const c = await cast(b.srv);
    const code = `isomux-move-1.${Buffer.from(
      JSON.stringify({
        o: "https://old.example.com",
        t: "t".repeat(43),
        k: "k".repeat(43),
      }),
    ).toString("base64url")}`;
    for (const name of [...REFUSED, "ownerAgent"] as const)
      expect({
        name,
        ...outcome(
          await call(b.srv, "POST", "/api/office/move-in", c[name], { code }),
        ),
      }).toEqual({ name, status: 403, code: "forbidden" });

    const res = await call(b.srv, "POST", "/api/office/move-in", c.owner, {
      code,
    });
    expect(outcome(res)).toEqual({ status: 409, code: "office_not_fresh" });
    const reasons = (res.body as { error?: { reasons?: { kind: string }[] } })
      .error?.reasons;
    expect(reasons?.map((r) => r.kind).sort()).toEqual([
      "agents",
      "apps",
      "users",
    ]);
    expect(fetched).toEqual([]);

    const read = await call(b.srv, "GET", "/api/office/move-in", c.ownerAgent);
    expect({
      status: read.status,
      phase: (read.body as { phase?: string }).phase,
    }).toEqual({
      status: 200,
      phase: "none",
    });
  });
});
