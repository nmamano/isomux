// The rule ask of "... and automate" (task 33891b5b): an action step that
// adds one line to the asking agent's instructions, its room's or its
// manager's. The server fixes the target at create; the create refuses a bad
// line, a line already there (step_done) and a member who could not write
// that scope; the Apply appends the line the card showed (step_changed when
// the agent changed it since) and the ask closes as done, by the card or by
// a write by hand. The agent tunes the line in place: its edit may replace
// this step, and only this one.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import { ASK_RULE_LINE_MAX } from "../asks.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
const folders: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

interface Res {
  status: number;
  body: unknown;
}

// Morgan owns the office; Casey is a member with its first room.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const casey = await srv.seedMember("Casey");
  const room = srv.agentManager.getRooms()[0].id;
  const o = {
    srv,
    room,
    morgan: morgan.rawSessionId,
    morganName: morgan.username,
    morganId: getUserByName(morgan.username)!.id,
    casey: casey.rawSessionId,
    caseyName: casey.username,
    caseyId: getUserByName(casey.username)!.id,
  };
  expect(
    (
      await asSession(o, o.morgan, "PUT", `/api/users/${o.caseyName}/access`, {
        allowedRooms: [room],
      })
    ).status,
  ).toBe(200);
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function spawn(
  o: Office,
  name: string,
  manager: "Morgan" | "Casey" = "Morgan",
): Promise<AgentInfo> {
  const cwd = mkdtempSync(join(tmpdir(), "action-asks-instructions-"));
  folders.push(cwd);
  const [username, userId] =
    manager === "Morgan"
      ? [o.morganName, o.morganId]
      : [o.caseyName, o.caseyId];
  const agent = await o.srv.agentManager.spawn(
    name,
    cwd,
    "default",
    undefined,
    undefined,
    o.room,
    undefined,
    undefined,
    undefined,
    username,
    "claude",
    undefined,
    userId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

async function read(res: Response): Promise<Res> {
  return { status: res.status, body: await res.json().catch(() => null) };
}

function asSession(
  o: Pick<Office, "srv">,
  session: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return o.srv
    .http(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      rawSessionId: session,
    })
    .then(read);
}

function asAgent(
  o: Office,
  agentId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return o.srv
    .http(path, {
      method,
      headers: {
        Authorization: `Bearer ${getAgentTokenRaw(agentId)!}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    .then(read);
}

const codeOf = (res: Res) =>
  (res.body as { error?: { code?: string } } | null)?.error?.code;
const outcome = (res: Res) => ({ status: res.status, code: codeOf(res) });
const refused = (status: number, code: string) => ({ status, code });

type Scope = "agent" | "room" | "member";
const lineStep = (scope: Scope, line: string) => ({
  kind: "instructions-line" as const,
  scope,
  line,
});

const ask = (
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
  member?: string,
) =>
  asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Quick stamp: save this rule?",
    step,
    ...(member ? { member } : {}),
  });

async function opened(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
  member?: string,
): Promise<AskEntry> {
  const res = await ask(o, askerId, step, member);
  expect(outcome(res)).toEqual({ status: 201, code: undefined });
  return res.body as AskEntry;
}

async function askStatus(o: Office, askerId: string, askId: string) {
  const res = await asAgent(
    o,
    askerId,
    "GET",
    `/api/agents/${askerId}/asks/${askId}`,
  );
  if (res.status !== 200) return String(res.status);
  return (
    (res.body as { closed?: { outcome: string } }).closed?.outcome ?? "open"
  );
}

const apply = (o: Office, session: string, askId: string, body?: unknown) =>
  asSession(o, session, "POST", `/api/asks/${askId}/action`, body);

async function waitUntil(pred: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(10);
  }
}

const closedAsDone = (o: Office, askerId: string, askId: string) =>
  waitUntil(
    async () => (await askStatus(o, askerId, askId)) === "done",
    "the ask closes as done",
  );

async function staysOpen(o: Office, askerId: string, askId: string) {
  await Bun.sleep(100);
  expect(await askStatus(o, askerId, askId)).toBe("open");
}

const stepLines = (o: Office, agentId: string) =>
  o.srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => JSON.stringify(e).match(/systemEntries\.stepAsk\.\w+/)?.[0])
    .filter((key): key is string => key !== undefined);

const auditRows = (operation: string, askId: string) =>
  officeAuditStore()
    .list({ operation, limit: 1000 })
    .items.filter((r) => r.targets.includes(askId))
    .map((r) => [r.actor.kind, r.actor.id]);

// The instructions route of a scope, for an asking agent.
function scopePath(o: Office, agent: AgentInfo, scope: Scope): string {
  if (scope === "agent") return `/api/agents/${agent.id}/instructions`;
  if (scope === "room") return `/api/rooms/${o.room}/instructions`;
  const manager = agent.userId === o.caseyId ? o.caseyName : o.morganName;
  return `/api/users/${manager}/instructions`;
}

async function instructionsOf(o: Office, agent: AgentInfo, scope: Scope) {
  const res = await asSession(o, o.morgan, "GET", scopePath(o, agent, scope));
  expect(res.status).toBe(200);
  return res.body as { instructions: string | null; version: string };
}

// Morgan writes the scope by hand, through its own route.
async function writeByHand(
  o: Office,
  agent: AgentInfo,
  scope: Scope,
  instructions: string,
) {
  const { version } = await instructionsOf(o, agent, scope);
  const res = await asSession(o, o.morgan, "PUT", scopePath(o, agent, scope), {
    instructions,
    version,
  });
  expect(res.status).toBe(200);
}

const RULE = "Tab order and copy changes: go with your pick, tell me after.";
const SCOPES: Scope[] = ["agent", "room", "member"];

describe("an instructions-line ask", () => {
  it("opens for each scope with the target fixed by the server: the asking agent, its room, its manager", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const want: Record<Scope, string> = {
      agent: asker.id,
      room: o.room,
      member: o.morganId,
    };
    for (const scope of SCOPES) {
      const entry = await opened(o, asker.id, lineStep(scope, RULE));
      expect([entry.step, entry.link]).toEqual([
        { ...lineStep(scope, RULE), targetId: want[scope] },
        undefined,
      ]);
    }
    // Nothing is written at the create.
    for (const scope of SCOPES)
      expect((await instructionsOf(o, asker, scope)).instructions ?? "").toBe(
        "",
      );
  });

  it(`refuses a bad step with 400 invalid_request and opens nothing: a target from the agent, an unknown scope, a blank line, more than one line, more than ASK_RULE_LINE_MAX characters, characters that do not show`, async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    for (const step of [
      { ...lineStep("agent", RULE), targetId: asker.id },
      lineStep("office" as Scope, RULE),
      { kind: "instructions-line", scope: "agent" },
      { kind: "instructions-line", scope: "agent", line: 5 },
      lineStep("agent", ""),
      lineStep("agent", "   "),
      lineStep("agent", "Go with your pick.\nTell me after."),
      lineStep("agent", "Go with your pick.\rTell me after."),
      lineStep("agent", "x".repeat(ASK_RULE_LINE_MAX + 1)),
      // A right-to-left override and a zero-width space hide what is saved.
      lineStep("agent", "Go with your pick\u202E.retfa em llet"),
      lineStep("agent", "Go with\u200B your pick"),
    ])
      expect({ step, ...outcome(await ask(o, asker.id, step)) }).toEqual({
        step,
        ...refused(400, "invalid_request"),
      });
    const listed = await asSession(o, o.morgan, "GET", "/api/asks");
    expect((listed.body as unknown[]).length).toBe(0);
    await opened(o, asker.id, lineStep("agent", "x".repeat(ASK_RULE_LINE_MAX)));
  });

  it("refuses a line the scope already holds as a whole line (409 step_done); a line that is only part of another line is not done", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    for (const scope of SCOPES) {
      await writeByHand(
        o,
        asker,
        scope,
        `First rule.\n  ${RULE}  \nLast rule.`,
      );
      expect(outcome(await ask(o, asker.id, lineStep(scope, RULE)))).toEqual(
        refused(409, "step_done"),
      );
      await opened(o, asker.id, lineStep(scope, "First"));
    }
  });

  it("refuses a member who cannot write the scope (403 member_not_allowed): a member's ask for another member's instructions; a member's own are fine", async () => {
    const o = await office();
    const morgans = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    // The condition: Casey cannot write Morgan's instructions herself.
    const own = await asSession(
      o,
      o.casey,
      "PUT",
      `/api/users/${o.morganName}/instructions`,
      { instructions: "x", version: "v" },
    );
    expect(own.status).toBe(403);
    expect(
      outcome(await ask(o, morgans.id, lineStep("member", RULE), o.caseyName)),
    ).toEqual(refused(403, "member_not_allowed"));
    const entry = await opened(o, caseys.id, lineStep("member", RULE));
    expect(entry.step).toEqual({
      ...lineStep("member", RULE),
      targetId: o.caseyId,
    });
  });

  it("Apply appends the line on its own line, keeps the text before it byte for byte, closes the ask as done with one line in the chat and one audit row naming the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    // The room and member stores trim what they keep, so only the agent's
    // instructions can end in a line break; the room starts with none.
    const cases: [Scope, string, string][] = [
      ["agent", "Keep it short.\n\n", `Keep it short.\n\n${RULE}`],
      ["room", "", RULE],
      ["member", "Keep it short.", `Keep it short.\n${RULE}`],
    ];
    const ops: Record<Scope, string> = {
      agent: "agents.setInstructions",
      room: "rooms.setInstructions",
      member: "users.setInstructions",
    };
    for (const [scope, before, after] of cases) {
      if (before !== "") await writeByHand(o, asker, scope, before);
      const entry = await opened(o, asker.id, lineStep(scope, RULE));
      const res = await apply(o, o.morgan, entry.id, { scope, line: RULE });
      expect({ scope, status: res.status < 300 }).toEqual({
        scope,
        status: true,
      });
      expect({
        scope,
        text: (await instructionsOf(o, asker, scope)).instructions,
      }).toEqual({ scope, text: after });
      await closedAsDone(o, asker.id, entry.id);
      expect(auditRows(ops[scope], entry.id)).toEqual([["member", o.morganId]]);
    }
    expect(stepLines(o, asker.id)).toEqual(
      SCOPES.map(() => "systemEntries.stepAsk.instructionsLineAdded"),
    );
  });

  it("Apply with a line or scope other than the stored one, or with none, is 409 step_changed: nothing written, the ask stays open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, lineStep("agent", RULE));
    for (const body of [
      { scope: "agent", line: "Always pick the same." },
      { scope: "room", line: RULE },
      { scope: "agent", line: `${RULE} ` },
      {},
      undefined,
    ]) {
      const res = await apply(o, o.morgan, entry.id, body);
      expect({ body: body ?? null, ...outcome(res) }).toEqual({
        body: body ?? null,
        ...refused(409, "step_changed"),
      });
    }
    expect((await instructionsOf(o, asker, "agent")).instructions ?? "").toBe(
      "",
    );
    await staysOpen(o, asker.id, entry.id);
  });

  it("closes as done when the line is written by hand, through each scope's route and through the agent edit", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    for (const scope of SCOPES) {
      const entry = await opened(o, asker.id, lineStep(scope, RULE));
      await writeByHand(o, asker, scope, `Keep it short.\n${RULE}`);
      await closedAsDone(o, asker.id, entry.id);
    }
    // PATCH /api/agents/:id with instructions writes the agent scope too.
    const other = await spawn(o, "Other");
    const entry = await opened(o, other.id, lineStep("agent", RULE));
    const { version } = await instructionsOf(o, other, "agent");
    const res = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/agents/${other.id}`,
      {
        instructions: RULE,
        instructionsVersion: version,
      },
    );
    expect(res.status).toBe(200);
    await closedAsDone(o, other.id, entry.id);
  });

  it("a write by hand that does not add the line as a whole line leaves the ask open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, lineStep("agent", RULE));
    await writeByHand(o, asker, "agent", `Note: ${RULE}`);
    await staysOpen(o, asker.id, entry.id);
  });
});

