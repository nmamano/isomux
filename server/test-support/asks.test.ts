// Asks end to end on the real server (internal-docs/asks-design.md):
// an agent opens one through its token, only the member it is for sees and
// answers it, and the answer reaches the agent as that member's message,
// linked to the ask. FakeBackend only.

import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { askReplyNote } from "../asks.ts";
import { ASK_DISMISSED_TEXT } from "../routes/handlers/asks.ts";
import type { AskEntry, AgentInfo } from "../../shared/types.ts";
import type { AskAgentWire } from "../../shared/contract-shapes.ts";

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

// An ask's link to an agent's chat (task 9aaec0eb): the agent must exist
// and the ask's member must reach its room, on create and on edit.
describe("a link to an agent", () => {
  // Pat reaches the asker's room only; Far sits in a room Pat cannot reach.
  async function farWorld() {
    const w = await world();
    const elsewhere = w.srv.agentManager.createRoom("Elsewhere");
    const far = await w.srv.agentManager.spawn(
      "Far",
      w.srv.stateRoot,
      "default",
      undefined,
      undefined,
      elsewhere,
      undefined,
      undefined,
      undefined,
      undefined,
      "claude",
      undefined,
      w.ownerId,
    );
    if (!far) throw new Error("spawn Far failed");
    const pat = await w.srv.seedMember("Pat");
    const patId = getUserByName(pat.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
    return { ...w, far, pat };
  }
  const links = async (w: Awaited<ReturnType<typeof farWorld>>) =>
    (
      (
        await call(
          w.srv,
          "GET",
          `/api/agents/${w.asker.id}/asks`,
          w.as(w.asker.id),
        )
      ).body as AskEntry[]
    ).map((e) => [e.prompt, e.link ?? null]);

  it("takes an agent the member reaches, in any room, on create and on edit", async () => {
    const w = await farWorld();
    const base = `/api/agents/${w.asker.id}/asks`;
    // The manager reaches every room, Far's too.
    const far = await call(
      w.srv,
      "POST",
      `${base}?link=/agents/${w.far.id}`,
      w.as(w.asker.id),
      { text: "Say go in Far's chat?" },
    );
    expect(`${far.status} ${far.code}`).toBe("201 undefined");
    expect((far.body as AskEntry).link).toBe(`/agents/${w.far.id}`);
    // Pat reaches the asker's room, so Other's chat.
    const other = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: {
        text: "Say go in Other's chat?",
        member: w.pat.username,
        link: `/agents/${w.other.id}`,
      },
    });
    expect(`${other.status} ${other.code}`).toBe("201 undefined");
    // An edit moves a page link to an agent.
    const paged = await call(
      w.srv,
      "POST",
      `${base}?link=/tasks`,
      w.as(w.asker.id),
      { text: "Look at the board?" },
    );
    const id = (paged.body as AskEntry).id;
    const edited = await call(
      w.srv,
      "PATCH",
      `${base}/${id}?link=/agents/${w.far.id}`,
      w.as(w.asker.id),
      { text: "Look at Far's chat?" },
    );
    expect(`${edited.status} ${edited.code}`).toBe("200 undefined");
    expect(await links(w)).toEqual([
      ["Say go in Far's chat?", `/agents/${w.far.id}`],
      ["Say go in Other's chat?", `/agents/${w.other.id}`],
      ["Look at Far's chat?", `/agents/${w.far.id}`],
    ]);
  });

  it("refuses an unknown agent and an agent the member cannot reach, on create and on edit, and changes nothing", async () => {
    const w = await farWorld();
    const base = `/api/agents/${w.asker.id}/asks`;
    // Pat's open ask, with a link to an agent Pat reaches.
    const pats = await call(
      w.srv,
      "POST",
      `${base}?member=${w.pat.username}&link=/agents/${w.other.id}`,
      w.as(w.asker.id),
      { text: "Say go in Other's chat?" },
    );
    expect(pats.status).toBe(201);
    const id = (pats.body as AskEntry).id;
    const refused: string[] = [];
    for (const [member, link] of [
      [w.owner.username, "/agents/agent-gone"],
      [w.pat.username, "/agents/agent-gone"],
      [w.pat.username, `/agents/${w.far.id}`],
    ]) {
      const post = await call(
        w.srv,
        "POST",
        `${base}?member=${member}&link=${encodeURIComponent(link)}`,
        w.as(w.asker.id),
        { text: "Where?" },
      );
      refused.push(`create ${member} ${link} ${post.status} ${post.code}`);
    }
    // The edit checks against the ask's member, Pat, not the manager.
    for (const link of ["/agents/agent-gone", `/agents/${w.far.id}`]) {
      const patch = await call(
        w.srv,
        "PATCH",
        `${base}/${id}`,
        w.as(w.asker.id),
        { json: { text: "Where?", link } },
      );
      refused.push(`edit ${link} ${patch.status} ${patch.code}`);
    }
    expect(refused).toEqual([
      `create ${w.owner.username} /agents/agent-gone 422 invalid_link`,
      `create ${w.pat.username} /agents/agent-gone 422 invalid_link`,
      `create ${w.pat.username} /agents/${w.far.id} 422 invalid_link`,
      `edit /agents/agent-gone 422 invalid_link`,
      `edit /agents/${w.far.id} 422 invalid_link`,
    ]);
    expect(await links(w)).toEqual([
      ["Say go in Other's chat?", `/agents/${w.other.id}`],
    ]);
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
    expect(
      sentTexts(w.srv, w.asker.id).filter((t) => t.endsWith("Dwight")),
    ).toEqual([`[${w.owner.username}] ${askReplyNote(created)}Dwight`]);
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

  it("sends the text the member typed with a dismiss, still marked as dismissed", async () => {
    const w = await world();
    const created = await open(w, "Book the room?");
    const r = await call(
      w.srv,
      "POST",
      `/api/asks/${created.id}/dismiss`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "We moved it to Friday." } },
    );
    expect(r.status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(created.id)),
      "dismiss delivered",
    );
    const sent = sentTexts(w.srv, w.asker.id).find((t) =>
      t.includes(created.id),
    )!;
    const dismissNote = askReplyNote({ ...created, dismissed: true });
    // The typed text takes the place of the bare word, under the dismiss note.
    expect(sent).toBe(
      `[${w.owner.username}] ${dismissNote}We moved it to Friday.`,
    );
    const entry = w.srv.agentManager
      .getAgentLogs(w.asker.id)
      .find((e) => e.kind === "user_message")!;
    expect(entry.content).toBe("We moved it to Friday.");
    expect(entry.metadata?.ask).toEqual({
      id: created.id,
      prompt: "Book the room?",
      dismissed: true,
    });
  });

  it("refuses a dismiss text that is not a string and leaves the ask open; a blank one is a bare dismiss", async () => {
    const w = await world();
    const created = await open(w, "Book the room?");
    const dismiss = (json: unknown) =>
      call(
        w.srv,
        "POST",
        `/api/asks/${created.id}/dismiss`,
        { rawSessionId: w.owner.rawSessionId },
        { json },
      );
    const refused = await dismiss({ text: 5 });
    expect([refused.status, refused.code]).toEqual([400, "invalid_text"]);
    const still = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
    );
    expect(still.status).toBe(200);
    expect(sentTexts(w.srv, w.asker.id)).toEqual([]);

    const blank = await dismiss({ text: " \n " });
    expect(blank.status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(created.id)),
      "dismiss delivered",
    );
    const dismissNote = askReplyNote({ ...created, dismissed: true });
    expect(sentTexts(w.srv, w.asker.id)).toEqual([
      `[${w.owner.username}] ${dismissNote}${ASK_DISMISSED_TEXT}`,
    ]);
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

