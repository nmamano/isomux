// Actionables end to end on the real server (internal-docs/actionables-design.md):
// an agent opens one through its token, only the member it is for sees and
// answers it, and the answer reaches the agent as that member's message,
// linked to the actionable. FakeBackend only.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { actionableReplyNote } from "../actionables.ts";
import { ACTIONABLE_DISMISSED_TEXT } from "../routes/handlers/actionables.ts";
import type { ActionableEntry, AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

type Res = { status: number; code?: string; body: unknown };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: { bearer?: string; rawSessionId?: string },
  body?: { json?: unknown; text?: string },
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  let payload: string | undefined;
  if (body?.text !== undefined) {
    headers["Content-Type"] = "text/plain";
    payload = body.text;
  } else if (body?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  }
  const res = await srv.http(path, {
    method,
    headers,
    body: payload,
    rawSessionId: auth.rawSessionId,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    body: parsed,
  };
}

// Every turn completes at once, except one whose text holds "hold", which
// stays busy until the test pushes its end.
function backend(): FakeBackend {
  return new FakeBackend({
    storedSessionState: "durable",
    session: {
      onSend: (text, _a, s) => {
        if (!text.includes("hold")) s.completeTurn({ text: "ok" });
      },
    },
  });
}

function agentOf(srv: TestServer, id: string): AgentInfo {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not found`);
  return a;
}

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

async function world() {
  server = await startTestServer({ fakeBackend: backend() });
  const owner = await server.seedOwner("Nil");
  const ownerId = getUserByName(owner.username)!.id;
  const [room] = server.agentManager.getRooms();
  const spawn = async (name: string) => {
    const info = await server!.agentManager.spawn(
      name,
      server!.stateRoot,
      "default",
      undefined,
      undefined,
      room.id,
      undefined,
      undefined,
      undefined,
      undefined,
      "claude",
      undefined,
      ownerId,
    );
    if (!info) throw new Error(`spawn ${name} failed`);
    return info;
  };
  const asker = await spawn("Asker");
  const other = await spawn("Other");
  const as = (agentId: string) => ({ bearer: getAgentTokenRaw(agentId)! });
  return { srv: server, owner, ownerId, room, asker, other, as };
}

async function open(
  w: Awaited<ReturnType<typeof world>>,
  prompt: string,
): Promise<ActionableEntry & { member: string }> {
  const r = await call(
    w.srv,
    "POST",
    `/api/agents/${w.asker.id}/actionables`,
    w.as(w.asker.id),
    { text: `${prompt}\n` },
  );
  expect(r.status).toBe(201);
  return r.body as ActionableEntry & { member: string };
}

describe("the agent's own list", () => {
  it("opens one for its manager from a text/plain body, and lists, reads, edits and deletes it", async () => {
    const w = await world();
    const created = await open(w, "Pull the spend breakdown?");
    // The heredoc's last line break is not part of the prompt.
    expect(created.prompt).toBe("Pull the spend breakdown?");
    expect(created.memberUserId).toBe(w.ownerId);
    expect(created.member).toBe(w.owner.username);

    const base = `/api/agents/${w.asker.id}/actionables`;
    const listed = await call(w.srv, "GET", base, w.as(w.asker.id));
    expect((listed.body as ActionableEntry[]).map((e) => e.id)).toEqual([
      created.id,
    ]);
    const edited = await call(
      w.srv,
      "PATCH",
      `${base}/${created.id}`,
      w.as(w.asker.id),
      { text: "Pull it per agent?" },
    );
    expect(edited.status).toBe(200);
    expect((edited.body as ActionableEntry).prompt).toBe("Pull it per agent?");
    const read = await call(
      w.srv,
      "GET",
      `${base}/${created.id}`,
      w.as(w.asker.id),
    );
    expect((read.body as ActionableEntry).prompt).toBe("Pull it per agent?");

    const deleted = await call(
      w.srv,
      "DELETE",
      `${base}/${created.id}`,
      w.as(w.asker.id),
    );
    expect(deleted.status).toBe(204);
    const gone = await call(
      w.srv,
      "GET",
      `${base}/${created.id}`,
      w.as(w.asker.id),
    );
    expect(gone.status).toBe(404);
  });

  it("never lets one agent's token reach another agent's actionables", async () => {
    const w = await world();
    const created = await open(w, "Mine only?");
    const theirs = `/api/agents/${w.asker.id}/actionables`;
    // Through the owner's path: the guard refuses a token that is not :id.
    for (const [method, path, body] of [
      ["GET", theirs, undefined],
      ["POST", theirs, { text: "spoof" }],
      ["GET", `${theirs}/${created.id}`, undefined],
      ["PATCH", `${theirs}/${created.id}`, { text: "spoof" }],
      ["DELETE", `${theirs}/${created.id}`, undefined],
    ] as const) {
      const r = await call(w.srv, method, path, w.as(w.other.id), body);
      expect(`${method} ${r.status}`).toBe(`${method} 403`);
    }
    // Through its own path with the other agent's id: not its entry.
    const own = `/api/agents/${w.other.id}/actionables/${created.id}`;
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { text: "spoof" }],
      ["DELETE", undefined],
    ] as const) {
      const r = await call(w.srv, method, own, w.as(w.other.id), body);
      expect(`${method} ${r.status}`).toBe(`${method} 404`);
    }
    const listed = await call(
      w.srv,
      "GET",
      `/api/agents/${w.other.id}/actionables`,
      w.as(w.other.id),
    );
    expect(listed.body).toEqual([]);
    // The entry is untouched.
    const read = await call(
      w.srv,
      "GET",
      `${theirs}/${created.id}`,
      w.as(w.asker.id),
    );
    expect((read.body as ActionableEntry).prompt).toBe("Mine only?");
  });

  it("refuses an empty prompt, an unknown member and a full list", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/actionables`;
    const empty = await call(w.srv, "POST", base, w.as(w.asker.id), {
      text: "  ",
    });
    expect(empty.status).toBe(400);
    const unknown = await call(
      w.srv,
      "POST",
      `${base}?member=nobody`,
      w.as(w.asker.id),
      { text: "For whom?" },
    );
    expect(unknown.code).toBe("unknown_member");
    for (let i = 0; i < 50; i++) await open(w, `Question ${i}?`);
    const full = await call(w.srv, "POST", base, w.as(w.asker.id), {
      text: "One more?",
    });
    expect(full.status).toBe(429);
  });
});