describe("the agent's edit of an instructions-line step", () => {
  const patch = (o: Office, agentId: string, askId: string, body: unknown) =>
    asAgent(o, agentId, "PATCH", `/api/agents/${agentId}/asks/${askId}`, body);

  it("replaces the line and the scope, with the target filled again; Apply then takes only the new line", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, lineStep("agent", RULE));
    const tuned = "Copy changes only: go with your pick, tell me after.";
    const res = await patch(o, asker.id, entry.id, {
      text: "Quick stamp: save this rule?",
      step: lineStep("room", tuned),
    });
    expect(res.status).toBe(200);
    expect((res.body as AskEntry).step).toEqual({
      ...lineStep("room", tuned),
      targetId: o.room,
    });
    // The card that still shows the old step.
    expect(
      outcome(
        await apply(o, o.morgan, entry.id, { scope: "agent", line: RULE }),
      ),
    ).toEqual(refused(409, "step_changed"));
    expect((await instructionsOf(o, asker, "agent")).instructions ?? "").toBe(
      "",
    );
    const ran = await apply(o, o.morgan, entry.id, {
      scope: "room",
      line: tuned,
    });
    expect(ran.status).toBeLessThan(300);
    expect((await instructionsOf(o, asker, "room")).instructions).toBe(tuned);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("refuses a bad new step and keeps the old one: a bad line (400), a target from the agent (400), another kind (400), a line already there (409 step_done)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, lineStep("agent", RULE));
    await writeByHand(o, asker, "agent", "Keep it short.");
    for (const [step, want] of [
      [lineStep("agent", "a\nb"), refused(400, "invalid_request")],
      [lineStep("agent", "a\u200Bb"), refused(400, "invalid_request")],
      [
        { ...lineStep("agent", "Other"), targetId: o.room },
        refused(400, "invalid_request"),
      ],
      [{ kind: "browser-pairing" }, refused(400, "invalid_request")],
      [lineStep("agent", "Keep it short."), refused(409, "step_done")],
    ] as const)
      expect({
        step,
        ...outcome(await patch(o, asker.id, entry.id, { text: "Save?", step })),
      }).toEqual({ step, ...want });
    const stored = await asAgent(
      o,
      asker.id,
      "GET",
      `/api/agents/${asker.id}/asks/${entry.id}`,
    );
    expect((stored.body as AskEntry).step).toEqual({
      ...lineStep("agent", RULE),
      targetId: asker.id,
    });
  });

  it("every other ask keeps its step fixed: no step on a plain ask, no new step on another kind's ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const plain = await asAgent(
      o,
      asker.id,
      "POST",
      `/api/agents/${asker.id}/asks`,
      {
        text: "Ship it?",
      },
    );
    expect(plain.status).toBe(201);
    const pairing = await opened(o, asker.id, { kind: "browser-pairing" });
    for (const id of [(plain.body as AskEntry).id, pairing.id])
      expect(
        outcome(
          await patch(o, asker.id, id, {
            text: "Save?",
            step: lineStep("agent", RULE),
          }),
        ),
      ).toEqual(refused(400, "invalid_request"));
    const stored = await asAgent(
      o,
      asker.id,
      "GET",
      `/api/agents/${asker.id}/asks/${pairing.id}`,
    );
    expect((stored.body as AskEntry).step).toEqual({ kind: "browser-pairing" });
  });

  it("through /mcp: edit_ask takes the new step", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, lineStep("agent", RULE));
    // /mcp is for an agent below Standard.
    const access = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${asker.id}/access`,
      { access: "office" },
    );
    expect(access.status).toBe(200);
    const client = new Client({ name: "instructions-line", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(asker.id)}` },
        },
      }),
    );
    clients.push(client);
    const r = (await client.callTool({
      name: "edit_ask",
      arguments: {
        askId: entry.id,
        step: lineStep("agent", "Always pick the same."),
      },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect({
      isError: !!r.isError,
      text: (r.content ?? []).map((p) => p.text ?? "").join("\n"),
    }).toMatchObject({ isError: false });
    const stored = await asAgent(
      o,
      asker.id,
      "GET",
      `/api/agents/${asker.id}/asks/${entry.id}`,
    );
    expect((stored.body as AskEntry).step).toEqual({
      ...lineStep("agent", "Always pick the same."),
      targetId: asker.id,
    });
  });
});
