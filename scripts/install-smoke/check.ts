// The checks every install path must pass, run against a freshly installed
// office from inside its environment (the box, container or pod), as its
// first owner:
//
//   start       the server answers
//   claim       the first owner claims the office (claim.ts)
//   readyz      GET /readyz answers 200
//   agents      the welcome agents of each engine exist
//   terminal    a native terminal runs a command
//   signed-out  a message to a signed-out agent of each engine shows the
//               sign-in notice and no error or retry lines
//   free-agent  with --free-agent (the weekly set): the Free Welcome Agent
//               answers a message
//
// A failure exits 1 with a line that names the path and the step. No provider
// credentials: every agent in a fresh office is signed out.
//
// Usage: bun check.ts --path NAME --base URL --origin ORIGIN
//          --claim setup-link --office-log FILE
//        | --claim setup-key --setup-key-file FILE
//        | --claim invite --invite-file FILE
//          [--free-agent]
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { claimOwner, preClaimProbe, type ClaimMethod } from "./claim.ts";
import { REQUEST_TIMEOUT_MS, request } from "./http.ts";

export type Engine = "claude" | "codex" | "opencode";

// The parts of the office's wire types this client reads (shared/types.ts).
export interface Entry {
  id: string;
  agentId: string;
  kind: string;
  content: string;
  metadata?: { providerLogin?: string } & Record<string, unknown>;
}
interface Agent {
  id: string;
  name: string;
  agentType: Engine;
  roomId: string;
  state: string;
}
type ServerMessage = { type: string } & Record<string, unknown>;

const SIGNED_OUT_ENGINES: Engine[] = ["claude", "codex"];

export class StepFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

// What a member must see after messaging a signed-out agent: the sign-in
// notice, which is the system entry that carries the sign-in card, and
// nothing else from the agent. A retry line, a raw provider error or any
// other system line is the failure task 737e8c0f describes. Returns the
// reason for a failure, or null.
export function judgeSignedOut(engine: Engine, entries: Entry[]): string | null {
  const isNotice = (e: Entry) =>
    e.kind === "system" && e.metadata?.providerLogin === engine;
  const extra = entries.filter((e) => e.kind !== "user_message" && !isNotice(e));
  const lines = extra.map((e) => `${e.kind}: ${e.content.slice(0, 200)}`);
  if (!entries.some(isNotice))
    return `no sign-in notice; the chat showed ${lines.length ? lines.join(" | ") : "nothing"}`;
  if (extra.length) return `the sign-in notice came with ${lines.join(" | ")}`;
  return null;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");
}

