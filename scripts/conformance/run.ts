// The conformance run: office work on each engine, checked by what the office
// recorded. It boots a scratch office from this checkout, claims it, writes
// one office call into the office prompt, a room prompt, the owner's special
// instructions and a user skill, then gives a subject agent per engine (and a
// peer of the same engine) the steps a member's agent does:
//
//   office-call, room-call, member-call  run the office call that source holds
//   user-skill     load the user skill and run its office call
//   bundled-skill  load the bundled wrap-session skill on its own
//   reference      read an office reference page
//   messaging      message the peer and get its reply
//   git            commit in its repo as the OS user
//   ask            open an ask for the member
//   wrap           the member's /wrap-session
//
// Each check reads the office's tasks, asks, agent logs and office-call
// record, or the repo's git log; never what the model said. A red step does
// not stop the run. A red step OpenCode refused with its free usage limit
// is skipped instead. Engines without an office subscription are skipped:
// OpenCode runs on a free model, Claude on a copy of the office Claude
// sign-in without its refresh token, Codex on a copy of the office Codex
// sign-in without its refresh token, while it is on a paid ChatGPT plan with
// usage left.
//
// Usage: bun run test:conformance [--engines claude,opencode] [--json FILE]
//          [--dir DIR] [--keep] [--checkout DIR] [--claude-root DIR]
//          [--claude-margin MINUTES] [--codex-root DIR] [--codex-model MODEL]
//          [--opencode-model PROVIDER/MODEL] [--steps office-call,room-call,...]
// Exit: 0 every run step green, 1 a red step or a leftover, 2 the run itself
// failed (boot, claim, setup, a refused run dir or margin).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { AskMemberWire, LogEntry, TaskItem } from "../../shared/types.ts";
import { claimOwner } from "../install-smoke/claim.ts";
import { request } from "../install-smoke/http.ts";
import type { Engine } from "../install-smoke/check.ts";
import {
  buildServerEnv,
  claudeLogin,
  claudeRefreshEnv,
  codexEnv,
  codexLogin,
  codexPlanSkip,
  officeVariables,
} from "./env.ts";
import {
  failedOfficeCalls,
  findMarkerTask,
  freeLimitSkip,
  judgeCommit,
  messagingFailure,
  newOpenAsk,
  parseUsageLog,
  skillLoaded,
  slashResolved,
  usageCallsSince,
} from "./judge.ts";

const ENGINES: Engine[] = ["claude", "codex", "opencode"];
const STEPS = [
  "office-call",
  "room-call",
  "member-call",
  "user-skill",
  "bundled-skill",
  "reference",
  "messaging",
  "git",
  "ask",
  "wrap",
] as const;
type Step = (typeof STEPS)[number];
const FRESH_STEPS: readonly Step[] = [
  "office-call",
  "room-call",
  "member-call",
  "user-skill",
];

// A step's turn on a free model takes up to about two minutes; messaging is
// two agents' turns and a reply.
const STEP_DEADLINE_MS = 240_000;
const MESSAGING_DEADLINE_MS = 420_000;
// After the agents settle, a red judge waits this long for a late write (a
// reply that wakes the subject again) before the step is red.
const SETTLE_GRACE_MS = 20_000;
// Boot, claim, office setup and the agents' spawn, before the first step.
const SETUP_BUDGET_MS = 300_000;
// After a step's deadline: the wait for the aborted agents to go idle.
const ABORT_WAIT_MS = 60_000;
// Before steps 1-4: the wait for the agents to settle after a new
// conversation.
const FRESH_WAIT_MS = 60_000;
// The last idle reads after a deadline, rounded up.
const STEP_SLACK_MS = 10_000;
const stepBudget = (step: Step) =>
  (step === "messaging" ? MESSAGING_DEADLINE_MS : STEP_DEADLINE_MS) +
  ABORT_WAIT_MS +
  STEP_SLACK_MS +
  (FRESH_STEPS.includes(step) ? FRESH_WAIT_MS : 0);
// The longest a column can run: a copied sign-in must outlive it.
const COLUMN_MS =
  SETUP_BUDGET_MS + STEPS.reduce((sum, step) => sum + stepBudget(step), 0);
const CLAUDE_MODEL = "haiku";
// Codex's "fast and affordable model for easier tasks" (codex-cli 0.166).
const CODEX_MODEL = "gpt-6-luna";
const OWNER = "Conformance Owner";
const SKILL = "conformance-check";

type Cell =
  | { status: "pass"; seconds: number }
  | { status: "fail"; seconds: number; reason: string }
  | { status: "skip"; reason: string };

