// Task ab6851f2: a schedule that runs a command with no model, and messages
// its target agent only when the command prints something or fails. Through
// the real HTTP server, the real command runner (a real shell) and the real
// delivery wiring. The fire's edge cases with a stub runner are in
// cronjob-command.di.test.ts; the limits' whole table in
// server/cron-agent-limits.test.ts.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "fs";
import { basename, join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import {
  CODEX_MODELS,
  CRONJOB_COMMAND_MAX,
  cronjobRunStreamId,
  type AgentInfo,
  type CronjobListWire,
  type CronjobRun,
  type LogEntry,
} from "../../shared/types.ts";
import { formatCronjobSenderPrefix } from "../../shared/identity.ts";

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
  if ("bearer" in caller) headers["Authorization"] = `Bearer ${caller.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    ...("rawSessionId" in caller ? { rawSessionId: caller.rawSessionId } : {}),
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
const errMessageOf = (r: Res) =>
  (r.body as { error?: { message?: string } } | null)?.error?.message ?? "";
const outcome = (r: Res) => [r.status, errCode(r) ?? null];
const CAP_REFUSED = [403, "schedule_exceeds_agent"];

const NAME = "Main check";
const PROMPT = "Fix what the check found.";

// Alice reaches room A, where agent Pat sits; her agent Bot has full access
// in `home`. `work` holds folders the test makes.
async function office() {
  const srv = await startTestServer();
  server = srv;
  await srv.seedOwner("Morgan");
  const roomA = srv.agentManager.createRoom("Alpha");
  const alice = await srv.seedMember("Alice");
  const aliceId = getUserByName("Alice")!.id;
  expect(updateUserById(aliceId, { allowedRooms: [roomA] }).ok).toBe(true);
  const work = mkdtempSync(join(srv.workDir, "cron-command-"));
  const home = join(work, "home");
  const outside = join(work, "outside");
  for (const dir of [home, outside]) mkdirSync(dir);

  const pat = await srv.agentManager.spawn(
    "Pat",
    srv.workDir,
    "default",
    undefined,
    undefined,
    roomA,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!pat) throw new Error("spawn Pat returned null");

  async function spawnAgent(
    name: string,
    opts: {
      permissionMode?: AgentInfo["permissionMode"];
      agentType?: AgentInfo["agentType"];
      codexSandbox?: AgentInfo["codexSandbox"];
    } = {},
  ) {
    const info = await srv.agentManager.spawn(
      name,
      home,
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
    return { info, as: { bearer: mintAgentToken(info.id, aliceId) } };
  }

  return {
    srv,
    roomA,
    asAlice: { rawSessionId: alice.rawSessionId } as Caller,
    pat,
    spawnAgent,
    work,
    home,
    outside,
  };
}

function commandBody(
  agentId: string,
  cwd: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: NAME,
    schedule: { type: "interval", minutes: 60 },
    prompt: PROMPT,
    target: { kind: "agent", agentId },
    command: "true",
    cwd,
    ...over,
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
  expect([made.status, errMessageOf(made)]).toEqual([201, ""]);
  return made.body as CronjobListWire;
}

const stored = (srv: TestServer, id: string) =>
  srv.cronjobManager.listCronjobs().find((c) => c.id === id);
const runById = (srv: TestServer, jobId: string, runId: string) =>
  srv.cronjobManager.getRunsForCronjob(jobId).find((r) => r.id === runId);

async function runNow(
  srv: TestServer,
  caller: Caller,
  jobId: string,
): Promise<CronjobRun> {
  const res = await api(srv, `/api/cronjobs/${jobId}/runs`, caller, {
    method: "POST",
    body: {},
  });
  expect(res.status).toBe(200);
  const runId = (res.body as { runId: string }).runId;
  const deadline = Date.now() + 5000;
  while (runById(srv, jobId, runId)?.status === "running") {
    if (Date.now() > deadline) throw new Error(`run ${runId} still running`);
    await sleep(10);
  }
  const run = runById(srv, jobId, runId);
  if (!run) throw new Error(`run ${runId} not recorded`);
  return run;
}

// The texts an agent's fake session received from schedule `name`.
const scheduleMessagesTo = (srv: TestServer, agentId: string, name = NAME) =>
  srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text))
    .filter((t) => t.includes(formatCronjobSenderPrefix(name)));

async function waitForMessages(
  srv: TestServer,
  agentId: string,
  count: number,
  name = NAME,
): Promise<string[]> {
  const deadline = Date.now() + 5000;
  while (scheduleMessagesTo(srv, agentId, name).length < count) {
    if (Date.now() > deadline)
      throw new Error(
        `agent got ${scheduleMessagesTo(srv, agentId, name).length} of ${count} schedule messages`,
      );
    await sleep(10);
  }
  return scheduleMessagesTo(srv, agentId, name);
}

describe("schedules that run a command", () => {
  it("a quiet command messages nobody; one that prints or exits non-zero messages the agent; the run keeps the result and has no session", async () => {
    const { srv, asAlice, pat, work } = await office();
    const cwd = mkdtempSync(join(work, "repo-"));
    const job = await create(srv, asAlice, commandBody(pat.id, cwd));
    expect(job.command).toBe("true");
    expect(job.target).toEqual({ kind: "agent", agentId: pat.id });

    const quiet = await runNow(srv, asAlice, job.id);
    expect(quiet.status).toBe("completed");
    expect(quiet.commandSnapshot).toBe("true");
    expect(quiet.commandResult).toMatchObject({
      exitCode: 0,
      timedOut: false,
      output: "",
    });
    // A quiet run messaged nobody, and has no session either.
    const intoQuiet = await api(
      srv,
      `/api/cronjobs/${job.id}/runs/${quiet.id}/messages`,
      asAlice,
      { method: "POST", body: { text: "and one more thing" } },
    );
    expect(outcome(intoQuiet)).toEqual([409, "run_not_resumable"]);
    // Refused before any session lookup: nothing is written into the run.
    const quietRead = await api(
      srv,
      `/api/cronjobs/${job.id}/runs/${quiet.id}`,
      asAlice,
    );
    expect((quietRead.body as { entries: LogEntry[] }).entries.length).toBe(0);

    // It runs in the job's folder, through a real shell.
    const prints = `printf 'found in %s\\n' "$(basename "$PWD")"`;
    const patched = await api(srv, `/api/cronjobs/${job.id}`, asAlice, {
      method: "PATCH",
      body: { command: prints },
    });
    expect(patched.status).toBe(200);
    const loud = await runNow(srv, asAlice, job.id);
    expect(loud.status).toBe("completed");
    expect(loud.commandResult?.output.trim()).toBe(`found in ${basename(cwd)}`);
    // The quiet run sent nothing: the first schedule message is this one.
    const [first] = await waitForMessages(srv, pat.id, 1);
    expect(first).toContain(PROMPT);
    expect(first).toContain(`found in ${basename(cwd)}`);

    // A non-zero exit with no output is loud too.
    await api(srv, `/api/cronjobs/${job.id}`, asAlice, {
      method: "PATCH",
      body: { command: "exit 3" },
    });
    const failing = await runNow(srv, asAlice, job.id);
    expect(failing.status).toBe("completed");
    expect(failing.commandResult?.exitCode).toBe(3);
    const texts = await waitForMessages(srv, pat.id, 2);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("exit 3");

    // The result reads over the API; the run has no transcript, nothing can
    // be sent into it, and the job has no system prompt.
    const read = await api(
      srv,
      `/api/cronjobs/${job.id}/runs/${failing.id}`,
      asAlice,
    );
    expect(read.status).toBe(200);
    const readBody = read.body as { run: CronjobRun; entries: LogEntry[] };
    expect(readBody.run.commandResult?.exitCode).toBe(3);
    expect(readBody.entries).toEqual([]);
    const message = await api(
      srv,
      `/api/cronjobs/${job.id}/runs/${failing.id}/messages`,
      asAlice,
      { method: "POST", body: { text: "and one more thing" } },
    );
    expect(outcome(message)).toEqual([409, "run_not_resumable"]);
    const edit = await api(
      srv,
      `/api/cronjobs/${job.id}/runs/${failing.id}/messages/entry-1`,
      asAlice,
      { method: "PATCH", body: { newText: "instead" } },
    );
    expect(outcome(edit)).toEqual([409, "run_not_resumable"]);
    const systemPrompt = await api(
      srv,
      `/api/cronjobs/${job.id}/system-prompt`,
      asAlice,
    );
    expect(systemPrompt.status).toBe(409);
    expect(
      srv.fakeBackend.sessions.filter((s) =>
        [quiet.id, loud.id, failing.id]
          .map(cronjobRunStreamId)
          .includes(s.opts.agentId as string),
      ),
    ).toHaveLength(0);
  });

  it("a folder that is gone at the fire fails the run and tells the agent", async () => {
    const { srv, asAlice, pat, work } = await office();
    const cwd = mkdtempSync(join(work, "gone-"));
    const job = await create(srv, asAlice, commandBody(pat.id, cwd));
    rmSync(cwd, { recursive: true });
    const run = await runNow(srv, asAlice, job.id);
    expect(run.status).toBe("failed");
    expect(run.errorReason).toBeTruthy();
    const [text] = await waitForMessages(srv, pat.id, 1);
    expect(text).toContain("true");
  });

  it("a folder swapped into the office state at the fire fails the run, runs nothing and tells nobody", async () => {
    const { srv, asAlice, pat, work, outside } = await office();
    const link = join(work, "repo-link");
    symlinkSync(outside, link);
    const job = await create(
      srv,
      asAlice,
      commandBody(pat.id, link, { command: "echo ran >> marker" }),
    );
    expect((await runNow(srv, asAlice, job.id)).status).toBe("completed");
    expect(readFileSync(join(outside, "marker"), "utf8")).toBe("ran\n");

    const inState = mkdtempSync(join(srv.stateRoot, "cron-command-"));
    try {
      rmSync(link);
      symlinkSync(inState, link);
      const run = await runNow(srv, asAlice, job.id);
      expect(run.status).toBe("failed");
      expect(existsSync(join(inState, "marker"))).toBe(false);
      await sleep(50);
      expect(scheduleMessagesTo(srv, pat.id)).toHaveLength(0);
    } finally {
      rmSync(inState, { recursive: true, force: true });
    }
  });

  it("refuses a command with no agent target, an empty or too long command, a missing folder or one in the office state; prompt may be empty", async () => {
    const { srv, asAlice, pat, work } = await office();
    const cwd = mkdtempSync(join(work, "repo-"));
    const before = srv.cronjobManager.listCronjobs().length;
    const sessionJob = {
      name: "Session",
      schedule: { type: "interval", minutes: 60 },
      prompt: PROMPT,
      cwd,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
    };
    const { cwd: _cwd, ...noCwd } = commandBody(pat.id, cwd);
    const refusals: Array<[string, Record<string, unknown>]> = [
      ["no target", { ...sessionJob, command: "true" }],
      ["empty command", commandBody(pat.id, cwd, { command: "" })],
      ["blank command", commandBody(pat.id, cwd, { command: " \n\t" })],
      ["not a string", commandBody(pat.id, cwd, { command: 42 })],
      [
        "too long",
        commandBody(pat.id, cwd, {
          command: "x".repeat(CRONJOB_COMMAND_MAX + 1),
        }),
      ],
      ["no folder", noCwd],
    ];
    for (const [label, body] of refusals) {
      const res = await api(srv, "/api/cronjobs", asAlice, {
        method: "POST",
        body,
      });
      expect([label, res.status >= 400 && res.status < 500]).toEqual([
        label,
        true,
      ]);
      expect([label, errCode(res)]).toEqual([label, "invalid_request"]);
    }
    const inState = await api(srv, "/api/cronjobs", asAlice, {
      method: "POST",
      body: commandBody(pat.id, srv.stateRoot),
    });
    expect(outcome(inState)).toEqual([422, "folder_not_allowed"]);
    expect(srv.cronjobManager.listCronjobs()).toHaveLength(before);

    // The enabling condition: the same body with a command and no prompt.
    const noPrompt = await create(
      srv,
      asAlice,
      commandBody(pat.id, cwd, { prompt: "" }),
    );
    expect(noPrompt.command).toBe("true");
    expect(noPrompt.prompt).toBe("");
  });

  it("an edit is checked as the job it makes", async () => {
    const { srv, asAlice, pat, work } = await office();
    const cwd = mkdtempSync(join(work, "repo-"));
    const patch = (id: string, body: Record<string, unknown>) =>
      api(srv, `/api/cronjobs/${id}`, asAlice, { method: "PATCH", body });
    const isRefused = (r: Res) => r.status >= 400 && r.status < 500;

    const job = await create(
      srv,
      asAlice,
      commandBody(pat.id, cwd, { prompt: "" }),
    );
    // Back to a session job while the command stays; dropping the command
    // with no prompt left; an empty command.
    for (const [label, body] of [
      ["target null", { target: null }],
      ["command null, no prompt", { command: null }],
      ["empty command", { command: "" }],
    ] as const) {
      const res = await patch(job.id, body);
      expect([label, isRefused(res)]).toEqual([label, true]);
      expect([label, stored(srv, job.id)?.command]).toEqual([label, "true"]);
      expect([label, stored(srv, job.id)?.target?.agentId]).toEqual([
        label,
        pat.id,
      ]);
    }
    // With a prompt, dropping the command leaves a job that only messages.
    const plain = await patch(job.id, { command: null, prompt: PROMPT });
    expect(plain.status).toBe(200);
    expect(stored(srv, job.id)?.command).toBeUndefined();

    // A command on a session job: refused, as on a create.
    const session = await create(srv, asAlice, {
      name: "Session",
      schedule: { type: "interval", minutes: 60 },
      prompt: PROMPT,
      cwd,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
    });
    expect(isRefused(await patch(session.id, { command: "true" }))).toBe(true);
    expect(stored(srv, session.id)?.command).toBeUndefined();

    // A command added to a job that only messages: the folder it kept, which
    // no one checked as it was never used, is checked now.
    const gone = mkdtempSync(join(work, "gone-"));
    const messenger = await create(srv, asAlice, {
      name: "Messenger",
      schedule: { type: "interval", minutes: 60 },
      prompt: PROMPT,
      target: { kind: "agent", agentId: pat.id },
      cwd: gone,
    });
    rmSync(gone, { recursive: true });
    const added = await patch(messenger.id, { command: "true" });
    expect(outcome(added)).toEqual([400, "invalid_cwd"]);
    expect(stored(srv, messenger.id)?.command).toBeUndefined();
    const withFolder = await patch(messenger.id, { command: "true", cwd });
    expect(withFolder.status).toBe(200);
    expect(stored(srv, messenger.id)?.command).toBe("true");
  });
});

describe("command schedules an ordinary agent makes", () => {
  it("need full access and the agent's folder, whatever session fields they carry; a job that only messages needs neither", async () => {
    const { srv, spawnAgent, home, outside } = await office();
    const bot = await spawnAgent("Bot");
    const autoBot = await spawnAgent("Auto", { permissionMode: "auto" });
    const codexBot = await spawnAgent("Codex", {
      agentType: "codex",
      permissionMode: "never",
      codexSandbox: "workspace-write",
    });
    const before = srv.cronjobManager.listCronjobs().length;
    const refusals: Array<[string, Caller, Record<string, unknown>]> = [
      ["auto Claude agent", autoBot.as, commandBody(autoBot.info.id, home)],
      [
        "workspace-write Codex agent, read-only Codex fields",
        codexBot.as,
        commandBody(codexBot.info.id, home, {
          agentType: "codex",
          modelFamily: CODEX_MODELS[0]!.value,
          permissionMode: "never",
          codexSandbox: "read-only",
        }),
      ],
      [
        "a folder outside the agent's",
        bot.as,
        commandBody(bot.info.id, outside),
      ],
    ];
    for (const [label, caller, body] of refusals) {
      const res = await api(srv, "/api/cronjobs", caller, {
        method: "POST",
        body,
      });
      expect([label, ...outcome(res)]).toEqual([label, ...CAP_REFUSED]);
    }
    expect(srv.cronjobManager.listCronjobs()).toHaveLength(before);

    // Within the limits; and the same agents may still make jobs that only
    // message.
    await create(srv, bot.as, commandBody(bot.info.id, home));
    const { command: _c, ...messageOnly } = commandBody(autoBot.info.id, home);
    await create(srv, autoBot.as, messageOnly);
    const botMessenger = await create(srv, bot.as, {
      ...commandBody(bot.info.id, home),
      command: undefined,
      cwd: undefined,
    });

    // Adding a command to a job that only messages checks the folder it
    // kept: the home default is outside Bot's folder.
    const added = await api(srv, `/api/cronjobs/${botMessenger.id}`, bot.as, {
      method: "PATCH",
      body: { command: "true" },
    });
    expect(outcome(added)).toEqual(CAP_REFUSED);
    expect(stored(srv, botMessenger.id)?.command).toBeUndefined();
    const inHome = await api(srv, `/api/cronjobs/${botMessenger.id}`, bot.as, {
      method: "PATCH",
      body: { command: "true", cwd: home },
    });
    expect(inHome.status).toBe(200);
  });

  it("a run start the maker's current mode does not cover is refused: nothing runs and nobody is told", async () => {
    const { srv, asAlice, spawnAgent, home, pat } = await office();
    const bot = await spawnAgent("Bot");
    const job = await create(
      srv,
      bot.as,
      commandBody(pat.id, home, { command: "echo ran >> marker; echo loud" }),
    );
    const first = await runNow(srv, asAlice, job.id);
    expect(first.status).toBe("completed");
    await waitForMessages(srv, pat.id, 1);
    expect(readFileSync(join(home, "marker"), "utf8")).toBe("ran\n");

    await srv.agentManager.editAgent(bot.info.id, {
      permissionMode: "default",
    });
    const refused = await runNow(srv, asAlice, job.id);
    expect(refused.status).toBe("failed");
    expect(refused.errorReason).toBeTruthy();
    expect(readFileSync(join(home, "marker"), "utf8")).toBe("ran\n");
    await sleep(50);
    expect(scheduleMessagesTo(srv, pat.id)).toHaveLength(1);
  });
});