describe("the member's answer", () => {
  it("reaches the agent as the member's message, linked to the actionable, and closes it", async () => {
    const w = await world();
    const created = await open(w, "Pull the spend breakdown?");
    const r = await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "yes, per agent" } },
    );
    expect(r.status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes("per agent")),
      "reply delivered",
    );
    const sent = sentTexts(w.srv, w.asker.id).find((t) =>
      t.includes("per agent"),
    )!;
    // The member's label, then the note naming the actionable, then the words.
    expect(sent).toBe(
      `[${w.owner.username}] ${actionableReplyNote(created)}yes, per agent`,
    );
    expect(actionableReplyNote(created)).toContain(created.id);
    const entry = w.srv.agentManager
      .getAgentLogs(w.asker.id)
      .find((e) => e.kind === "user_message" && e.content === "yes, per agent")!;
    expect(entry.metadata?.actionable).toEqual({
      id: created.id,
      prompt: "Pull the spend breakdown?",
    });
    expect(entry.metadata?.username).toBe(w.owner.username);
    const after = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/actionables/${created.id}`,
      w.as(w.asker.id),
    );
    expect(after.status).toBe(404);
  });

  it("sends a dismiss as a member message too, marked as dismissed", async () => {
    const w = await world();
    const created = await open(w, "Book the room?");
    const r = await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/dismiss`,
      { rawSessionId: w.owner.rawSessionId },
      { json: {} },
    );
    expect(r.status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(created.id)),
      "dismiss delivered",
    );
    const sent = sentTexts(w.srv, w.asker.id).find((t) =>
      t.includes(created.id),
    )!;
    const entry = w.srv.agentManager
      .getAgentLogs(w.asker.id)
      .find((e) => e.kind === "user_message")!;
    expect(entry.metadata?.actionable).toEqual({
      id: created.id,
      prompt: "Book the room?",
      dismissed: true,
    });
    // The agent reads the dismiss note, which is not the reply note.
    const dismissNote = actionableReplyNote({ ...created, dismissed: true });
    expect(dismissNote).not.toBe(actionableReplyNote(created));
    expect(sent).toBe(
      `[${w.owner.username}] ${dismissNote}${ACTIONABLE_DISMISSED_TEXT}`,
    );
  });

  it("is never read as the answer to a pending permission prompt, and waits for it", async () => {
    const w = await world();
    const created = await open(w, "Proceed?");
    // Park the agent on a permission prompt inside a held turn.
    const start = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "hold on" } },
    );
    expect(start.status).toBe(200);
    await waitUntil(
      () => w.srv.fakeBackend.sessionForAgent(w.asker.id) !== undefined,
      "session",
    );
    const session = w.srv.fakeBackend.sessionForAgent(w.asker.id)!;
    session.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "ls" },
    });
    await waitUntil(
      () => agentOf(w.srv, w.asker.id).pendingPrompt === "permission",
      "parked",
    );
    // "1" would allow the tool if it were read as the prompt's answer.
    const r = await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "1" } },
    );
    expect(r.status).toBe(204);
    expect(session.approvals).toEqual([]);
    expect(agentOf(w.srv, w.asker.id).pendingPrompt).toBe("permission");
    const queued = agentOf(w.srv, w.asker.id).queue ?? [];
    expect(queued.map((m) => m.actionable?.id)).toEqual([created.id]);

    // The member answers the prompt, and the turn ends: the reply goes out,
    // with its note, on the flush that follows.
    await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "1" } },
    );
    await waitUntil(() => session.approvals.length === 1, "approved");
    session.completeTurn({ text: "done" });
    const delivered = `[${w.owner.username}] ${actionableReplyNote(created)}1`;
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(delivered)),
      "reply flushed after the prompt",
    );
  });

  it("is never read as a pick on an idle /model prompt, and waits for it", async () => {
    const w = await world();
    const created = await open(w, "Which model?");
    const start = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "/model" } },
    );
    expect(start.status).toBe(200);
    await waitUntil(
      () => agentOf(w.srv, w.asker.id).pendingPrompt === "model",
      "parked on the model pick",
    );
    const before = agentOf(w.srv, w.asker.id).modelFamily;
    // "1" picks the first model if it is read as the prompt's answer.
    const r = await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "1" } },
    );
    expect(r.status).toBe(204);
    await sleep(100);
    expect(agentOf(w.srv, w.asker.id).pendingPrompt).toBe("model");
    expect(agentOf(w.srv, w.asker.id).modelFamily).toBe(before);
    const queued = agentOf(w.srv, w.asker.id).queue ?? [];
    expect(queued.map((m) => m.actionable?.id)).toEqual([created.id]);

    // The member picks a model. The flow ends on an idle agent, and the reply
    // goes out with no other message needed.
    const pick = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "1" } },
    );
    expect(pick.status).toBe(200);
    const delivered = `[${w.owner.username}] ${actionableReplyNote(created)}1`;
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(delivered)),
      "reply flushed after the pick",
    );
    expect(agentOf(w.srv, w.asker.id).queue ?? []).toEqual([]);
  });

  it("sends a reply that starts with a slash as text, not as a command", async () => {
    const w = await world();
    const created = await open(w, "Which command?");
    const r = await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "/clear" } },
    );
    expect(r.status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.endsWith("/clear")),
      "slash text delivered",
    );
    expect(
      w.srv.agentManager
        .getAgentLogs(w.asker.id)
        .some(
          (e) =>
            e.kind === "user_message" &&
            e.content === "/clear" &&
            !!e.metadata?.actionable,
        ),
    ).toBe(true);
  });

  it("wakes a released agent, as a typed message does", async () => {
    const w = await world();
    const created = await open(w, "Still awake?");
    await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "wake" } },
    );
    await waitUntil(
      () => agentOf(w.srv, w.asker.id).state === "waiting_for_response",
      "first turn done",
    );
    expect(await w.srv.agentManager.demoteToLazy(w.asker.id)).toBe(true);
    expect(agentOf(w.srv, w.asker.id).dormant).toBe(true);
    const r = await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "yes" } },
    );
    expect(r.status).toBe(204);
    const delivered = `[${w.owner.username}] ${actionableReplyNote(created)}yes`;
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).includes(delivered),
      "reply woke the agent",
    );
    expect(agentOf(w.srv, w.asker.id).dormant ?? false).toBe(false);
  });

  it("resumes an errored agent, as a typed message does", async () => {
    const w = await world();
    const created = await open(w, "Back up?");
    await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "hold on" } },
    );
    await waitUntil(
      () => agentOf(w.srv, w.asker.id).state === "thinking",
      "busy",
    );
    w.srv.fakeBackend.sessionForAgent(w.asker.id)!.push({
      kind: "error",
      message: "Claude Code process exited with code 143",
    });
    await waitUntil(
      () => agentOf(w.srv, w.asker.id).state === "error",
      "errored",
    );
    const r = await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "yes" } },
    );
    expect(r.status).toBe(204);
    const delivered = `[${w.owner.username}] ${actionableReplyNote(created)}yes`;
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).includes(delivered),
      "reply resumed the agent",
    );
    expect(agentOf(w.srv, w.asker.id).state).not.toBe("error");
  });

  it("is refused where a typed message is, with the same reason, and stays open", async () => {
    const w = await world();
    const created = await open(w, "Full?");
    await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "hold on" } },
    );
    await waitUntil(
      () => agentOf(w.srv, w.asker.id).state === "thinking",
      "busy",
    );
    // Fill the busy agent's queue.
    for (let i = 0; ; i++) {
      const r = w.srv.agentManager.enqueueMessage(w.asker.id, {
        sender: { kind: "agent", agentId: w.other.id, agentName: "Other", roomName: "r" },
        text: `filler ${i}`,
      });
      if (!r.ok) break;
    }
    const typed = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "typed" } },
    );
    expect(typed.status).toBe(429);
    const reply = await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "yes" } },
    );
    expect([reply.status, reply.code]).toEqual([typed.status, typed.code]);
    const still = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/actionables/${created.id}`,
      w.as(w.asker.id),
    );
    expect(still.status).toBe(200);
  });

  it("is only for the member it names: anyone else gets 404 and sees nothing", async () => {
    const w = await world();
    const created = await open(w, "Only for Nil?");
    const other = await w.srv.seedMember("Pat");
    const listed = await call(w.srv, "GET", "/api/actionables", {
      rawSessionId: other.rawSessionId,
    });
    expect(listed.body).toEqual([]);
    for (const verb of ["reply", "dismiss"]) {
      const r = await call(
        w.srv,
        "POST",
        `/api/actionables/${created.id}/${verb}`,
        { rawSessionId: other.rawSessionId },
        { json: verb === "reply" ? { text: "done" } : {} },
      );
      expect(`${verb} ${r.status}`).toBe(`${verb} 404`);
    }
    const mine = await call(w.srv, "GET", "/api/actionables", {
      rawSessionId: w.owner.rawSessionId,
    });
    expect((mine.body as ActionableEntry[]).map((e) => e.id)).toEqual([
      created.id,
    ]);
  });
});

describe("live and durable", () => {
  it("pushes a create, an edit and a close to the member's sockets only", async () => {
    const w = await world();
    const pat = await w.srv.seedMember("Pat");
    const mine = await w.srv.connectWs(w.owner.rawSessionId);
    const second = await w.srv.connectWs(w.owner.rawSessionId);
    const theirs = await w.srv.connectWs(pat.rawSessionId);
    const created = await open(w, "Live?");
    for (const ws of [mine, second]) {
      const up = await ws.waitFor("actionable_upserted");
      expect((up.entry as ActionableEntry).id).toBe(created.id);
    }
    await call(
      w.srv,
      "POST",
      `/api/actionables/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "done" } },
    );
    for (const ws of [mine, second]) {
      const removed = await ws.waitFor("actionable_removed");
      expect(removed.id).toBe(created.id);
    }
    expect(
      theirs.messages.some((m) =>
        String((m as { type?: string }).type).startsWith("actionable_"),
      ),
    ).toBe(false);
  });

  it("keeps open actionables across a restart, and drops them with their agent", async () => {
    const w = await world();
    const created = await open(w, "Still there?");
    server = await w.srv.restart();
    const owner = { rawSessionId: w.owner.rawSessionId };
    const after = await call(server, "GET", "/api/actionables", owner);
    expect((after.body as ActionableEntry[]).map((e) => e.id)).toEqual([
      created.id,
    ]);
    await server.agentManager.kill(w.asker.id);
    const gone = await call(server, "GET", "/api/actionables", owner);
    expect(gone.body).toEqual([]);
  });
});