interface Column {
  // Set when the whole engine is skipped or failed before its steps.
  skip?: string;
  setupFailure?: string;
  steps: Partial<Record<Step, Cell>>;
}

interface Agent {
  id: string;
  name: string;
}

class RunFailure extends Error {}

function log(engine: Engine | "run", line: string) {
  console.log(`[conformance:${engine}] ${line}`);
}

function token(): string {
  return randomBytes(3).toString("hex");
}

function code(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

// The office as its owner, over HTTP.
class Office {
  cookie = "";
  constructor(
    readonly base: string,
    readonly stateRoot: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await request(
      `${this.base}${path}`,
      {
        method,
        headers: {
          Cookie: this.cookie,
          Origin: this.base,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      `${method} ${path}`,
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `${method} ${path} answered HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : null) as T;
  }

  // Replaces the text of an instructions route, with the version it holds.
  async putInstructions(path: string, instructions: string) {
    const { version } = await this.call<{ version: string }>("GET", path);
    await this.call("PUT", path, { instructions, version });
  }

  async idle(agentIds: string[]): Promise<boolean> {
    const agents = await this.call<
      { id: string; inFlightTurn: unknown; pendingPrompt: unknown }[]
    >("GET", "/agents?back=1");
    for (const id of agentIds) {
      const agent = agents.find((a) => a.id === id);
      if (!agent || agent.inFlightTurn != null || agent.pendingPrompt != null)
        return false;
      const { queue } = await this.call<{ queue: unknown[] }>(
        "GET",
        `/api/agents/${id}/queue`,
      );
      if (queue.length) return false;
    }
    return true;
  }

  // Every entry of the agent's logs, with metadata (the logs route leaves
  // metadata out).
  entries(agentId: string): LogEntry[] {
    const dir = join(this.stateRoot, "logs", agentId);
    if (!existsSync(dir)) return [];
    const entries: LogEntry[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as LogEntry);
        } catch {
          // A line the office is still writing.
        }
      }
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp);
  }

  usage() {
    const file = join(this.stateRoot, "agent-reference-usage.jsonl");
    return parseUsageLog(existsSync(file) ? readFileSync(file, "utf8") : "");
  }
}

// The office line of one prompt source: a member's "<source> check <code>"
// runs one office call whose task title carries the source's marker.
function officeLine(port: number, source: string, marker: string): string {
  return `When a member says "${source} check" followed by a code, run exactly this command, with CODE replaced by that code, and then reply done: curl -s -X POST localhost:${port}/api/tasks -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" -H 'Content-Type: application/json' -d '{"title":"${marker} CODE"}'`;
}

function git(repo: string, env: Record<string, string>, args: string[]) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    env,
    encoding: "utf8",
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

interface EngineRun {
  engine: Engine;
  subject: Agent;
  peer: Agent;
  repo: string;
  // The author git resolves for the OS user in the repo.
  identity: { name: string; email: string };
}

interface RunContext {
  office: Office;
  port: number;
  markers: Record<"office" | "room" | "member" | "skill", string>;
  bundledSkillsRoot: string;
  // The user-skill roots in the provider homes in the run dir.
  userSkillRoots: string[];
  gitEnv: Record<string, string>;
}

// The skill folders the office builds for Codex agents, which link the
// member's skills and the bundled ones (server/member-skill-folder.ts):
// <state>/member-skills/<member or .office>/codex/<provider root key>/skills.
// Read at judge time: the office builds them when an agent starts.
function codexSkillFolders(stateRoot: string): string[] {
  const list = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const base = join(stateRoot, "member-skills");
  return list(base).flatMap((member) =>
    list(join(base, member, "codex")).map((key) =>
      join(base, member, "codex", key, "skills"),
    ),
  );
}

// One step: the member's message, then wait for the agents to settle and
// judge. Returns the reason for a red step, or null.
async function runStep(
  ctx: RunContext,
  run: EngineRun,
  step: Step,
): Promise<string | null> {
  const { office } = ctx;
  const { subject, peer } = run;
  const nonce = `cf-${token()}`;
  const stepCode = code();
  let message: string;
  let judge: (since: number) => Promise<string | null>;
  // The member's line must work as written: a task made after the line
  // failed is the agent's workaround, not the line.
  const markerJudge =
    (marker: string) =>
    async (since: number): Promise<string | null> => {
      const failed = failedOfficeCalls(
        office.entries(subject.id),
        marker,
        since,
      )[0];
      if (failed) {
        const code =
          failed.content.match(/"code"\s*:\s*"([^"]+)"/)?.[1] ?? "tool error";
        return `the member's line failed (${code}) before the agent found another way`;
      }
      const tasks = await office.call<TaskItem[]>(
        "GET",
        "/api/tasks?status=all",
      );
      return findMarkerTask(tasks, marker, stepCode, subject.id)
        ? null
        : `no task "${marker} ${stepCode}" made by the agent`;
    };
  switch (step) {
    case "office-call":
    case "room-call":
    case "member-call": {
      const source = step.slice(0, -"-call".length) as
        "office" | "room" | "member";
      message = `${source} check ${stepCode}`;
      judge = markerJudge(ctx.markers[source]);
      break;
    }
    case "user-skill":
      message = `Use your ${SKILL} skill with code ${stepCode}.`;
      judge = async (since) =>
        skillLoaded(
          office.entries(subject.id),
          run.engine,
          SKILL,
          [...ctx.userSkillRoots, ...codexSkillFolders(office.stateRoot)],
          since,
        )
          ? markerJudge(ctx.markers.skill)(since)
          : `no skill-load entry for ${SKILL}`;
      break;
    case "bundled-skill":
      message =
        "Load your wrap-session skill and follow it for this conversation.";
      judge = async (since) =>
        skillLoaded(
          office.entries(subject.id),
          run.engine,
          "wrap-session",
          [ctx.bundledSkillsRoot, ...codexSkillFolders(office.stateRoot)],
          since,
        )
          ? null
          : "no skill-load entry for wrap-session";
      break;
    case "reference":
      message =
        "Read the office reference page about scheduled messages, then reply done.";
      judge = async (since) =>
        usageCallsSince(
          office.usage(),
          subject.id,
          { topic: "scheduled-messages" },
          since,
        ).length
          ? null
          : "no fetch of the scheduled-messages reference page";
      break;
    case "messaging":
      message = `Send a message to the agent ${peer.name} (agent id ${peer.id}). In it, ask that agent to send a message back to you (agent id ${subject.id}) with the word ${nonce}. Then end your turn; its reply arrives as a new message.`;
      judge = async (since) =>
        messagingFailure(
          office.entries(subject.id),
          office.entries(peer.id),
          subject.id,
          peer.id,
          nonce,
          since,
        );
      break;
    case "git":
      message = `In your working folder, create the file conformance.txt that contains ${nonce}, and commit it with the message "conformance ${nonce}". Do not set or change the git author.`;
      judge = async () => {
        const last = git(run.repo, ctx.gitEnv, [
          "log",
          "-1",
          "--format=%s%x00%an%x00%ae",
        ]);
        const [subjectLine, authorName, authorEmail] = last.out.split("\0");
        return judgeCommit(
          last.ok && last.out
            ? {
                subject: subjectLine ?? "",
                authorName: authorName ?? "",
                authorEmail: authorEmail ?? "",
              }
            : null,
          run.identity,
          nonce,
        );
      };
      break;
    case "ask":
      message = `Open an ask for me with the question "Ship ${nonce}?" and the options yes and no. Then end your turn.`;
      judge = async (since) =>
        newOpenAsk(
          await office.call<AskMemberWire[]>("GET", "/api/asks"),
          subject.id,
          since,
        )
          ? null
          : "no new open ask from the agent";
      break;
    case "wrap":
      message = "/wrap-session";
      judge = async (since) => {
        const entries = office.entries(subject.id);
        const typed = slashResolved(entries, "wrap-session", since);
        if (!typed)
          return "the office did not resolve /wrap-session to the skill";
        const after = entries.filter((e) => e.timestamp >= typed.timestamp);
        const error = after.find((e) => e.kind === "error");
        if (error)
          return `the turn ended in an error: ${error.content.slice(0, 200)}`;
        return after.some((e) => e.kind === "text" && e.content.trim())
          ? null
          : "the turn gave no answer";
      };
      break;
  }

  // Steps 1-4 each start in a fresh conversation, so no step can reuse a
  // workaround the agent found in an earlier one.
  if (FRESH_STEPS.includes(step)) {
    await office.call("POST", `/api/agents/${subject.id}/new-conversation`, {});
    const fresh = Date.now() + FRESH_WAIT_MS;
    while (!(await office.idle([subject.id, peer.id]))) {
      if (Date.now() > fresh)
        return "the agent did not settle after a new conversation";
      await Bun.sleep(1_000);
    }
  }
  const since = Date.now();
  const deadline =
    since + (step === "messaging" ? MESSAGING_DEADLINE_MS : STEP_DEADLINE_MS);
  await office.call("POST", `/api/agents/${subject.id}/messages`, {
    text: message,
  });
  // The send is on record before the agents can read as settled.
  while (
    !office
      .entries(subject.id)
      .some((e) => e.kind === "user_message" && e.timestamp >= since)
  ) {
    if (Date.now() > deadline) return "the office did not record the message";
    await Bun.sleep(500);
  }
  const agents = [subject.id, peer.id];
  let settledAt: number | null = null;
  let reason: string | null = "the agents did not settle";
  for (;;) {
    if (Date.now() > deadline) {
      for (const id of agents)
        await office.call("POST", `/api/agents/${id}/abort`).catch(() => {});
      const abortDeadline = Date.now() + ABORT_WAIT_MS;
      while (Date.now() < abortDeadline && !(await office.idle(agents)))
        await Bun.sleep(1_000);
      return `timeout (${reason})`;
    }
    // Two idle reads a second apart: a reply between them wakes an agent.
    const idle =
      (await office.idle(agents)) &&
      (await Bun.sleep(1_000), await office.idle(agents));
    if (idle) {
      settledAt ??= Date.now();
      reason = await judge(since);
      if (!reason) return null;
      if (Date.now() - settledAt > SETTLE_GRACE_MS) {
        // The engine's own error, when the turn had one, says more than the
        // missing record.
        const error = agents
          .flatMap((id) => office.entries(id))
          .filter((e) => e.kind === "error" && e.timestamp >= since)
          .sort((a, b) => a.timestamp - b.timestamp)
          .pop();
        return error
          ? `${reason}; an agent's error: ${error.content.slice(0, 200)}`
          : reason;
      }
    } else settledAt = null;
    await Bun.sleep(1_000);
  }
}

// What the Claude column runs on: a copy of the office Claude sign-in
// without its refresh token, written at mode 0600 into the scratch office's
// Claude home. Returns null when the column runs, else why it does not.
async function prepareClaude(
  claudeRoot: string,
  givenRoot: string | null,
  runDir: string,
  marginMs: number,
): Promise<{ skip: string } | { fail: string } | null> {
  const file = join(claudeRoot, ".credentials.json");
  const read = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
  let login = claudeLogin(read(), Date.now(), marginMs);
  if (login.kind === "refresh") {
    log(
      "claude",
      `the office Claude sign-in in ${claudeRoot} expires within the margin; refreshing it in ${Math.round(login.waitMs / 60_000)} min`,
    );
    await Bun.sleep(login.waitMs);
    // Claude refreshes its own sign-in in place on a call in its last 5
    // minutes, under its own lock, as every agent of the office does.
    spawnSync(
      "claude",
      [
        "-p",
        "--model",
        CLAUDE_MODEL,
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "Reply with the single word ok",
      ],
      {
        cwd: runDir,
        env: claudeRefreshEnv(process.env, givenRoot),
        stdio: "ignore",
        timeout: 120_000,
      },
    );
    // Claude makes a project dir for the call's cwd even without a session
    // (an empty memory folder): remove exactly that, when it holds nothing.
    const project = join(
      claudeRoot,
      "projects",
      runDir.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    for (const dir of [join(project, "memory"), project])
      try {
        rmdirSync(dir);
      } catch {
        // Absent, or not empty: left as Claude wrote it.
      }
    login = claudeLogin(read(), Date.now(), marginMs);
    if (login.kind !== "copy")
      return { fail: "the office Claude sign-in did not refresh" };
  }
  if (login.kind === "skip") return { skip: login.reason };
  if (login.kind === "invalid") return { fail: login.reason };
  if (login.kind !== "copy") return { fail: "unexpected Claude sign-in state" };
  const home = join(runDir, "claude");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".credentials.json"), login.text, {
    mode: 0o600,
    flag: "wx",
  });
  return null;
}

// One JSON-RPC call to a Codex app-server on env's CODEX_HOME, started from
// the checkout's Codex launcher and stopped after the answer.
async function codexCall(
  checkout: string,
  env: Record<string, string>,
  cwd: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const launcher = join(
    checkout,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  const child = spawn(
    process.execPath,
    [
      launcher,
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "analytics.enabled=false",
    ],
    { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  const send = (frame: unknown) =>
    child.stdin!.write(`${JSON.stringify(frame)}\n`);
  try {
    return await new Promise<unknown>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`Codex did not answer ${method} in time`)),
        timeoutMs,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        fail(new Error(`Codex exited with code ${exitCode} before ${method}`));
      });
      let buffer = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let frame: { id?: number; result?: unknown; error?: unknown };
          try {
            frame = JSON.parse(line) as typeof frame;
          } catch {
            continue;
          }
          if (frame.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method, params });
          } else if (frame.id === 2) {
            clearTimeout(timer);
            if (frame.error !== undefined)
              fail(
                new Error(
                  `Codex refused ${method}: ${JSON.stringify(frame.error).slice(0, 200)}`,
                ),
              );
            else done(frame.result);
          }
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "isomux-conformance", version: "1", title: null },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: null,
          },
        },
      });
    });
  } finally {
    await stopServer(child);
  }
}