export class OfficeSocket {
  readonly agents = new Map<string, Agent>();
  readonly entries: Entry[] = [];
  private readonly messages: ServerMessage[] = [];
  private waiters = new Set<() => void>();
  private closed: string | null = null;
  private replayed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.apply(message);
      this.messages.push(message);
      for (const wake of this.waiters) wake();
    });
    socket.addEventListener("close", (event) => {
      this.closed = `the office closed the WebSocket (code ${event.code})`;
      for (const wake of this.waiters) wake();
    });
  }

  static async open(
    base: string,
    origin: string,
    cookie: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    const url = `${base.replace(/^http/, "ws")}/ws`;
    // Bun's WebSocket takes handshake headers; the office checks the Origin
    // and reads the session from the cookie.
    const socket = new WebSocket(url, {
      headers: { Cookie: cookie, Origin: origin },
    } as unknown as string[]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${url} did not open within ${timeoutMs / 1000}s`)),
          timeoutMs,
        );
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "error",
          () => reject(new Error(`could not open ${url}`)),
          { once: true },
        );
      });
    } catch (error) {
      socket.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const office = new OfficeSocket(socket);
    await office.until(() => office.replayed, 30_000, "the transcript replay");
    return office;
  }

  private apply(message: ServerMessage) {
    if (message.type === "full_state") {
      this.agents.clear();
      for (const agent of message.agents as Agent[])
        this.agents.set(agent.id, agent);
    } else if (message.type === "agent_added") {
      const agent = message.agent as Agent;
      this.agents.set(agent.id, agent);
    } else if (message.type === "agent_updated") {
      const agent = this.agents.get(message.agentId as string);
      if (agent) Object.assign(agent, message.changes);
    } else if (message.type === "agent_removed") {
      this.agents.delete(message.agentId as string);
    } else if (message.type === "log_replay_complete") {
      this.replayed = true;
    } else if (message.type === "log_entry" && this.replayed) {
      this.entries.push(message.entry as Entry);
    }
  }

  send(message: object) {
    this.socket.send(JSON.stringify(message));
  }

  // Resolves when `done` holds, re-checked on every frame from the office.
  until(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (done()) finish();
        else if (this.closed) finish(new Error(this.closed));
      };
      const timer = setTimeout(
        () => finish(new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)),
        timeoutMs,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      this.waiters.add(check);
      check();
    });
  }

  // Every frame the office sent before the pong has arrived after it.
  async flush() {
    const mark = this.messages.length;
    this.send({ type: "ping" });
    await this.until(
      () => this.messages.slice(mark).some((m) => m.type === "pong"),
      10_000,
      "a pong",
    );
  }

  framesSince(mark: number): ServerMessage[] {
    return this.messages.slice(mark);
  }

  get frameCount() {
    return this.messages.length;
  }

  close() {
    this.socket.close();
  }
}

async function poll(
  url: string,
  ok: (status: number) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  for (;;) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      await response.arrayBuffer();
      if (ok(response.status)) return;
      last = `HTTP ${response.status}`;
      // Through a proxy /readyz allows 30 requests a minute per client.
      if (response.status === 429) await Bun.sleep(2_000);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline)
      throw new Error(`${url} did not answer within ${timeoutMs / 1000}s (last: ${last})`);
    await Bun.sleep(250);
  }
}

function agentOf(office: OfficeSocket, engine: Engine): Agent | undefined {
  return [...office.agents.values()].find((a) => a.agentType === engine);
}

async function checkTerminal(office: OfficeSocket, agent: Agent) {
  const mark = office.frameCount;
  const own = (m: ServerMessage) => m.agentId === agent.id;
  office.send({ type: "terminal_open", agentId: agent.id });
  const exit = () => office.framesSince(mark).find((m) => own(m) && m.type === "terminal_exit");
  await office.until(
    () =>
      !!exit() ||
      office.framesSince(mark).some((m) => own(m) && m.type === "terminal_status" && m.shell === true),
    30_000,
    "the terminal shell",
  );
  if (exit()) throw new Error(`the terminal exited with code ${exit()!.exitCode}`);
  // The joined marker appears only in the command's output, not its echo.
  office.send({
    type: "terminal_input",
    agentId: agent.id,
    data: "printf 'isomux-smoke-%s\\n' terminal-ok\r",
  });
  const output = () =>
    stripAnsi(
      office
        .framesSince(mark)
        .filter((m) => own(m) && m.type === "terminal_output")
        .map((m) => m.data as string)
        .join(""),
    );
  await office
    .until(() => output().includes("isomux-smoke-terminal-ok"), 30_000, "the terminal command output")
    .catch((error: Error) => {
      throw new Error(`${error.message}; the terminal showed: ${JSON.stringify(output().slice(-500))}`);
    });
  office.send({ type: "terminal_close", agentId: agent.id });
}

// POST a member message to an agent, as the chat composer does.
export async function sendMessage(
  base: string,
  origin: string,
  cookie: string,
  agentId: string,
  text: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<void> {
  const response = await request(
    `${base}/api/agents/${agentId}/messages`,
    {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
    "the send",
    timeoutMs,
  );
  if (!response.ok)
    throw new Error(`the send answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

// The office's own record of a running turn (GET /agents, inFlightTurn).
async function turnLive(base: string, cookie: string, agentId: string): Promise<boolean> {
  const response = await request(`${base}/agents`, { headers: { Cookie: cookie } }, "GET /agents");
  if (!response.ok) throw new Error(`GET /agents answered HTTP ${response.status}`);
  const agents = (await response.json()) as { id: string; inFlightTurn?: unknown }[];
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`GET /agents does not list ${agentId}`);
  return agent.inFlightTurn != null;
}

// Waits until the chat shows `seen`, and then until the office reports no
// running turn for the agent. The office is asked only after `seen` holds, and
// `seen` includes a line of this send's turn, so the answer is about this
// turn. Lines of a turn arrive while it runs: a send that still reaches the
// provider keeps its turn running through every retry. The ping at the end
// orders the frames sent before the turn ended.
async function settleTurn(
  office: OfficeSocket,
  base: string,
  cookie: string,
  agent: Agent,
  seen: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await office.until(seen, timeoutMs, what);
  while (await turnLive(base, cookie, agent.id)) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for the ${agent.name} turn to end`);
    await Bun.sleep(250);
  }
  await office.flush();
}

async function checkSignedOut(
  office: OfficeSocket,
  base: string,
  origin: string,
  cookie: string,
  engine: Engine,
) {
  const agent = agentOf(office, engine)!;
  const mark = office.entries.length;
  const own = () => office.entries.slice(mark).filter((e) => e.agentId === agent.id);
  await sendMessage(base, origin, cookie, agent.id, "Hello");
  await settleTurn(
    office,
    base,
    cookie,
    agent,
    () =>
      own().some((e) => e.kind === "user_message") &&
      own().some((e) => e.kind === "system" && e.metadata?.providerLogin === engine),
    120_000,
    `the ${agent.name} sign-in notice`,
  ).catch((error: Error) => {
    throw new Error(`${error.message}; ${judgeSignedOut(engine, own()) ?? "the notice arrived"}`);
  });
  const failure = judgeSignedOut(engine, own());
  if (failure) throw new Error(failure);
}

// The weekly set also messages the Free Welcome Agent, the OpenCode agent on
// a free model that needs no sign-in, and requires an answer. It depends on
// OpenCode's service, so the release set leaves it out.
export function judgeAnswer(entries: Entry[]): string | null {
  const lines = entries
    .filter((e) => e.kind !== "user_message")
    .map((e) => `${e.kind}: ${e.content.slice(0, 200)}`);
  if (entries.some((e) => e.kind === "error"))
    return `the turn reported an error: ${lines.join(" | ")}`;
  if (!entries.some((e) => e.kind === "text" && e.content.trim()))
    return `no answer; the chat showed ${lines.length ? lines.join(" | ") : "nothing"}`;
  return null;
}

function freeAgentOf(office: OfficeSocket): Agent | undefined {
  // The Receptionist is an OpenCode agent too, in the Lobby.
  return [...office.agents.values()].find(
    (a) => a.agentType === "opencode" && a.roomId !== "lobby",
  );
}

async function checkFreeAgent(office: OfficeSocket, base: string, origin: string, cookie: string) {
  const agent = freeAgentOf(office)!;
  const mark = office.entries.length;
  const own = () => office.entries.slice(mark).filter((e) => e.agentId === agent.id);
  await sendMessage(base, origin, cookie, agent.id, "Reply with one word: ready");
  await settleTurn(
    office,
    base,
    cookie,
    agent,
    () =>
      own().some((e) => e.kind === "user_message") &&
      own().some((e) => e.kind === "text" || e.kind === "error"),
    240_000,
    `an answer from ${agent.name}`,
  ).catch((error: Error) => {
    throw new Error(`${error.message}; ${judgeAnswer(own()) ?? "an answer arrived"}`);
  });
  const failure = judgeAnswer(own());
  if (failure) throw new Error(failure);
}

// The setup link an unclaimed office prints in its terminal and log.
async function printedSetupLink(logFile: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    const link = log.match(/https?:\/\/\S+\/setup#key=[^\s]+/)?.[0];
    if (link) return link;
    if (Date.now() > deadline)
      throw new Error(`no setup link in ${logFile} within 30s`);
    await Bun.sleep(250);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      path: { type: "string" },
      base: { type: "string" },
      origin: { type: "string" },
      claim: { type: "string" },
      "setup-key-file": { type: "string" },
      "invite-file": { type: "string" },
      "office-log": { type: "string" },
      "free-agent": { type: "boolean" },
    },
  });
  const path = values.path ?? "unnamed";
  const base = values.base!;
  const origin = values.origin!;
  const name = "Smoke Owner";
  const kind = values.claim;
  if (kind !== "setup-link" && kind !== "setup-key" && kind !== "invite")
    throw new Error("--claim must be setup-link, setup-key or invite");
  // Read only when the claim runs: the office writes its setup link and the
  // installer its invite link while the client waits for the start.
  const claimMethod = async (): Promise<ClaimMethod> => {
    if (kind === "setup-key")
      return { kind, name, key: readFileSync(values["setup-key-file"]!, "utf8").trim() };
    if (kind === "invite")
      return { kind, url: readFileSync(values["invite-file"]!, "utf8").trim() };
    return { kind, name, url: await printedSetupLink(values["office-log"]!) };
  };
  const weekly = values["free-agent"] === true;
  const set = weekly ? "weekly set (with the Free Welcome Agent answer)" : "release set";
  console.log(`[smoke:${path}] checks: ${set}`);
  const started = Date.now();
  const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    try {
      const result = await run();
      console.log(`[smoke:${path}] PASS ${label} (${((Date.now() - at) / 1000).toFixed(1)}s)`);
      return result;
    } catch (error) {
      throw new StepFailure(label, error instanceof Error ? error.message : String(error));
    }
  };

  let office: OfficeSocket | undefined;
  try {
    await step("start", () => poll(`${base}${preClaimProbe(kind)}`, (s) => s === 200, 180_000));
    const cookie = await step("claim", async () => claimOwner(base, origin, await claimMethod()));
    await step("readyz", () => poll(`${base}/readyz`, (s) => s === 200, 60_000));
    office = await step("websocket", () => OfficeSocket.open(base, origin, cookie));
    const socket = office;
    await step("agents", () =>
      socket.until(
        () =>
          SIGNED_OUT_ENGINES.every((engine) => agentOf(socket, engine)) &&
          (!weekly || !!freeAgentOf(socket)),
        120_000,
        weekly ? "the Claude, Codex and Free Welcome Agents" : "the Claude and Codex welcome agents",
      ),
    );
    await step("terminal", () => checkTerminal(socket, agentOf(socket, "claude")!));
    for (const engine of SIGNED_OUT_ENGINES)
      await step(`signed-out-${engine}`, () => checkSignedOut(socket, base, origin, cookie, engine));
    if (weekly) await step("free-agent", () => checkFreeAgent(socket, base, origin, cookie));
  } catch (error) {
    const failure =
      error instanceof StepFailure ? error : new StepFailure("unknown", String(error));
    console.error(`[smoke:${path}] FAIL at step ${failure.step}: ${failure.message}`);
    process.exit(1);
  } finally {
    office?.close();
  }
  console.log(`[smoke:${path}] all checks of the ${set} passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(0);
}

if (import.meta.main) await main();
