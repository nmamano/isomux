// Asks end to end on the real server (internal-docs/asks-design.md):
// an agent opens one through its token, only the member it is for sees and
// answers it, and the answer reaches the agent as that member's message,
// linked to the ask. FakeBackend only.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { askReplyNote } from "../asks.ts";
import { ASK_DISMISSED_TEXT } from "../routes/handlers/asks.ts";
import type { AskEntry, AgentInfo } from "../../shared/types.ts";

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
): Promise<AskEntry & { member: string }> {
  const r = await call(
    w.srv,
    "POST",
    `/api/agents/${w.asker.id}/asks`,
    w.as(w.asker.id),
    { text: `${prompt}\n` },
  );
  expect(r.status).toBe(201);
  return r.body as AskEntry & { member: string };
}

describe("the agent's own list", () => {
  it("opens one for its manager from a text/plain body, and lists, reads, edits and deletes it", async () => {
    const w = await world();
    const created = await open(w, "Pull the spend breakdown?");
    // The heredoc's last line break is not part of the prompt.
    expect(created.prompt).toBe("Pull the spend breakdown?");
    expect(created.memberUserId).toBe(w.ownerId);
    expect(created.member).toBe(w.owner.username);

    const base = `/api/agents/${w.asker.id}/asks`;
    const listed = await call(w.srv, "GET", base, w.as(w.asker.id));
    expect((listed.body as AskEntry[]).map((e) => e.id)).toEqual([created.id]);
    const edited = await call(
      w.srv,
      "PATCH",
      `${base}/${created.id}`,
      w.as(w.asker.id),
      { text: "Pull it per agent?" },
    );
    expect(edited.status).toBe(200);
    expect((edited.body as AskEntry).prompt).toBe("Pull it per agent?");
    const read = await call(
      w.srv,
      "GET",
      `${base}/${created.id}`,
      w.as(w.asker.id),
    );
    expect((read.body as AskEntry).prompt).toBe("Pull it per agent?");

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

  it("never lets one agent's token reach another agent's asks", async () => {
    const w = await world();
    const created = await open(w, "Mine only?");
    const theirs = `/api/agents/${w.asker.id}/asks`;
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
    const own = `/api/agents/${w.other.id}/asks/${created.id}`;
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
      `/api/agents/${w.other.id}/asks`,
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
    expect((read.body as AskEntry).prompt).toBe("Mine only?");
  });

  it("refuses an empty prompt, an unknown member and a full list", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
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

describe("a link to an office page", () => {
  // The stored entry, as the next boot reads it.
  const stored = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (
      JSON.parse(
        readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
      ) as AskEntry[]
    ).find((e) => e.id === id);

  it("takes a link on create and edit, keeps it when an edit omits it, and removes it on link=", async () => {
    const w = await world();
    const ws = await w.srv.connectWs(w.owner.rawSessionId);
    const base = `/api/agents/${w.asker.id}/asks`;
    const made = await call(
      w.srv,
      "POST",
      `${base}?link=/integrations/mcp`,
      w.as(w.asker.id),
      { text: "Sign in to Linear?\n" },
    );
    expect(made.status).toBe(201);
    const id = (made.body as AskEntry).id;
    expect((made.body as AskEntry).link).toBe("/integrations/mcp");
    expect(((await ws.waitFor("ask_upserted")).entry as AskEntry).link).toBe(
      "/integrations/mcp",
    );

    // An edit without a link keeps it.
    const kept = await call(w.srv, "PATCH", `${base}/${id}`, w.as(w.asker.id), {
      text: "Sign in to Linear, please?",
    });
    expect(kept.status).toBe(200);
    expect((kept.body as AskEntry).link).toBe("/integrations/mcp");

    // A JSON edit replaces it.
    const moved = await call(
      w.srv,
      "PATCH",
      `${base}/${id}`,
      w.as(w.asker.id),
      { json: { text: "Pair your Chrome?", link: "/integrations/browser" } },
    );
    expect((moved.body as AskEntry).link).toBe("/integrations/browser");
    expect(stored(w, id)?.link).toBe("/integrations/browser");

    // link= with no value removes the key: from the answer, the push and the
    // file, never an empty string.
    const cleared = await call(
      w.srv,
      "PATCH",
      `${base}/${id}?link=`,
      w.as(w.asker.id),
      { text: "Pair your Chrome now?" },
    );
    expect(cleared.status).toBe(200);
    expect("link" in (cleared.body as object)).toBe(false);
    const pushedClear = () =>
      ws.messages
        .filter((m) => (m as { type?: string }).type === "ask_upserted")
        .map((m) => (m as { entry: AskEntry }).entry)
        .find((e) => e.prompt === "Pair your Chrome now?");
    await waitUntil(() => pushedClear() !== undefined, "the cleared push");
    expect("link" in pushedClear()!).toBe(false);
    expect(stored(w, id)).toBeDefined();
    expect("link" in stored(w, id)!).toBe(false);

    // A JSON create carries one too, and the member's list shows it.
    const json = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "Sign in to Codex?", link: "/integrations/providers" },
    });
    expect(json.status).toBe(201);
    const listed = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    expect(
      (listed.body as AskEntry[]).map((e) => [e.prompt, e.link ?? null]),
    ).toEqual([
      ["Pair your Chrome now?", null],
      ["Sign in to Codex?", "/integrations/providers"],
    ]);
  });

  it("refuses a link that is not an office page, on create and on edit, and changes nothing", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const created = await open(w, "Sign in to Linear?");
    const outside = [
      "https://linear.app",
      "//tasks",
      "/integrations/",
      "/integrations/mcp/",
      "/integrations?tab=mcp",
      "/integrations/constructor",
      "/users",
      "/",
      "constructor",
    ];
    for (const link of outside) {
      const post = await call(
        w.srv,
        "POST",
        `${base}?link=${encodeURIComponent(link)}`,
        w.as(w.asker.id),
        { text: "Where?" },
      );
      expect(`${link} ${post.status} ${post.code}`).toBe(
        `${link} 422 invalid_link`,
      );
      const patch = await call(
        w.srv,
        "PATCH",
        `${base}/${created.id}?link=${encodeURIComponent(link)}`,
        w.as(w.asker.id),
        { text: "Where?" },
      );
      expect(`${link} ${patch.status} ${patch.code}`).toBe(
        `${link} 422 invalid_link`,
      );
    }
    for (const link of [42, null, ""]) {
      const post = await call(w.srv, "POST", base, w.as(w.asker.id), {
        json: { text: "Where?", link },
      });
      expect(`${link} ${post.status} ${post.code}`).toBe(
        `${link} 422 invalid_link`,
      );
    }
    const listed = await call(w.srv, "GET", base, w.as(w.asker.id));
    expect(
      (listed.body as AskEntry[]).map((e) => [e.prompt, e.link ?? null]),
    ).toEqual([["Sign in to Linear?", null]]);
  });

  it("never goes on a secret request", async () => {
    const w = await world();
    const r = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/secret-requests`,
      w.as(w.asker.id),
      {
        json: {
          name: "GH_TOKEN",
          hosts: ["api.github.com"],
          reason: "To open the pull request.",
          link: "/integrations/secrets",
        },
      },
    );
    expect(r.code).toBe("invalid_request");
    const listed = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks`,
      w.as(w.asker.id),
    );
    expect(listed.body).toEqual([]);
  });
});