// What the Codex column runs on: a copy of the office Codex sign-in with an
// empty refresh token, written at mode 0600 into the scratch office's Codex
// home. Codex rotates the refresh token on each use, so a copy that could
// refresh would break the office sign-in. Returns null when the column runs,
// else why it does not.
async function prepareCodex(
  codexRoot: string,
  checkout: string,
  runDir: string,
): Promise<{ skip: string } | { fail: string } | null> {
  const file = join(codexRoot, "auth.json");
  const read = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
  let login = codexLogin(read(), Date.now(), COLUMN_MS);
  if (login.kind === "refresh") {
    log(
      "codex",
      `the office Codex sign-in in ${codexRoot} expires within the column; refreshing it`,
    );
    // account/read with refreshToken refreshes in place, as an office agent
    // does: Codex reloads auth.json under its refresh lock first, and so do
    // the office's running Codex processes before their own refresh or after
    // a 401 (codex-rs 0.166 login/src/auth/manager.rs refresh_token), so they
    // pick up the new token. The refresh comes before the account read
    // (app-server get_account in account_processor/workspace_routing.rs).
    let error = "";
    await codexCall(
      checkout,
      codexEnv(process.env, codexRoot),
      runDir,
      "account/read",
      { refreshToken: true },
      60_000,
    ).catch((e: Error) => (error = `: ${e.message}`));
    login = codexLogin(read(), Date.now(), COLUMN_MS);
    if (login.kind === "refresh")
      return { fail: `the office Codex sign-in did not refresh${error}` };
  }
  if (login.kind === "skip") return { skip: login.reason };
  if (login.kind === "invalid") return { fail: login.reason };
  if (login.kind !== "copy") return { fail: "unexpected Codex sign-in state" };
  const home = join(runDir, "codex");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "auth.json"), login.text, {
    mode: 0o600,
    flag: "wx",
  });
  // The token's plan claim lags the account by up to its 10-day life; the
  // backend's answer, read on the copy, tells a lapsed plan or a used-up
  // limit now.
  let limits: unknown;
  try {
    limits = await codexCall(
      checkout,
      codexEnv(process.env, home),
      runDir,
      "account/rateLimits/read",
      { excludeResetCreditDetails: true },
      60_000,
    );
  } catch (e) {
    return { fail: `the Codex usage read failed: ${(e as Error).message}` };
  }
  const plan = codexPlanSkip(limits);
  if (plan?.kind === "skip") return { skip: plan.reason };
  if (plan?.kind === "fail") return { fail: plan.reason };
  return null;
}