describe("chat affordances on an ask", () => {
  // The case that prompted the task: a git command with spaces, && and dashes.
  const CMD = "git branch -D t-a t-b && git push origin --delete t-a t-b";
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const stored = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (
      JSON.parse(
        readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
      ) as AskEntry[]
    ).find((e) => e.id === id);
  // Files in the agent's cwd, which is the temp state root.
  function seed(w: Awaited<ReturnType<typeof world>>) {
    const cwd = agentOf(w.srv, w.asker.id).cwd;
    writeFileSync(join(cwd, "plot.png"), PNG);
    writeFileSync(join(cwd, "notes.md"), "# notes\n");
    writeFileSync(join(cwd, "other.md"), "other\n");
    writeFileSync(join(cwd, "third.md"), "third\n");
    return cwd;
  }
  const filesDir = (w: Awaited<ReturnType<typeof world>>) => {
    const dir = join(w.srv.stateRoot, "logs", w.asker.id, "files");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };
  const affordances = (e: AskEntry) => ({
    commands: e.commands ?? null,
    editFiles: e.editFiles ?? null,
    readFiles:
      e.readFiles?.map((a) => [a.originalName, a.mediaType, a.size]) ?? null,
  });

  it("takes a command, an editor file and a read file through the query, and the member sees them", async () => {
    const w = await world();
    const cwd = seed(w);
    const ws = await w.srv.connectWs(w.owner.rawSessionId);
    const base = `/api/agents/${w.asker.id}/asks`;
    const made = await call(
      w.srv,
      "POST",
      `${base}?command=${encodeURIComponent(`${CMD}  `)}&editFile=notes.md&readFile=plot.png&readFile=${encodeURIComponent(join(cwd, "notes.md"))}`,
      w.as(w.asker.id),
      { text: "Delete the merged branches?\n" },
    );
    expect(made.status).toBe(201);
    const entry = made.body as AskEntry;
    // Trailing whitespace trimmed; a relative path resolves against the
    // agent's cwd; the list keeps its order.
    const want = {
      commands: [CMD],
      editFiles: [{ cwd, path: join(cwd, "notes.md") }],
      readFiles: [
        ["plot.png", "image/png", PNG.length],
        ["notes.md", expect.any(String), 8],
      ],
    };
    expect(affordances(entry)).toEqual(want);
    expect(
      affordances((await ws.waitFor("ask_upserted")).entry as AskEntry),
    ).toEqual(want);
    expect(affordances(stored(w, entry.id)!)).toEqual(want);
    const [listed] = (
      await call(w.srv, "GET", "/api/asks", {
        rawSessionId: w.owner.rawSessionId,
      })
    ).body as AskEntry[];
    expect(affordances(listed)).toEqual(want);

    // The chip is a snapshot: the agent rewrites the file after the ask, and
    // the member still gets the bytes the agent meant.
    writeFileSync(join(cwd, "plot.png"), "changed");
    const res = await w.srv.http(
      `/api/files/${w.asker.id}/${entry.readFiles![0].filename}`,
      { method: "GET", rawSessionId: w.owner.rawSessionId },
    );
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("takes them as JSON too, with absolute paths", async () => {
    const w = await world();
    const cwd = seed(w);
    const made = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/asks`,
      w.as(w.asker.id),
      {
        json: {
          text: "Look?",
          commands: ["bun test", "ls -la\t"],
          editFiles: [join(cwd, "notes.md")],
          readFiles: [join(cwd, "plot.png")],
        },
      },
    );
    expect(made.status).toBe(201);
    expect(affordances(made.body as AskEntry)).toEqual({
      commands: ["bun test", "ls -la"],
      editFiles: [{ cwd, path: join(cwd, "notes.md") }],
      readFiles: [["plot.png", "image/png", PNG.length]],
    });
  });

  it("an edit keeps a list it omits, replaces one it sends, and removes one with [] or a lone empty value", async () => {
    const w = await world();
    const cwd = seed(w);
    const base = `/api/agents/${w.asker.id}/asks`;
    const made = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: {
        text: "Look?",
        commands: [CMD],
        editFiles: ["notes.md"],
        readFiles: ["plot.png"],
      },
    });
    const id = (made.body as AskEntry).id;
    const patch = (path: string, body: { json?: unknown; text?: string }) =>
      call(w.srv, "PATCH", `${base}/${id}${path}`, w.as(w.asker.id), body);
    const full = affordances(made.body as AskEntry);

    // Text only, and a link change: all three stay.
    expect(
      affordances((await patch("", { text: "Look now?" })).body as AskEntry),
    ).toEqual(full);
    expect(
      affordances(
        (await patch("?link=/tasks", { text: "Look?" })).body as AskEntry,
      ),
    ).toEqual(full);

    // A list replaces that list only. A new read file is a new snapshot.
    writeFileSync(join(cwd, "plot.png"), Buffer.concat([PNG, PNG]));
    const replaced = await patch("", {
      json: {
        text: "Look?",
        commands: ["bun test"],
        readFiles: ["plot.png"],
      },
    });
    expect(replaced.status).toBe(200);
    expect(affordances(replaced.body as AskEntry)).toEqual({
      commands: ["bun test"],
      editFiles: full.editFiles,
      readFiles: [["plot.png", "image/png", PNG.length * 2]],
    });
    const query = await patch(`?editFile=other.md&editFile=notes.md`, {
      text: "Look?",
    });
    expect((query.body as AskEntry).editFiles).toEqual([
      { cwd, path: join(cwd, "other.md") },
      { cwd, path: join(cwd, "notes.md") },
    ]);

    // Removal deletes the key, from the answer and from the file.
    const noCommands = await patch("?command=", { text: "Look?" });
    expect(noCommands.status).toBe(200);
    expect("commands" in (noCommands.body as object)).toBe(false);
    expect("commands" in stored(w, id)!).toBe(false);
    const noEdit = await patch("", { json: { text: "Look?", editFiles: [] } });
    expect("editFiles" in (noEdit.body as object)).toBe(false);
    const noRead = await patch("?readFile=", { text: "Look?" });
    expect("readFiles" in (noRead.body as object)).toBe(false);
    expect(stored(w, id)).toBeDefined();
    expect(
      ["commands", "editFiles", "readFiles"].filter((k) => k in stored(w, id)!),
    ).toEqual([]);
  });

  it("refuses a bad affordance with its own code, on create and on edit, and changes nothing", async () => {
    const w = await world();
    const cwd = seed(w);
    mkdirSync(join(cwd, "adir"), { recursive: true });
    writeFileSync(join(cwd, "blob.bin"), Buffer.from([0, 1, 0, 2, 0, 3]));
    // One byte over the editor's 1 MB cap, and over read-file's 20 MB cap
    // (sparse, so it costs no disk).
    writeFileSync(join(cwd, "big.txt"), "x".repeat(1_000_001));
    writeFileSync(join(cwd, "huge.bin"), "");
    truncateSync(join(cwd, "huge.bin"), 20 * 1024 * 1024 + 1);
    mkdirSync(join(w.srv.stateRoot, "secrets"), { recursive: true });
    const secretFile = join(w.srv.stateRoot, "secrets", "office.json");
    writeFileSync(secretFile, "{}");

    const base = `/api/agents/${w.asker.id}/asks`;
    const created = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: {
        text: "Look?",
        commands: ["bun test"],
        editFiles: ["notes.md"],
        readFiles: ["plot.png"],
      },
    });
    expect(created.status).toBe(201);
    const before = created.body as AskAgentWire;
    const copiesBefore = filesDir(w);

    const bad: [string, Record<string, unknown>, string][] = [
      ["blank command", { commands: ["  "] }, "422 invalid_command"],
      ["empty command", { commands: [""] }, "422 invalid_command"],
      ["two lines", { commands: ["ls\nrm -rf x"] }, "422 invalid_command"],
      ["a CR", { commands: ["ls\rpwd"] }, "422 invalid_command"],
      ["4097 chars", { commands: ["x".repeat(4097)] }, "422 invalid_command"],
      ["missing edit", { editFiles: ["missing.md"] }, "422 invalid_edit_file"],
      ["empty edit path", { editFiles: [""] }, "422 invalid_edit_file"],
      ["edit a directory", { editFiles: ["adir"] }, "422 invalid_edit_file"],
      ["edit a binary", { editFiles: ["blob.bin"] }, "422 invalid_edit_file"],
      ["edit over 1 MB", { editFiles: ["big.txt"] }, "422 invalid_edit_file"],
      ["missing read", { readFiles: ["missing.png"] }, "422 invalid_read_file"],
      ["empty read path", { readFiles: [""] }, "422 invalid_read_file"],
      ["read a directory", { readFiles: ["adir"] }, "422 invalid_read_file"],
      ["read over 20 MB", { readFiles: ["huge.bin"] }, "422 invalid_read_file"],
      ["edit a credential", { editFiles: [secretFile] }, "403 forbidden_path"],
      ["read a credential", { readFiles: [secretFile] }, "403 forbidden_path"],
      ["not a list", { commands: "ls" }, "422 invalid_affordances"],
      ["not strings", { readFiles: [1] }, "422 invalid_affordances"],
      ["null", { editFiles: null }, "422 invalid_affordances"],
      // A good read file next to a bad command: the command's check runs
      // before any copy.
      [
        "good file, bad command",
        { readFiles: ["plot.png", "notes.md"], commands: ["a\nb"] },
        "422 invalid_command",
      ],
    ];
    for (const [label, extra, want] of bad) {
      const post = await call(w.srv, "POST", base, w.as(w.asker.id), {
        json: { text: "Which?", ...extra },
      });
      expect(`${label}: ${post.status} ${post.code}`).toBe(`${label}: ${want}`);
      const patch = await call(
        w.srv,
        "PATCH",
        `${base}/${before.id}`,
        w.as(w.asker.id),
        { json: { text: "Changed?", ...extra } },
      );
      expect(`${label}: ${patch.status} ${patch.code}`).toBe(
        `${label}: ${want}`,
      );
    }
    // The query form refuses the same way.
    const viaQuery = await call(
      w.srv,
      "POST",
      `${base}?editFile=missing.md`,
      w.as(w.asker.id),
      { text: "Which?" },
    );
    expect(`${viaQuery.status} ${viaQuery.code}`).toBe("422 invalid_edit_file");
    // Nothing changed: one ask, as it was, and no file was copied.
    const listed = (await call(w.srv, "GET", base, w.as(w.asker.id)))
      .body as AskEntry[];
    expect(listed).toEqual([before]);
    // The file holds the entry; `member` is added on the wire only.
    const { member: _member, ...entry } = before;
    expect(stored(w, before.id)).toEqual(entry);
    expect(filesDir(w)).toEqual(copiesBefore);
  });

  it("takes 10 in total and refuses 11, and a create has nothing to remove", async () => {
    const w = await world();
    seed(w);
    const base = `/api/agents/${w.asker.id}/asks`;
    const ten = {
      commands: ["a", "b", "c", "d"],
      editFiles: ["notes.md", "other.md", "third.md"],
      readFiles: ["plot.png", "notes.md", "other.md"],
    };
    const ok = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "Ten?", ...ten },
    });
    expect(ok.status).toBe(201);
    const id = (ok.body as AskEntry).id;
    const eleven = { ...ten, commands: [...ten.commands, "e"] };
    const post = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "Eleven?", ...eleven },
    });
    expect(`${post.status} ${post.code}`).toBe("422 invalid_affordances");
    // On an edit the total counts the lists the edit keeps.
    const patch = await call(
      w.srv,
      "PATCH",
      `${base}/${id}`,
      w.as(w.asker.id),
      { json: { text: "Eleven?", commands: eleven.commands } },
    );
    expect(`${patch.status} ${patch.code}`).toBe("422 invalid_affordances");
    for (const [path, body] of [
      [`${base}?command=`, { text: "Which?" }],
      [base, { json: { text: "Which?", readFiles: [] } }],
    ] as const) {
      const r = await call(w.srv, "POST", path, w.as(w.asker.id), body);
      expect(`${path} ${r.status} ${r.code}`).toBe(
        `${path} 422 invalid_affordances`,
      );
    }
    const listed = (await call(w.srv, "GET", base, w.as(w.asker.id)))
      .body as AskEntry[];
    expect(listed.map((e) => [e.prompt, e.commands])).toEqual([
      ["Ten?", ten.commands],
    ]);
  });
});