describe("options the member can tap", () => {
  const stored = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (
      JSON.parse(
        readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
      ) as AskEntry[]
    ).find((e) => e.id === id);

  it("takes options on create and edit, trimmed, keeps them when an edit omits them, and removes them", async () => {
    const w = await world();
    const ws = await w.srv.connectWs(w.owner.rawSessionId);
    const base = `/api/agents/${w.asker.id}/asks`;
    // One option= each, in order, percent-encoded like any query value.
    const made = await call(
      w.srv,
      "POST",
      `${base}?option=${encodeURIComponent(" Jim ")}&option=Dwight&option=${encodeURIComponent("Both, a duet")}`,
      w.as(w.asker.id),
      { text: "Who gives the toast?\n" },
    );
    expect(made.status).toBe(201);
    const id = (made.body as AskEntry).id;
    expect((made.body as AskEntry).options).toEqual([
      "Jim",
      "Dwight",
      "Both, a duet",
    ]);
    expect(
      ((await ws.waitFor("ask_upserted")).entry as AskEntry).options,
    ).toEqual(["Jim", "Dwight", "Both, a duet"]);
    expect(stored(w, id)?.options).toEqual(["Jim", "Dwight", "Both, a duet"]);

    // An edit without options keeps them; a link change leaves them alone.
    const kept = await call(
      w.srv,
      "PATCH",
      `${base}/${id}?link=/tasks`,
      w.as(w.asker.id),
      { text: "Who gives the toast, then?" },
    );
    expect(kept.status).toBe(200);
    expect((kept.body as AskEntry).options).toEqual([
      "Jim",
      "Dwight",
      "Both, a duet",
    ]);

    // A JSON edit replaces them.
    const replaced = await call(
      w.srv,
      "PATCH",
      `${base}/${id}`,
      w.as(w.asker.id),
      { json: { text: "Toast?", options: ["Pam", "Oscar"] } },
    );
    expect((replaced.body as AskEntry).options).toEqual(["Pam", "Oscar"]);
    expect(stored(w, id)?.options).toEqual(["Pam", "Oscar"]);

    // A lone option= removes the key, from the answer and the file.
    const cleared = await call(
      w.srv,
      "PATCH",
      `${base}/${id}?option=`,
      w.as(w.asker.id),
      { text: "Toast now?" },
    );
    expect(cleared.status).toBe(200);
    expect("options" in (cleared.body as object)).toBe(false);
    expect(stored(w, id)).toBeDefined();
    expect("options" in stored(w, id)!).toBe(false);

    // JSON options: [] removes them too.
    await call(w.srv, "PATCH", `${base}/${id}`, w.as(w.asker.id), {
      json: { text: "Toast?", options: ["Pam", "Oscar"] },
    });
    const emptied = await call(
      w.srv,
      "PATCH",
      `${base}/${id}`,
      w.as(w.asker.id),
      { json: { text: "Toast?", options: [] } },
    );
    expect(emptied.status).toBe(200);
    expect("options" in (emptied.body as object)).toBe(false);
    expect("options" in stored(w, id)!).toBe(false);

    // A JSON create carries them, and the member's list shows them.
    const json = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "Ship it?", options: ["Yes", "No"] },
    });
    expect(json.status).toBe(201);
    const listed = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    expect(
      (listed.body as AskEntry[]).map((e) => [e.prompt, e.options ?? null]),
    ).toEqual([
      ["Toast?", null],
      ["Ship it?", ["Yes", "No"]],
    ]);
  });

  it("refuses options that break a rule, on create and on edit, and changes nothing", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const created = await open(w, "Which one?");
    const long = "x".repeat(81);
    const bad: unknown[] = [
      ["Only one"],
      ["A", "B", "C", "D", "E"],
      ["A", "  "],
      ["A", long],
      ["Same", " Same"],
      ["A", 2],
      "A, B",
      null,
    ];
    for (const options of bad) {
      const label = JSON.stringify(options);
      const post = await call(w.srv, "POST", base, w.as(w.asker.id), {
        json: { text: "Which?", options },
      });
      expect(`${label} ${post.status} ${post.code}`).toBe(
        `${label} 422 invalid_options`,
      );
      const patch = await call(
        w.srv,
        "PATCH",
        `${base}/${created.id}`,
        w.as(w.asker.id),
        { json: { text: "Which?", options } },
      );
      expect(`${label} ${patch.status} ${patch.code}`).toBe(
        `${label} 422 invalid_options`,
      );
    }
    // A create has nothing to remove: an empty list is too few.
    for (const [path, body] of [
      [`${base}?option=`, { text: "Which?" }],
      [base, { json: { text: "Which?", options: [] } }],
      [`${base}?option=A&option=`, { text: "Which?" }],
    ] as const) {
      const post = await call(w.srv, "POST", path, w.as(w.asker.id), body);
      expect(`${path} ${post.status} ${post.code}`).toBe(
        `${path} 422 invalid_options`,
      );
    }
    // At the bounds: four options of 80 characters each.
    const four = ["a", "b", "c", "d"].map((c) => c.repeat(80));
    const edge = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "Which?", options: four },
    });
    expect(edge.status).toBe(201);
    expect((edge.body as AskEntry).options).toEqual(four);
    const listed = await call(w.srv, "GET", base, w.as(w.asker.id));
    expect(
      (listed.body as AskEntry[]).map((e) => [e.prompt, e.options ?? null]),
    ).toEqual([
      ["Which one?", null],
      ["Which?", four],
    ]);
  });

  it("never goes on a secret request", async () => {
    const w = await world();
    const owner = { rawSessionId: w.owner.rawSessionId };
    const refused = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/secret-requests`,
      w.as(w.asker.id),
      {
        json: {
          name: "GH_TOKEN",
          hosts: ["api.github.com"],
          reason: "To open the pull request.",
          options: ["Save", "Decline"],
        },
      },
    );
    expect(refused.code).toBe("invalid_request");
    const made = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/secret-requests`,
      w.as(w.asker.id),
      {
        json: {
          name: "GH_TOKEN",
          hosts: ["api.github.com"],
          reason: "To open the pull request.",
        },
      },
    );
    expect(made.status).toBe(200);
    const [entry] = (await call(w.srv, "GET", "/api/asks", owner))
      .body as AskEntry[];
    const edit = await call(
      w.srv,
      "PATCH",
      `/api/agents/${w.asker.id}/asks/${entry.id}`,
      w.as(w.asker.id),
      { json: { text: entry.prompt, options: ["Save", "Decline"] } },
    );
    expect(`${edit.status} ${edit.code}`).toBe("409 secret_request");
    const after = (await call(w.srv, "GET", "/api/asks", owner))
      .body as AskEntry[];
    expect(after.map((e) => [e.id, "options" in e])).toEqual([
      [entry.id, false],
    ]);
  });

  it("answers once when the same option is sent twice at the same time", async () => {
    const w = await world();
    const made = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/asks?option=Jim&option=Dwight`,
      w.as(w.asker.id),
      { text: "Who gives the toast?" },
    );
    const created = made.body as AskEntry;
    const tap = () =>
      call(
        w.srv,
        "POST",
        `/api/asks/${created.id}/reply`,
        { rawSessionId: w.owner.rawSessionId },
        { json: { text: "Dwight" } },
      );
    const results = await Promise.all([tap(), tap()]);
    // One goes through; the other finds the answer in flight or the ask closed.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(204);
    expect([404, 409]).toContain(statuses[1]);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.endsWith("Dwight")),
      "the tap delivered",
    );
    await sleep(50);
    // The option reaches the agent as a typed reply does.
    expect(sentTexts(w.srv, w.asker.id).filter((t) => t.endsWith("Dwight"))).toEqual([
      `[${w.owner.username}] ${askReplyNote(created)}Dwight`,
    ]);
  });
});

describe("the member's answer", () => {
  it("reaches the agent as the member's message, linked to the ask, and closes it", async () => {
    const w = await world();
    const created = await open(w, "Pull the spend breakdown?");
    const r = await call(
      w.srv,
      "POST",
      `/api/asks/${created.id}/reply`,
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
    // The member's label, then the note naming the ask, then the words.
    expect(sent).toBe(
      `[${w.owner.username}] ${askReplyNote(created)}yes, per agent`,
    );
    expect(askReplyNote(created)).toContain(created.id);
    const entry = w.srv.agentManager
      .getAgentLogs(w.asker.id)
      .find(
        (e) => e.kind === "user_message" && e.content === "yes, per agent",
      )!;
    expect(entry.metadata?.ask).toEqual({
      id: created.id,
      prompt: "Pull the spend breakdown?",
    });
    expect(entry.metadata?.username).toBe(w.owner.username);
    const after = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
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
      `/api/asks/${created.id}/dismiss`,
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
    expect(entry.metadata?.ask).toEqual({
      id: created.id,
      prompt: "Book the room?",
      dismissed: true,
    });
    // The agent reads the dismiss note, which is not the reply note.
    const dismissNote = askReplyNote({ ...created, dismissed: true });
    expect(dismissNote).not.toBe(askReplyNote(created));
    expect(sent).toBe(
      `[${w.owner.username}] ${dismissNote}${ASK_DISMISSED_TEXT}`,
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
      `/api/asks/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "1" } },
    );
    expect(r.status).toBe(204);
    expect(session.approvals).toEqual([]);
    expect(agentOf(w.srv, w.asker.id).pendingPrompt).toBe("permission");
    const queued = agentOf(w.srv, w.asker.id).queue ?? [];
    expect(queued.map((m) => m.ask?.id)).toEqual([created.id]);

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
    const delivered = `[${w.owner.username}] ${askReplyNote(created)}1`;
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
      `/api/asks/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "1" } },
    );
    expect(r.status).toBe(204);
    await sleep(100);
    expect(agentOf(w.srv, w.asker.id).pendingPrompt).toBe("model");
    expect(agentOf(w.srv, w.asker.id).modelFamily).toBe(before);
    const queued = agentOf(w.srv, w.asker.id).queue ?? [];
    expect(queued.map((m) => m.ask?.id)).toEqual([created.id]);

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
    const delivered = `[${w.owner.username}] ${askReplyNote(created)}1`;
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
      `/api/asks/${created.id}/reply`,
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
            !!e.metadata?.ask,
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
      `/api/asks/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "yes" } },
    );
    expect(r.status).toBe(204);
    const delivered = `[${w.owner.username}] ${askReplyNote(created)}yes`;
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
      `/api/asks/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "yes" } },
    );
    expect(r.status).toBe(204);
    const delivered = `[${w.owner.username}] ${askReplyNote(created)}yes`;
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
        sender: {
          kind: "agent",
          agentId: w.other.id,
          agentName: "Other",
          roomName: "r",
        },
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
      `/api/asks/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "yes" } },
    );
    expect([reply.status, reply.code]).toEqual([typed.status, typed.code]);
    const still = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
    );
    expect(still.status).toBe(200);
  });

  it("is only for the member it names: anyone else gets 404 and sees nothing", async () => {
    const w = await world();
    const created = await open(w, "Only for Nil?");
    const other = await w.srv.seedMember("Pat");
    const listed = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: other.rawSessionId,
    });
    expect(listed.body).toEqual([]);
    for (const verb of ["reply", "dismiss"]) {
      const r = await call(
        w.srv,
        "POST",
        `/api/asks/${created.id}/${verb}`,
        { rawSessionId: other.rawSessionId },
        { json: verb === "reply" ? { text: "done" } : {} },
      );
      expect(`${verb} ${r.status}`).toBe(`${verb} 404`);
    }
    const mine = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    expect((mine.body as AskEntry[]).map((e) => e.id)).toEqual([created.id]);
  });

  it("names the opening session when the reply reaches a later one", async () => {
    const w = await world();
    const sessionOf = () => w.srv.agentManager.getCurrentSessionId(w.asker.id);
    const reply = async (id: string, text: string) => {
      const r = await call(
        w.srv,
        "POST",
        `/api/asks/${id}/reply`,
        { rawSessionId: w.owner.rawSessionId },
        { json: { text } },
      );
      expect(r.status).toBe(204);
      await waitUntil(
        () => sentTexts(w.srv, w.asker.id).some((t) => t.endsWith(text)),
        `reply ${text} delivered`,
      );
      return sentTexts(w.srv, w.asker.id).find((t) => t.endsWith(text))!;
    };
    const start = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      w.as(w.other.id),
      { text: "start a session" },
    );
    expect(start.status).toBe(200);
    await waitUntil(() => sessionOf() !== null, "first session");
    const opener = sessionOf()!;

    const same = await open(w, "Answered in the same session?");
    // The opening session stays server-side.
    expect("sessionId" in same).toBe(false);
    const stored = JSON.parse(
      readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
    ) as AskEntry[];
    expect(stored.find((e) => e.id === same.id)?.sessionId).toBe(opener);
    expect(await reply(same.id, "same session")).not.toContain(opener);

    const later = await open(w, "Answered after a clear?");
    const cleared = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/new-conversation`,
      w.as(w.asker.id),
      { json: {} },
    );
    expect(cleared.status).toBe(204);
    await waitUntil(() => sessionOf() !== opener, "session cleared");
    const sent = await reply(later.id, "after the clear");
    expect(sent).toContain(opener);
    expect(sent).toContain("Answered after a clear?");
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
      const up = await ws.waitFor("ask_upserted");
      expect((up.entry as AskEntry).id).toBe(created.id);
    }
    await call(
      w.srv,
      "POST",
      `/api/asks/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "done" } },
    );
    for (const ws of [mine, second]) {
      const removed = await ws.waitFor("ask_removed");
      expect(removed.id).toBe(created.id);
    }
    expect(
      theirs.messages.some((m) =>
        String((m as { type?: string }).type).startsWith("ask_"),
      ),
    ).toBe(false);
  });

  it("keeps open asks across a restart, and drops them with their agent", async () => {
    const w = await world();
    const created = await open(w, "Still there?");
    server = await w.srv.restart();
    const owner = { rawSessionId: w.owner.rawSessionId };
    const after = await call(server, "GET", "/api/asks", owner);
    expect((after.body as AskEntry[]).map((e) => e.id)).toEqual([created.id]);
    await server.agentManager.kill(w.asker.id);
    const gone = await call(server, "GET", "/api/asks", owner);
    expect(gone.body).toEqual([]);
  });
});