// When a process started, in clock ticks since boot (/proc/<pid>/stat field
// 22, counted after the command name in parentheses).
function startTicks(pid: string): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}

// The processes the scratch office left: a working folder inside the run
// dir, or an environment value that points into it (every process the
// office starts inherits its ISOMUX_HOME). A command line that names the run
// dir proves nothing: the shell that started this run names it too, and a
// subshell of it can be younger than the run.
function leftovers(runDir: string): Map<number, string> {
  const found = new Map<number, string>();
  const inside = (value: string) =>
    value === runDir || value.startsWith(`${runDir}${sep}`);
  // A process older than this run is not the office's.
  const runStart = startTicks(String(process.pid));
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || pid === String(process.pid)) continue;
    try {
      if (startTicks(pid) <= runStart) continue;
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (
        inside(readlinkSync(`/proc/${pid}/cwd`)) ||
        environ.some((entry) => inside(entry.slice(entry.indexOf("=") + 1)))
      )
        found.set(
          Number(pid),
          readFileSync(`/proc/${pid}/cmdline`, "utf8")
            .replace(/\0/g, " ")
            .slice(0, 120),
        );
    } catch {
      // Gone, or not ours.
    }
  }
  return found;
}

async function stopServer(server: ChildProcess | undefined) {
  if (!server?.pid) return;
  const group = -server.pid;
  try {
    process.kill(group, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 15_000;
  while (
    Date.now() < deadline &&
    server.exitCode === null &&
    server.signalCode === null
  )
    await Bun.sleep(250);
  try {
    process.kill(group, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function printMatrix(engines: Engine[], columns: Record<string, Column>) {
  const cell = (column: Column, step: Step) => {
    if (column.skip) return "skip";
    const c = column.steps[step];
    return c
      ? c.status === "pass"
        ? "PASS"
        : c.status === "fail"
          ? "FAIL"
          : "skip"
      : "-";
  };
  const width = Math.max(...STEPS.map((s) => s.length));
  console.log("");
  console.log(
    `${"".padEnd(width)}  ${engines.map((e) => e.padEnd(9)).join("")}`,
  );
  for (const step of STEPS)
    console.log(
      `${step.padEnd(width)}  ${engines.map((e) => cell(columns[e]!, step).padEnd(9)).join("")}`,
    );
}

async function main() {
  const { values } = parseArgs({
    options: {
      engines: { type: "string" },
      json: { type: "string" },
      dir: { type: "string" },
      keep: { type: "boolean" },
      checkout: { type: "string" },
      "claude-root": { type: "string" },
      "claude-margin": { type: "string" },
      "codex-root": { type: "string" },
      "codex-model": { type: "string" },
      "opencode-model": { type: "string" },
      steps: { type: "string" },
    },
  });
  const engines = (values.engines?.split(",") ?? ENGINES) as Engine[];
  // A subset of the steps, in their usual order; the others show "-".
  const steps = (values.steps?.split(",") ?? [...STEPS]) as Step[];
  for (const step of steps)
    if (!STEPS.includes(step)) {
      console.error(`unknown step ${step}`);
      process.exit(2);
    }
  const runSteps = STEPS.filter((step) => steps.includes(step));
  for (const engine of engines)
    if (!ENGINES.includes(engine)) {
      console.error(`unknown engine ${engine}`);
      process.exit(2);
    }
  const marginMs = Number(values["claude-margin"] ?? 70) * 60_000;
  if (!(marginMs >= COLUMN_MS)) {
    console.error(
      `--claude-margin must cover the Claude column: at least ${Math.ceil(COLUMN_MS / 60_000)} minutes`,
    );
    process.exit(2);
  }
  const checkout = resolve(
    values.checkout ?? join(import.meta.dir, "..", ".."),
  );
  const commit =
    spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout?.trim() || null;
  const givenClaudeRoot = values["claude-root"] ?? null;
  const claudeRoot = givenClaudeRoot ?? join(homedir(), ".claude");
  // The office Codex sign-in: the office's own Codex home, as agents of a
  // member without a personal Codex sign-in use it.
  const codexRoot =
    values["codex-root"] ?? join(homedir(), ".isomux", "codex-home");

  // The run removes its dir at the end, so a given dir must be new or empty:
  // a typo must not delete a real folder.
  const refuse = (line: string) => {
    console.error(line);
    process.exit(2);
  };
  if (values.dir && existsSync(values.dir)) {
    if (!statSync(values.dir).isDirectory())
      refuse(`--dir ${values.dir} is not a folder`);
    if (readdirSync(values.dir).length > 0)
      refuse(`--dir ${values.dir} exists and is not empty`);
  }
  const givenEmptyDir = !!values.dir && existsSync(values.dir);
  const port = await freePort();
  // Refused before anything is made.
  let env: Record<string, string> = {};
  if (values.dir)
    try {
      env = buildServerEnv(process.env, resolve(values.dir), port);
    } catch (error) {
      refuse((error as Error).message);
    }
  const runDir = values.dir
    ? resolve(values.dir)
    : mkdtempSync(join(tmpdir(), "isomux-conformance-"));
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const base = `http://localhost:${port}`;
  const columns: Record<string, Column> = {};
  for (const engine of engines) columns[engine] = { steps: {} };
  let server: ChildProcess | undefined;
  let exitCode = 0;
  let tornDown = false;
  // A stopped run still stops its office and removes the sign-in copy.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      log("run", `FAIL stopped by ${signal}`);
      void teardown().finally(() => process.exit(2));
    });
  log(
    "run",
    `server ${checkout} at ${commit ?? "unknown commit"}, run dir ${runDir}, port ${port}`,
  );

  try {
    try {
      env = buildServerEnv(process.env, runDir, port);
    } catch (error) {
      throw new RunFailure((error as Error).message);
    }
    mkdirSync(env.TMPDIR!, { recursive: true, mode: 0o700 });
    const office = new Office(base, env.ISOMUX_HOME!);
    const serverLog = openSync(join(runDir, "server.log"), "a");
    server = spawn("bun", ["server/isomux-office.ts"], {
      cwd: checkout,
      env,
      detached: true,
      stdio: ["ignore", serverLog, serverLog],
    });
    closeSync(serverLog);

    // Boot and claim.
    const keyFile = join(env.ISOMUX_HOME!, "setup-key");
    const bootDeadline = Date.now() + 180_000;
    for (;;) {
      const up = await fetch(`${base}/readyz`, {
        signal: AbortSignal.timeout(5_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (up && existsSync(keyFile)) break;
      if (server.exitCode !== null)
        throw new RunFailure(
          `the server exited with code ${server.exitCode}; see ${join(runDir, "server.log")}`,
        );
      if (Date.now() > bootDeadline)
        throw new RunFailure("the server did not boot within 180s");
      await Bun.sleep(500);
    }
    const key = readFileSync(keyFile, "utf8").trim();
    office.cookie = await claimOwner(base, base, {
      kind: "setup-link",
      name: OWNER,
      url: `${base}/setup#key=${key}`,
    }).catch((error: Error) => {
      throw new RunFailure(`claim: ${error.message}`);
    });
    log("run", "PASS boot and claim");

    // The office's provider homes go in the run dir before any agent starts.
    await office.call("PUT", "/api/office/env", {
      values: officeVariables(runDir),
    });

    // The four sources of an office call.
    const markers = {
      office: `CF-office-${token()}`,
      room: `CF-room-${token()}`,
      member: `CF-member-${token()}`,
      skill: `CF-skill-${token()}`,
    };
    const { rooms } = await office.call<{
      rooms: { id: string; name: string }[];
    }>("GET", "/api/me/rooms");
    const room = rooms.find((r) => r.id !== "lobby");
    if (!room) throw new RunFailure("the office has no room besides the lobby");
    await office.putInstructions(
      "/api/office/instructions",
      officeLine(port, "office", markers.office),
    );
    await office.putInstructions(
      `/api/rooms/${room.id}/instructions`,
      officeLine(port, "room", markers.room),
    );
    await office.putInstructions(
      `/api/users/${encodeURIComponent(OWNER)}/instructions`,
      officeLine(port, "member", markers.member),
    );
    await office.call("POST", "/api/skills", {
      name: SKILL,
      description:
        "Run when a member asks for a conformance check with a code.",
      instructions: officeLine(port, "skill", markers.skill).replace(
        /^When a member says "skill check" followed by a code, run/,
        "Run",
      ),
    });

    // The git identity the OS user's agents must commit with.
    const gitEnv = buildServerEnv(process.env, runDir, port);
    delete gitEnv.PORT;
    delete gitEnv.ISOMUX_HOME;
    delete gitEnv.ISOMUX_BACKUP_DIR;
    const ctx: RunContext = {
      office,
      port,
      markers,
      bundledSkillsRoot: join(checkout, "skills"),
      userSkillRoots: Object.values(officeVariables(runDir)).map((home) =>
        join(home, "skills"),
      ),
      gitEnv,
    };

    // The OpenCode model: the free model the office picked for its Free
    // Welcome Agent, unless given.
    const opencodeModel = async (): Promise<string> => {
      if (values["opencode-model"]) return values["opencode-model"];
      const deadline = Date.now() + 120_000;
      for (;;) {
        const agents = await office.call<
          { name: string; model?: string; modelFamily?: string }[]
        >("GET", "/agents?back=1");
        const free = agents.find((a) => a.name === "Free Welcome Agent");
        const model = free?.modelFamily ?? free?.model;
        if (model) return model;
        if (Date.now() > deadline)
          throw new Error("the office picked no free OpenCode model");
        await Bun.sleep(1_000);
      }
    };

    const runEngine = async (engine: Engine) => {
      const column = columns[engine]!;
      // The Claude and Codex columns run on a copy of the office sign-in.
      const prepared =
        engine === "claude"
          ? await prepareClaude(
              claudeRoot,
              givenClaudeRoot,
              runDir,
              marginMs,
            ).catch((error: Error) => ({ fail: error.message }))
          : engine === "codex"
            ? await prepareCodex(codexRoot, checkout, runDir).catch(
                (error: Error) => ({ fail: error.message }),
              )
            : null;
      if (prepared && "skip" in prepared) column.skip = prepared.skip;
      if (prepared && "fail" in prepared) column.setupFailure = prepared.fail;
      if (column.skip) {
        log(engine, `SKIP ${column.skip}`);
        return;
      }
      if (column.setupFailure) {
        log(engine, `FAIL setup ${column.setupFailure}`);
        return;
      }
      let run: EngineRun;
      let identity: { name: string; email: string };
      try {
        const modelFamily =
          engine === "claude"
            ? CLAUDE_MODEL
            : engine === "codex"
              ? (values["codex-model"] ?? CODEX_MODEL)
              : await opencodeModel();
        const repo = join(runDir, "repos", engine);
        mkdirSync(repo, { recursive: true });
        if (!git(repo, gitEnv, ["init", "-q"]).ok)
          throw new Error("git init failed");
        // Resolved in the agent's repo, where includeIf "gitdir:" rules apply.
        const name = git(repo, gitEnv, ["config", "user.name"]);
        const email = git(repo, gitEnv, ["config", "user.email"]);
        if (!name.ok || !email.ok || !name.out || !email.out)
          throw new Error(
            "git has no user.name and user.email for the OS user in the agent's repo",
          );
        identity = { name: name.out, email: email.out };
        const peerDir = join(runDir, "repos", `${engine}-peer`);
        mkdirSync(peerDir, { recursive: true });
        const spawnAgent = async (name: string, cwd: string) =>
          (
            await office.call<{ agent: Agent }>("POST", "/api/agents", {
              name,
              roomId: room.id,
              cwd,
              agentType: engine,
              modelFamily,
            })
          ).agent;
        run = {
          engine,
          subject: await spawnAgent(`Conformance ${engine}`, repo),
          peer: await spawnAgent(`Conformance ${engine} peer`, peerDir),
          repo,
          identity,
        };
        log(
          engine,
          `agents on ${modelFamily}: ${run.subject.id}, peer ${run.peer.id}`,
        );
      } catch (error) {
        column.setupFailure = (error as Error).message;
        log(engine, `FAIL setup ${column.setupFailure}`);
        return;
      }
      for (const step of runSteps) {
        const at = Date.now();
        let reason: string | null;
        try {
          reason = await runStep(ctx, run, step);
        } catch (error) {
          reason = (error as Error).message;
        }
        const seconds = Math.round((Date.now() - at) / 100) / 10;
        // A red step that OpenCode refused with its free usage limit says
        // nothing about the office. A green step was checked.
        const skip = reason
          ? freeLimitSkip(
              [
                ...ctx.office.entries(run.subject.id),
                ...ctx.office.entries(run.peer.id),
              ],
              at,
            )
          : null;
        if (skip) {
          column.steps[step] = { status: "skip", reason: skip };
          log(engine, `SKIP ${step} (${seconds}s) ${skip}`);
          continue;
        }
        column.steps[step] = reason
          ? { status: "fail", seconds, reason }
          : { status: "pass", seconds };
        log(
          engine,
          `${reason ? "FAIL" : "PASS"} ${step} (${seconds}s)${reason ? ` ${reason}` : ""}`,
        );
      }
    };

    await Promise.all(engines.map(runEngine));
  } catch (error) {
    exitCode = 2;
    log("run", `FAIL ${(error as Error).message}`);
  } finally {
    await teardown();
  }

  async function teardown() {
    if (tornDown) return;
    tornDown = true;
    await stopServer(server);
    // The copies of the office sign-ins never outlive the run.
    rmSync(join(runDir, "claude", ".credentials.json"), { force: true });
    rmSync(join(runDir, "codex", "auth.json"), { force: true });
    // A leftover is red, and then stopped: the nightly runs unattended.
    const left = leftovers(runDir);
    if (left.size) {
      log(
        "run",
        `FAIL leftover processes, now killed: ${[...left].map(([pid, cmd]) => `${pid} ${cmd}`).join(" | ")}`,
      );
      for (const pid of left.keys())
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone meanwhile.
        }
      if (exitCode === 0) exitCode = 1;
    }
    if (existsSync(join(runDir, "claude", ".credentials.json"))) {
      log("run", "FAIL the copy of the office Claude sign-in is still there");
      if (exitCode === 0) exitCode = 1;
    }
    if (existsSync(join(runDir, "codex", "auth.json"))) {
      log("run", "FAIL the copy of the office Codex sign-in is still there");
      if (exitCode === 0) exitCode = 1;
    }
    // Only what the run made: an empty dir it was given stays.
    if (!values.keep && givenEmptyDir)
      for (const entry of readdirSync(runDir))
        rmSync(join(runDir, entry), { recursive: true, force: true });
    else if (!values.keep) rmSync(runDir, { recursive: true, force: true });
  }

  printMatrix(engines, columns);
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const engine of engines) {
    const column = columns[engine]!;
    if (column.skip) skip++;
    else if (column.setupFailure) fail++;
    for (const cell of Object.values(column.steps)) {
      if (cell.status === "pass") pass++;
      else if (cell.status === "fail") fail++;
      else skip++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail && exitCode === 0) exitCode = 1;
  if (values.json)
    writeFileSync(
      values.json,
      JSON.stringify({ commit, exitCode, engines: columns }, null, 2),
    );
  process.exit(exitCode);
}

if (import.meta.main) await main();
