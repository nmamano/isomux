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
import { join } from "node:path";
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
  opts: { realChild?: boolean; beforeBoot?: (exportBase: string) => void } = {},
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
    startServer: {
      rescue: {
        requestStop: () => {
          stops++;
        },
        exportBaseDir: exportBase,
        ...(opts.realChild ? {} : { spawnExportChild }),
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