describe("a secret request is an ask", () => {
  const VALUE = "ghp_FAKEaskrouteFAKEaskrouteFAKEaskroute0";
  const REQUEST = {
    name: "GH_TOKEN",
    hosts: ["api.github.com"],
    reason: "To open the pull request.",
  };

  async function request(
    srv: TestServer,
    agentId: string,
    body: Record<string, unknown> = REQUEST,
  ): Promise<string> {
    const r = await call(
      srv,
      "POST",
      `/api/agents/${agentId}/secret-requests`,
      { bearer: getAgentTokenRaw(agentId)! },
      { json: body },
    );
    expect(r.status).toBe(200);
    return (r.body as { requestId: string }).requestId;
  }

  const save = (
    srv: TestServer,
    agentId: string,
    requestId: string,
    rawSessionId: string,
  ) =>
    call(
      srv,
      "POST",
      `/api/agents/${agentId}/secret-requests/${requestId}/save`,
      { rawSessionId },
      { json: { value: VALUE } },
    );

  it("waits in the manager's asks; a reply, a dismiss and the agent's edit are refused, and a save closes it", async () => {
    const w = await world();
    const ws = await w.srv.connectWs(w.owner.rawSessionId);
    const requestId = await request(w.srv, w.asker.id);
    const owner = { rawSessionId: w.owner.rawSessionId };
    const listed = await call(w.srv, "GET", "/api/asks", owner);
    const [entry] = listed.body as AskEntry[];
    expect(entry.secret?.requestId).toBe(requestId);
    expect(entry.prompt).toBe(REQUEST.reason);
    const up = await ws.waitFor("ask_upserted");
    expect((up.entry as AskEntry).id).toBe(entry.id);
    // The agent sees its request among its asks.
    const own = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks`,
      w.as(w.asker.id),
    );
    expect(own.body).toMatchObject([
      { id: entry.id, member: w.owner.username },
    ]);
    // A reply would carry what the member typed to the chat: refused, and
    // the request stays open.
    for (const [verb, json] of [
      ["reply", { text: VALUE }],
      ["dismiss", {}],
    ] as const) {
      const r = await call(
        w.srv,
        "POST",
        `/api/asks/${entry.id}/${verb}`,
        owner,
        { json },
      );
      expect(`${verb} ${r.status} ${r.code}`).toBe(
        `${verb} 409 secret_request`,
      );
      expect(JSON.stringify(r.body)).not.toContain(VALUE);
    }
    const edit = await call(
      w.srv,
      "PATCH",
      `/api/agents/${w.asker.id}/asks/${entry.id}`,
      w.as(w.asker.id),
      { text: "Another reason" },
    );
    expect(`${edit.status} ${edit.code}`).toBe("409 secret_request");
    expect(sentTexts(w.srv, w.asker.id).some((t) => t.includes(VALUE))).toBe(
      false,
    );

    const saved = await save(
      w.srv,
      w.asker.id,
      requestId,
      w.owner.rawSessionId,
    );
    expect(saved.status).toBe(200);
    expect((await ws.waitFor("ask_removed")).id).toBe(entry.id);
    expect((await call(w.srv, "GET", "/api/asks", owner)).body).toEqual([]);
    // No log entry and no frame to the member holds the value.
    expect(
      JSON.stringify(w.srv.agentManager.getAgentLogs(w.asker.id)),
    ).not.toContain(VALUE);
    expect(JSON.stringify(ws.messages)).not.toContain(VALUE);
  });

  it("an office request goes to every owner who can reach the room, not to the agent's manager", async () => {
    const w = await world();
    const pat = await w.srv.seedMember("Pat");
    const patId = getUserByName(pat.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
    // Pat manages this agent.
    const info = await w.srv.agentManager.spawn(
      "Pats",
      w.srv.stateRoot,
      "default",
      undefined,
      undefined,
      w.room.id,
      undefined,
      undefined,
      undefined,
      undefined,
      "claude",
      undefined,
      patId,
    );
    const agentId = info!.id;
    const personal = await request(w.srv, agentId);
    const office = await request(w.srv, agentId, {
      ...REQUEST,
      name: "OFFICE_TOKEN",
      scope: "office",
    });
    const ids = async (rawSessionId: string) =>
      (
        (await call(w.srv, "GET", "/api/asks", { rawSessionId }))
          .body as AskEntry[]
      ).map((e) => e.secret?.requestId);
    expect(await ids(pat.rawSessionId)).toEqual([personal]);
    expect(await ids(w.owner.rawSessionId)).toEqual([office]);
    // The agent reads no member on the office request.
    const own = await call(w.srv, "GET", `/api/agents/${agentId}/asks`, {
      bearer: getAgentTokenRaw(agentId)!,
    });
    expect(
      (own.body as (AskEntry & { member: string | null })[]).map((e) => [
        e.secret?.requestId,
        e.member,
      ]),
    ).toEqual([
      [personal, pat.username],
      [office, null],
    ]);
    expect((await save(w.srv, agentId, office, pat.rawSessionId)).status).toBe(
      403,
    );
    expect(
      (await save(w.srv, agentId, personal, w.owner.rawSessionId)).status,
    ).toBe(403);
    expect(
      (await save(w.srv, agentId, office, w.owner.rawSessionId)).status,
    ).toBe(200);
    expect(await ids(w.owner.rawSessionId)).toEqual([]);
  });

  it("survives a restart: the member saves after it, and the agent is told", async () => {
    const w = await world();
    const requestId = await request(w.srv, w.asker.id);
    server = await w.srv.restart();
    const after = await call(server, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    expect((after.body as AskEntry[]).map((e) => e.secret?.requestId)).toEqual([
      requestId,
    ]);
    const saved = await save(
      server,
      w.asker.id,
      requestId,
      w.owner.rawSessionId,
    );
    expect(saved.status).toBe(200);
    const srv = server;
    await waitUntil(
      () =>
        sentTexts(srv, w.asker.id).some((t) =>
          t.includes(`I saved the secret ${REQUEST.name}`),
        ),
      "the agent is told",
    );
  });

  it("the agent's delete withdraws it: a later save finds nothing", async () => {
    const w = await world();
    const requestId = await request(w.srv, w.asker.id);
    const [entry] = (
      await call(
        w.srv,
        "GET",
        `/api/agents/${w.asker.id}/asks`,
        w.as(w.asker.id),
      )
    ).body as AskEntry[];
    const deleted = await call(
      w.srv,
      "DELETE",
      `/api/agents/${w.asker.id}/asks/${entry.id}`,
      w.as(w.asker.id),
    );
    expect(deleted.status).toBe(204);
    expect(
      (await save(w.srv, w.asker.id, requestId, w.owner.rawSessionId)).status,
    ).toBe(404);
  });
});
