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
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { askReplyNote } from "../asks.ts";
import {
  ASK_DISMISSED_TEXT,
  ASK_FILED_TEXT,
  ASK_SIMPLIFY_TEXT,
  type AskEntry,
  type AskMemberWire,
  type AgentInfo,
  type TaskItem,
} from "../../shared/types.ts";
import type {
  AskAgentWire,
  AskClosedWire,
} from "../../shared/contract-shapes.ts";

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
    // Closed, not gone: the agent reads it with how it closed.
    const gone = await call(
      w.srv,
      "GET",
      `${base}/${created.id}`,
      w.as(w.asker.id),
    );
    expect([gone.status, (gone.body as AskClosedWire).closed?.outcome]).toEqual(
      [200, "withdrawn"],
    );
    expect((await call(w.srv, "GET", base, w.as(w.asker.id))).body).toEqual([]);
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
      expect(`${method} ${r.status} ${r.code}`).toBe(`${method} 403 forbidden`);
    }
    // Through its own path with the other agent's id: not its entry.
    const own = `/api/agents/${w.other.id}/asks/${created.id}`;
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { text: "spoof" }],
      ["DELETE", undefined],
    ] as const) {
      const r = await call(w.srv, method, own, w.as(w.other.id), body);
      expect(`${method} ${r.status} ${r.code}`).toBe(`${method} 404 not_found`);
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

  it("refuses an empty prompt and an unknown member", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const empty = await call(w.srv, "POST", base, w.as(w.asker.id), {
      text: "  ",
    });
    expect([empty.status, empty.code]).toEqual([400, "invalid_text"]);
    const unknown = await call(
      w.srv,
      "POST",
      `${base}?member=nobody`,
      w.as(w.asker.id),
      { text: "For whom?" },
    );
    expect(unknown.code).toBe("unknown_member");
  });

  // An agent that holds one ask per item waiting for its member, such as the
  // Sign-off Scout, has a backlog of hundreds; the bound is only a sanity
  // check (task 7a1d93c4). The backlog is seeded in asks.json and reloaded,
  // so the test does not pay for hundreds of route calls.
  it("holds a backlog of 500 open asks and refuses the next one", async () => {
    const w = await world();
    const first = await open(w, "Sign off item 0?");
    const file = join(w.srv.stateRoot, "asks.json");
    const stored = JSON.parse(readFileSync(file, "utf-8")) as AskEntry[];
    expect(stored.map((e) => e.id)).toEqual([first.id]);
    const backlog = Array.from({ length: 498 }, (_, i) => ({
      ...stored[0],
      id: `${first.id}-${i + 1}`,
      prompt: `Sign off item ${i + 1}?`,
    }));
    writeFileSync(file, JSON.stringify([...stored, ...backlog]));
    server = await w.srv.restart();
    const base = `/api/agents/${w.asker.id}/asks`;
    const as = { bearer: getAgentTokenRaw(w.asker.id)! };
    const listed = await call(server, "GET", base, as);
    expect((listed.body as AskEntry[]).length).toBe(499);

    const last = await call(server, "POST", base, as, {
      text: "Sign off item 499?",
    });
    expect(last.status).toBe(201);
    const full = await call(server, "POST", base, as, { text: "One more?" });
    expect([full.status, full.code]).toEqual([429, "too_many_asks"]);
    const after = await call(server, "GET", base, as);
    expect((after.body as AskEntry[]).length).toBe(500);
  });
});

// The ask returns its text as `prompt`, so a JSON body takes `prompt` as an
// alias of `text`, with the same rules (task 26e78c4c).
describe("the fields of a JSON body", () => {
  const prompts = async (w: Awaited<ReturnType<typeof world>>) =>
    (
      (
        await call(
          w.srv,
          "GET",
          `/api/agents/${w.asker.id}/asks`,
          w.as(w.asker.id),
        )
      ).body as AskEntry[]
    ).map((e) => e.prompt);

  it("takes prompt in place of text on create and on edit", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const created = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { prompt: "Pull the spend breakdown?" },
    });
    expect(created.status).toBe(201);
    const id = (created.body as AskEntry).id;
    expect((created.body as AskEntry).prompt).toBe("Pull the spend breakdown?");
    const edited = await call(
      w.srv,
      "PATCH",
      `${base}/${id}`,
      w.as(w.asker.id),
      { json: { prompt: "Pull it per agent?" } },
    );
    expect(edited.status).toBe(200);
    expect(await prompts(w)).toEqual(["Pull it per agent?"]);
  });

  it("refuses text and prompt together, also when they are equal, and changes nothing", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const both = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "Same?", prompt: "Same?" },
    });
    expect([both.status, both.code]).toEqual([400, "invalid_text"]);
    expect(await prompts(w)).toEqual([]);

    const created = await open(w, "Keep me?");
    const edit = await call(
      w.srv,
      "PATCH",
      `${base}/${created.id}`,
      w.as(w.asker.id),
      { json: { text: "New text?", prompt: "New prompt?" } },
    );
    expect([edit.status, edit.code]).toEqual([400, "invalid_text"]);
    expect(await prompts(w)).toEqual(["Keep me?"]);
  });

  it("refuses an empty prompt as it refuses an empty text", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const empty = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { prompt: "  " },
    });
    expect([empty.status, empty.code]).toEqual([400, "invalid_text"]);
    expect(await prompts(w)).toEqual([]);

    const created = await open(w, "Keep me?");
    const edit = await call(
      w.srv,
      "PATCH",
      `${base}/${created.id}`,
      w.as(w.asker.id),
      { json: { prompt: "" } },
    );
    expect([edit.status, edit.code]).toEqual([400, "invalid_text"]);
    expect(await prompts(w)).toEqual(["Keep me?"]);
  });

  it("takes member in the body; member in the query needs the text/plain form", async () => {
    const w = await world();
    const pat = await w.srv.seedMember("Pat");
    const patId = getUserByName(pat.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
    const base = `/api/agents/${w.asker.id}/asks`;

    // A query option is never merged with a JSON body, so the second
    // precedence rule a merge would need does not exist.
    const query = await call(
      w.srv,
      "POST",
      `${base}?member=${pat.username}`,
      w.as(w.asker.id),
      { json: { text: "For Pat?" } },
    );
    expect([query.status, query.code]).toEqual([422, "invalid_request"]);
    expect(await prompts(w)).toEqual([]);

    const created = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "For Pat?", member: pat.username },
    });
    expect(created.status).toBe(201);
    expect((created.body as AskEntry).memberUserId).toBe(patId);
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

    // link= with no value removes the key: from the answer and the file
    // (the push carries the same entry), never an empty string.
    const cleared = await call(
      w.srv,
      "PATCH",
      `${base}/${id}?link=`,
      w.as(w.asker.id),
      { text: "Pair your Chrome now?" },
    );
    expect(cleared.status).toBe(200);
    expect("link" in (cleared.body as object)).toBe(false);
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
    // The full table of refused paths is askLinkFor's, in
    // shared/office-links.test.ts; these prove both routes run it.
    const outside = ["https://linear.app", "/integrations/constructor"];
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
    // Not a string, or "" on a create (an edit reads "" as removal).
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

  it("takes an agent the member reaches, in any room, refuses an unknown or unreachable one, on create and on edit", async () => {
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
    // An edit moves a page link to an agent the manager reaches.
    const paged = await call(
      w.srv,
      "POST",
      `${base}?link=/tasks`,
      w.as(w.asker.id),
      { text: "Look at the board?" },
    );
    const edited = await call(
      w.srv,
      "PATCH",
      `${base}/${(paged.body as AskEntry).id}?link=/agents/${w.far.id}`,
      w.as(w.asker.id),
      { text: "Look at Far's chat?" },
    );
    expect(`${edited.status} ${edited.code}`).toBe("200 undefined");
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
      ["Say go in Far's chat?", `/agents/${w.far.id}`],
      ["Look at Far's chat?", `/agents/${w.far.id}`],
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
    // The rules' own table is checkOptions' in server/asks.test.ts; these
    // prove both routes run it, and that null on an edit is not a removal.
    const bad: unknown[] = [["Only one"], ["Same", " Same"], "A, B", null];
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
    const listed = await call(w.srv, "GET", base, w.as(w.asker.id));
    expect(
      (listed.body as AskEntry[]).map((e) => [e.prompt, e.options ?? null]),
    ).toEqual([["Which one?", null]]);
  });

  it("takes as many options as a triage needs, at full length, from one option= each", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    // Ten distinct options of the full 80 characters each.
    const ten = Array.from({ length: 10 }, (_, i) => `${i} ${"x".repeat(78)}`);
    const query = (options: string[]) =>
      options.map((o) => `option=${encodeURIComponent(o)}`).join("&");
    const made = await call(
      w.srv,
      "POST",
      `${base}?${query(ten)}&recommended=${encodeURIComponent(ten[9])}`,
      w.as(w.asker.id),
      { text: "Which one?" },
    );
    expect(made.status).toBe(201);
    const id = (made.body as AskEntry).id;
    expect(stored(w, id)?.options).toEqual(ten);
    expect(stored(w, id)?.recommended).toBe(ten[9]);
    // One more is refused, on create and on edit, and the ask keeps its ten.
    const eleven = [...ten, "one more"];
    const post = await call(
      w.srv,
      "POST",
      `${base}?${query(eleven)}`,
      w.as(w.asker.id),
      {
        text: "Which?",
      },
    );
    expect(`${post.status} ${post.code}`).toBe("422 invalid_options");
    const patch = await call(
      w.srv,
      "PATCH",
      `${base}/${id}?${query(eleven)}`,
      w.as(w.asker.id),
      { text: "Which?" },
    );
    expect(`${patch.status} ${patch.code}`).toBe("422 invalid_options");
    const listed = await call(w.srv, "GET", base, w.as(w.asker.id));
    expect(
      (listed.body as AskEntry[]).map((e) => [e.prompt, e.options ?? null]),
    ).toEqual([["Which one?", ten]]);
  });

  // The mark as the agent, the member's list and the file see it (the push
  // carries the stored entry).
  const mark = (e: unknown) => (e as AskEntry | undefined)?.recommended ?? null;

  it("marks one option as recommended on create and edit, and the mark goes with the options", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const agent = w.as(w.asker.id);
    // Text/plain: recommended= names an option, trimmed like one.
    const made = await call(
      w.srv,
      "POST",
      `${base}?option=Yes&option=No&recommended=${encodeURIComponent(" No ")}`,
      agent,
      { text: "Keep the verifier rule?\n" },
    );
    expect([made.status, made.code]).toEqual([201, undefined]);
    const id = (made.body as AskEntry).id;
    expect(mark(made.body)).toBe("No");
    expect(mark(stored(w, id))).toBe("No");
    const listed = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    expect((listed.body as AskEntry[]).map(mark)).toEqual(["No"]);

    const edit = async (
      query: string,
      body: { json?: unknown; text?: string },
    ) => {
      const r = await call(
        w.srv,
        "PATCH",
        `${base}/${id}${query}`,
        agent,
        body,
      );
      expect(`${query} ${r.status}`).toBe(`${query} 200`);
      expect(mark(r.body)).toBe(mark(stored(w, id)));
      return r.body as AskEntry;
    };
    // Neither sent: kept.
    expect(mark(await edit("", { text: "Keep it?" }))).toBe("No");
    // Kept options, a new mark among them.
    expect(mark(await edit("?recommended=Yes", { text: "Keep it?" }))).toBe(
      "Yes",
    );
    // New options with their own mark.
    const renamed = await edit("", {
      json: {
        text: "Keep it?",
        options: ["Keep", "Drop"],
        recommended: "Drop",
      },
    });
    expect([renamed.options, mark(renamed)]).toEqual([
      ["Keep", "Drop"],
      "Drop",
    ]);
    // New options without a mark clear it, even when the old one is among them.
    const unmarked = await edit("", {
      json: { text: "Keep it?", options: ["Keep", "Drop"] },
    });
    expect([unmarked.options, mark(unmarked)]).toEqual([
      ["Keep", "Drop"],
      null,
    ]);
    // A JSON mark on kept options, then recommended= removes it.
    expect(
      mark(await edit("", { json: { text: "Keep it?", recommended: "Keep" } })),
    ).toBe("Keep");
    const cleared = await edit("?recommended=", { text: "Keep it?" });
    expect([cleared.options, mark(cleared)]).toEqual([["Keep", "Drop"], null]);
    // Removing the options removes the mark with them.
    await edit("?recommended=Keep", { text: "Keep it?" });
    const bare = await edit("?option=", { text: "Keep it?" });
    expect(["options" in bare, mark(bare)]).toEqual([false, null]);

    // A JSON create carries a mark too.
    const json = await call(w.srv, "POST", base, agent, {
      json: { text: "Ship it?", options: ["Yes", "No"], recommended: "Yes" },
    });
    expect(json.status).toBe(201);
    expect(mark(stored(w, (json.body as AskEntry).id))).toBe("Yes");
  });

  it("refuses a mark that is not one of the options, on create and on edit, and changes nothing", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const agent = w.as(w.asker.id);
    const plain = await open(w, "Which one?");
    const marked = await call(w.srv, "POST", base, agent, {
      json: { text: "Which?", options: ["A", "B"], recommended: "A" },
    });
    expect(marked.status).toBe(201);
    const markedId = (marked.body as AskEntry).id;
    const refused = async (
      method: string,
      path: string,
      body: { json?: unknown; text?: string },
    ) => {
      const label = `${method} ${path} ${JSON.stringify(body)}`;
      const r = await call(w.srv, method, path, agent, body);
      expect(`${label} ${r.status} ${r.code}`).toBe(
        `${label} 422 invalid_options`,
      );
    };
    // Create.
    for (const recommended of ["C", "", "a", 1, null])
      await refused("POST", base, {
        json: { text: "Which?", options: ["A", "B"], recommended },
      });
    await refused("POST", base, { json: { text: "Which?", recommended: "A" } });
    await refused("POST", `${base}?recommended=A`, { text: "Which?" });
    await refused("POST", `${base}?option=A&option=B&recommended=C`, {
      text: "Which?",
    });
    // Edit: not among the kept options, the new options, or no options.
    const at = `${base}/${markedId}`;
    await refused("PATCH", at, { json: { text: "Which?", recommended: "C" } });
    await refused("PATCH", `${at}?recommended=C`, { text: "Which?" });
    await refused("PATCH", at, {
      json: { text: "Which?", options: ["C", "D"], recommended: "A" },
    });
    await refused("PATCH", at, {
      json: { text: "Which?", options: [], recommended: "A" },
    });
    await refused("PATCH", `${at}?option=&recommended=A`, { text: "Which?" });
    await refused("PATCH", `${base}/${plain.id}?recommended=A`, {
      text: "Which?",
    });
    // Nothing changed: the agent's list and the file.
    const listed = await call(w.srv, "GET", base, agent);
    expect(
      (listed.body as AskEntry[]).map((e) => [
        e.prompt,
        e.options ?? null,
        mark(e),
      ]),
    ).toEqual([
      ["Which one?", null, null],
      ["Which?", ["A", "B"], "A"],
    ]);
    expect(mark(stored(w, markedId))).toBe("A");
    expect(mark(stored(w, plain.id))).toBe(null);
  });
});

// An ask's optional priority (task 995fc76a): the board's P0-P4 scale, so a
// member can sort and filter the Inbox by it. Absent on an ask that has none.
describe("a priority", () => {
  const stored = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    (
      JSON.parse(
        readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
      ) as AskEntry[]
    ).find((e) => e.id === id);
  const priorityOf = (entry: unknown) =>
    entry && typeof entry === "object" && "priority" in entry
      ? (entry as AskEntry).priority
      : "absent";

  it("takes a priority on create and edit, keeps it when an edit omits it, removes it, and keeps it across a restart", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const made = await call(
      w.srv,
      "POST",
      `${base}?priority=P1`,
      w.as(w.asker.id),
      { text: "Ship the beta?\n" },
    );
    expect(made.status).toBe(201);
    const id = (made.body as AskEntry).id;
    expect(priorityOf(made.body)).toBe("P1");
    expect(priorityOf(stored(w, id))).toBe("P1");

    // An edit without a priority keeps it.
    const kept = await call(w.srv, "PATCH", `${base}/${id}`, w.as(w.asker.id), {
      text: "Ship the beta today?",
    });
    expect(kept.status).toBe(200);
    expect(priorityOf(kept.body)).toBe("P1");

    // Each removal form, each after a value that replaced the last one. The
    // key goes from the answer and the file, never as null or "".
    const removals: Array<[string, { json?: unknown; text?: string }]> = [
      ["?priority=", { text: "Ship it?" }],
      ["", { json: { text: "Ship it?", priority: null } }],
      ["", { json: { text: "Ship it?", priority: "" } }],
    ];
    for (const [i, [query, body]] of removals.entries()) {
      const level = `P${i * 2}`;
      const set = await call(
        w.srv,
        "PATCH",
        `${base}/${id}`,
        w.as(w.asker.id),
        { json: { text: "Ship it?", priority: level } },
      );
      expect(`${i} ${set.status} ${priorityOf(set.body)}`).toBe(
        `${i} 200 ${level}`,
      );
      expect(priorityOf(stored(w, id))).toBe(level);
      const cleared = await call(
        w.srv,
        "PATCH",
        `${base}/${id}${query}`,
        w.as(w.asker.id),
        body,
      );
      expect(`${i} ${cleared.status} ${priorityOf(cleared.body)}`).toBe(
        `${i} 200 absent`,
      );
      expect(stored(w, id)).toBeDefined();
      expect(priorityOf(stored(w, id))).toBe("absent");
    }

    // A JSON create carries one, and the agent's read and the member's list
    // show it.
    const json = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "Rename the repo?", priority: "P4" },
    });
    expect(json.status).toBe(201);
    const jsonId = (json.body as AskEntry).id;
    const read = await call(
      w.srv,
      "GET",
      `${base}/${jsonId}`,
      w.as(w.asker.id),
    );
    expect(priorityOf(read.body)).toBe("P4");
    const owner = { rawSessionId: w.owner.rawSessionId };
    const listed = await call(w.srv, "GET", "/api/asks", owner);
    expect(
      (listed.body as AskEntry[]).map((e) => [e.prompt, priorityOf(e)]),
    ).toEqual([
      ["Ship it?", "absent"],
      ["Rename the repo?", "P4"],
    ]);

    server = await w.srv.restart();
    const after = await call(server, "GET", "/api/asks", owner);
    expect(
      (after.body as AskEntry[]).map((e) => [e.prompt, priorityOf(e)]),
    ).toEqual([
      ["Ship it?", "absent"],
      ["Rename the repo?", "P4"],
    ]);
  });

  it("refuses a priority that is not P0 to P4, on create and on edit, and changes nothing", async () => {
    const w = await world();
    const base = `/api/agents/${w.asker.id}/asks`;
    const made = await call(
      w.srv,
      "POST",
      `${base}?priority=P2`,
      w.as(w.asker.id),
      { text: "Keep me?" },
    );
    expect(made.status).toBe(201);
    const id = (made.body as AskEntry).id;
    // The query form, also empty on a create (an edit reads it as removal).
    for (const level of ["P5", "p1", "P", "high"]) {
      const post = await call(
        w.srv,
        "POST",
        `${base}?priority=${encodeURIComponent(level)}`,
        w.as(w.asker.id),
        { text: "Which?" },
      );
      expect(`${level} ${post.status} ${post.code}`).toBe(
        `${level} 422 invalid_priority`,
      );
      const patch = await call(
        w.srv,
        "PATCH",
        `${base}/${id}?priority=${encodeURIComponent(level)}`,
        w.as(w.asker.id),
        { text: "Changed?" },
      );
      expect(`${level} ${patch.status} ${patch.code}`).toBe(
        `${level} 422 invalid_priority`,
      );
    }
    const emptyPost = await call(
      w.srv,
      "POST",
      `${base}?priority=`,
      w.as(w.asker.id),
      { text: "Which?" },
    );
    expect(`${emptyPost.status} ${emptyPost.code}`).toBe(
      "422 invalid_priority",
    );
    // The JSON form: not a level, or not a string; null and "" on a create.
    for (const level of [1, true, ["P1"], "P9", null, ""]) {
      const post = await call(w.srv, "POST", base, w.as(w.asker.id), {
        json: { text: "Which?", priority: level },
      });
      expect(`${JSON.stringify(level)} ${post.status} ${post.code}`).toBe(
        `${JSON.stringify(level)} 422 invalid_priority`,
      );
    }
    for (const level of [1, true, ["P1"], "P9"]) {
      const patch = await call(
        w.srv,
        "PATCH",
        `${base}/${id}`,
        w.as(w.asker.id),
        { json: { text: "Changed?", priority: level } },
      );
      expect(`${JSON.stringify(level)} ${patch.status} ${patch.code}`).toBe(
        `${JSON.stringify(level)} 422 invalid_priority`,
      );
    }
    const listed = await call(w.srv, "GET", base, w.as(w.asker.id));
    expect(
      (listed.body as AskEntry[]).map((e) => [e.prompt, priorityOf(e)]),
    ).toEqual([["Keep me?", "P2"]]);
    expect(priorityOf(stored(w, id))).toBe("P2");
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
    expect([
      after.status,
      (after.body as AskClosedWire).closed?.outcome,
    ]).toEqual([200, "replied"]);
  });

  it("keeps the ask's options and recommended one on the answer, so the chat can show them", async () => {
    const w = await world();
    const r = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/asks?option=Tonight&option=Tomorrow&recommended=Tomorrow`,
      w.as(w.asker.id),
      { text: "Ship the release?\n" },
    );
    expect(r.status).toBe(201);
    const created = r.body as AskEntry;
    // Hold the agent, so the answer waits in the queue first.
    const hold = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "hold on" } },
    );
    expect(hold.status).toBe(200);
    await waitUntil(
      () => w.srv.fakeBackend.sessionForAgent(w.asker.id) !== undefined,
      "session",
    );
    const reply = await call(
      w.srv,
      "POST",
      `/api/asks/${created.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "Tomorrow" } },
    );
    expect(reply.status).toBe(204);
    const ask = {
      id: created.id,
      prompt: "Ship the release?",
      options: ["Tonight", "Tomorrow"],
      recommended: "Tomorrow",
    };
    const queued = agentOf(w.srv, w.asker.id).queue ?? [];
    expect(queued.map((m) => m.ask)).toEqual([ask]);

    w.srv.fakeBackend.sessionForAgent(w.asker.id)!.completeTurn({ text: "ok" });
    await waitUntil(
      () =>
        w.srv.agentManager
          .getAgentLogs(w.asker.id)
          .some((e) => e.kind === "user_message" && e.content === "Tomorrow"),
      "answer delivered",
    );
    const entry = w.srv.agentManager
      .getAgentLogs(w.asker.id)
      .find((e) => e.kind === "user_message" && e.content === "Tomorrow")!;
    expect(entry.metadata?.ask).toEqual(ask);
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

  it("refuses a dismiss text that is not a string and leaves the ask open; no text or a blank one is a bare dismiss", async () => {
    const w = await world();
    const created = await open(w, "Book the room?");
    const dismiss = (id: string, json: unknown) =>
      call(
        w.srv,
        "POST",
        `/api/asks/${id}/dismiss`,
        { rawSessionId: w.owner.rawSessionId },
        { json },
      );
    const refused = await dismiss(created.id, { text: 5 });
    expect([refused.status, refused.code]).toEqual([400, "invalid_text"]);
    const still = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
    );
    expect(still.status).toBe(200);
    expect(sentTexts(w.srv, w.asker.id)).toEqual([]);

    // No text, then a blank one: each sends the bare word under the dismiss
    // note.
    const second = await open(w, "Book the hall?");
    expect((await dismiss(created.id, {})).status).toBe(204);
    expect((await dismiss(second.id, { text: " \n " })).status).toBe(204);
    const bare = (ask: AskEntry) =>
      `[${w.owner.username}] ${askReplyNote({ ...ask, dismissed: true })}${ASK_DISMISSED_TEXT}`;
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).length === 2,
      "both dismisses delivered",
    );
    expect(sentTexts(w.srv, w.asker.id)).toEqual([bare(created), bare(second)]);
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
    // A simplify request too, and the ask is not marked.
    const simplify = await call(
      w.srv,
      "POST",
      `/api/asks/${created.id}/simplify`,
      { rawSessionId: w.owner.rawSessionId },
      { json: {} },
    );
    expect([simplify.status, simplify.code]).toEqual([
      typed.status,
      typed.code,
    ]);
    const still = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
    );
    expect(still.status).toBe(200);
    expect((still.body as AskAgentWire).simplifyRequestedAt).toBeUndefined();
  });

  it("is only for the member it names: anyone else gets 404 and sees nothing", async () => {
    const w = await world();
    const created = await open(w, "Only for Nil?");
    // Pat reaches the agent's room, so only the ask's member refuses Pat.
    const other = await w.srv.seedMember("Pat");
    const patId = getUserByName(other.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
    const listed = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: other.rawSessionId,
    });
    expect(listed.body).toEqual([]);
    for (const verb of ["reply", "dismiss", "file-task", "simplify"]) {
      const r = await call(
        w.srv,
        "POST",
        `/api/asks/${created.id}/${verb}`,
        { rawSessionId: other.rawSessionId },
        { json: verb === "reply" ? { text: "done" } : {} },
      );
      expect(`${verb} ${r.status} ${r.code}`).toBe(`${verb} 404 not_found`);
    }
    expect(w.srv.agentManager.getTasks()).toEqual([]);
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

  it("keeps the opening session off the member's list and pushes", async () => {
    const w = await world();
    const start = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      w.as(w.other.id),
      { text: "start a session" },
    );
    expect(start.status).toBe(200);
    await waitUntil(
      () => w.srv.agentManager.getCurrentSessionId(w.asker.id) !== null,
      "first session",
    );
    const ws = await w.srv.connectWs(w.owner.rawSessionId);
    const pushes = () =>
      (ws.messages as { type?: string; entry: AskMemberWire }[]).filter(
        (m) => m.type === "ask_upserted",
      );

    // The store keeps the session, so each surface below has one to leak.
    const storedSession = (id: string) =>
      (
        JSON.parse(
          readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
        ) as AskEntry[]
      ).find((e) => e.id === id)?.sessionId;

    const created = await open(w, "Which session opened me?");
    expect(storedSession(created.id)).toBeString();

    await waitUntil(() => pushes().length === 1, "push on create");
    expect(pushes()[0].entry.id).toBe(created.id);
    expect("sessionId" in pushes()[0].entry).toBe(false);

    const listed = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    const entries = listed.body as AskMemberWire[];
    expect(entries.map((e) => e.id)).toEqual([created.id]);
    expect("sessionId" in entries[0]).toBe(false);

    const edited = await call(
      w.srv,
      "PATCH",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
      { text: "Which session edited me?" },
    );
    expect(edited.status).toBe(200);
    expect(storedSession(created.id)).toBeString();
    await waitUntil(() => pushes().length === 2, "push on edit");
    expect(pushes()[1].entry.prompt).toBe("Which session edited me?");
    expect("sessionId" in pushes()[1].entry).toBe(false);
  });
});

describe("a simplify request (task 30915188)", () => {
  const simplify = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    call(
      w.srv,
      "POST",
      `/api/asks/${id}/simplify`,
      { rawSessionId: w.owner.rawSessionId },
      { json: {} },
    );
  const agentRead = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${id}`,
      w.as(w.asker.id),
    );
  const rewrite = (
    w: Awaited<ReturnType<typeof world>>,
    id: string,
    json: Record<string, unknown>,
  ) =>
    call(
      w.srv,
      "PATCH",
      `/api/agents/${w.asker.id}/asks/${id}`,
      w.as(w.asker.id),
      { json },
    );

  it("sends the agent the fixed words under a simplify note, keeps the ask open and marked for the member and the agent, and pushes the change", async () => {
    const w = await world();
    const ws = await w.srv.connectWs(w.owner.rawSessionId);
    const created = await open(w, "Merge t-1 after the CI on f00d?");
    const r = await simplify(w, created.id);
    expect(r.status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(created.id)),
      "simplify delivered",
    );
    expect(sentTexts(w.srv, w.asker.id)).toEqual([
      `[${w.owner.username}] ${askReplyNote({ ...created, simplify: true })}${ASK_SIMPLIFY_TEXT}`,
    ]);
    const logged = w.srv.agentManager
      .getAgentLogs(w.asker.id)
      .find((e) => e.kind === "user_message")!;
    expect(logged.content).toBe(ASK_SIMPLIFY_TEXT);
    expect(logged.metadata?.ask).toEqual({
      id: created.id,
      prompt: "Merge t-1 after the CI on f00d?",
      simplify: true,
    });

    // Still open: the agent and the member read the request.
    const read = await agentRead(w, created.id);
    expect(read.status).toBe(200);
    expect((read.body as AskClosedWire).closed).toBeUndefined();
    expect(typeof (read.body as AskAgentWire).simplifyRequestedAt).toBe(
      "number",
    );
    const listed = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    const [mine] = listed.body as AskMemberWire[];
    expect([mine.id, typeof mine.simplifyRequestedAt]).toEqual([
      created.id,
      "number",
    ]);
    await waitUntil(
      () =>
        ws.messages.some((m) => {
          const msg = m as { type?: string; entry?: AskEntry };
          return (
            msg.type === "ask_upserted" &&
            msg.entry?.id === created.id &&
            typeof msg.entry.simplifyRequestedAt === "number"
          );
        }),
      "the mark is pushed to the member",
    );

    // Waiting for the rewrite: a second request sends nothing.
    const again = await simplify(w, created.id);
    expect([again.status, again.code]).toEqual([409, "simplify_pending"]);
    await sleep(50);
    expect(sentTexts(w.srv, w.asker.id)).toHaveLength(1);
  });

  it("is cleared by the agent's rewrite in place, which keeps the first prompt across two rounds; the agent cannot set either field; the history names who asked", async () => {
    const w = await world();
    const first = "Merge t-1 after the CI on f00d?";
    const created = await open(w, first);
    expect((await simplify(w, created.id)).status).toBe(204);

    // Same prompt, and the server's fields in the body: ignored, still
    // waiting.
    const same = await rewrite(w, created.id, {
      text: first,
      simplifyRequestedAt: null,
      originalPrompt: "Spoofed?",
    });
    expect(same.status).toBe(200);
    const stillPending = (await agentRead(w, created.id)).body as AskAgentWire;
    expect(typeof stillPending.simplifyRequestedAt).toBe("number");
    expect(stillPending.originalPrompt).toBeUndefined();

    const rewritten = await rewrite(w, created.id, {
      text: "Merge the fix now?",
    });
    expect(rewritten.status).toBe(200);
    const after = (await agentRead(w, created.id)).body as AskAgentWire;
    expect([
      after.prompt,
      after.originalPrompt,
      after.simplifyRequestedAt,
    ]).toEqual(["Merge the fix now?", first, undefined]);
    // The member sees the original on the card.
    const listed = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    expect((listed.body as AskMemberWire[])[0].originalPrompt).toBe(first);

    expect((await simplify(w, created.id)).status).toBe(204);
    expect((await rewrite(w, created.id, { text: "Merge it?" })).status).toBe(
      200,
    );
    expect(
      ((await agentRead(w, created.id)).body as AskAgentWire).originalPrompt,
    ).toBe(first);

    const deleted = await call(
      w.srv,
      "DELETE",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
    );
    expect(deleted.status).toBe(204);
    const closed = (await agentRead(w, created.id)).body as AskClosedWire;
    const requests = closed.events.filter(
      (e) => e.kind === "simplify_requested",
    );
    expect(requests).toEqual([
      {
        kind: "simplify_requested",
        at: expect.any(Number),
        by: w.owner.username,
      },
      {
        kind: "simplify_requested",
        at: expect.any(Number),
        by: w.owner.username,
      },
    ]);
    expect(JSON.stringify(closed.events)).not.toContain(w.ownerId);
  });
});

describe("an ask filed as a task", () => {
  const fileTask = (
    w: Awaited<ReturnType<typeof world>>,
    id: string,
    json: unknown = {},
  ) =>
    call(
      w.srv,
      "POST",
      `/api/asks/${id}/file-task`,
      { rawSessionId: w.owner.rawSessionId },
      { json },
    );

  it("files one task in the agent's room by the member, closes the ask, and tells the agent the task", async () => {
    const w = await world();
    // The other agent's room: the task follows the asking agent, not the
    // first room.
    const room2 = w.srv.agentManager.createRoom("Second");
    expect(w.srv.agentManager.moveAgent(w.asker.id, room2)).toBe(true);
    expect(agentOf(w.srv, w.asker.id).roomId).toBe(room2);
    const created = await open(w, "Rotate the staging keys?");
    const r = await fileTask(w, created.id);
    expect(r.status).toBe(201);
    const task = r.body as TaskItem;
    expect(w.srv.agentManager.getTasks().map((t) => t.id)).toEqual([task.id]);
    expect(task).toMatchObject({
      title: "Rotate the staging keys?",
      status: "open",
      roomId: room2,
      createdBy: w.owner.username,
      username: w.owner.username,
    });
    expect(task.description).toContain("Rotate the staging keys?");
    expect(task.priority).toBeUndefined();
    expect(task.assignee).toBeUndefined();
    expect(task.createdByAgentId).toBeUndefined();

    // The ask is closed.
    const after = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
    );
    expect([
      after.status,
      (after.body as AskClosedWire).closed?.outcome,
    ]).toEqual([200, "filed"]);

    // The agent reads the task id in the note, then the bare words.
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(created.id)),
      "file-task delivered",
    );
    const sent = sentTexts(w.srv, w.asker.id).find((t) =>
      t.includes(created.id),
    )!;
    expect(sent).toContain(task.id);
    expect(sent).toBe(
      `[${w.owner.username}] ${askReplyNote({ ...created, taskId: task.id })}${ASK_FILED_TEXT}`,
    );
    const entry = w.srv.agentManager
      .getAgentLogs(w.asker.id)
      .find((e) => e.kind === "user_message")!;
    expect(entry.content).toBe(ASK_FILED_TEXT);
    // Not a dismiss: the chat draws its own line from the task id.
    expect(entry.metadata?.ask).toEqual({
      id: created.id,
      prompt: "Rotate the staging keys?",
      taskId: task.id,
    });
  });

  it("gives the task the ask's priority", async () => {
    const w = await world();
    const made = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/asks?priority=P1`,
      w.as(w.asker.id),
      { text: "Move the backups?" },
    );
    expect(made.status).toBe(201);
    const r = await fileTask(w, (made.body as AskEntry).id);
    expect(r.status).toBe(201);
    const task = r.body as TaskItem;
    expect(task.priority).toBe("P1");
    expect(
      w.srv.agentManager.getTasks().map((t) => [t.id, t.priority]),
    ).toEqual([[task.id, "P1"]]);
  });

  it("sends the member's typed note to the agent and puts it on the task; a blank one is bare", async () => {
    const w = await world();
    const noted = await open(w, "Book the room?");
    const r = await fileTask(w, noted.id, { text: "After the launch." });
    expect(r.status).toBe(201);
    const task = r.body as TaskItem;
    expect(task.description).toContain("After the launch.");
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).length === 1,
      "noted file-task delivered",
    );
    expect(sentTexts(w.srv, w.asker.id)).toEqual([
      `[${w.owner.username}] ${askReplyNote({ ...noted, taskId: task.id })}After the launch.`,
    ]);

    const blank = await open(w, "Book the hall?");
    const second = await fileTask(w, blank.id, { text: " \n " });
    expect(second.status).toBe(201);
    const secondTask = second.body as TaskItem;
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).length === 2,
      "blank file-task delivered",
    );
    expect(sentTexts(w.srv, w.asker.id)[1]).toBe(
      `[${w.owner.username}] ${askReplyNote({ ...blank, taskId: secondTask.id })}${ASK_FILED_TEXT}`,
    );
    expect(w.srv.agentManager.getTasks()).toHaveLength(2);
  });

  it("refuses a note that is not a string, and files nothing", async () => {
    const w = await world();
    const created = await open(w, "Book the room?");
    const r = await fileTask(w, created.id, { text: 5 });
    expect([r.status, r.code]).toEqual([400, "invalid_text"]);
    expect(w.srv.agentManager.getTasks()).toEqual([]);
    const still = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
    );
    expect(still.status).toBe(200);
    expect(sentTexts(w.srv, w.asker.id)).toEqual([]);
  });

  it("is refused where a typed message is, with the same reason, and leaves no task and the ask open", async () => {
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
    const r = await fileTask(w, created.id);
    expect([r.status, r.code]).toEqual([typed.status, typed.code]);
    expect(w.srv.agentManager.getTasks()).toEqual([]);
    const still = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/${created.id}`,
      w.as(w.asker.id),
    );
    expect(still.status).toBe(200);
  });
});

describe("live and durable", () => {
  it("pushes a create and a close to the member's sockets only", async () => {
    const w = await world();
    // Pat reaches the agent's room, so only the ask's member keeps Pat out.
    const pat = await w.srv.seedMember("Pat");
    const patId = getUserByName(pat.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
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
    // Pat's socket is live and sees the room: the reply's chat line reaches
    // it after the create's push would have.
    await waitUntil(
      () =>
        theirs.messages.some((m) => {
          const e = (m as { type?: string; entry?: { content?: unknown } })
            .entry;
          return (
            (m as { type?: string }).type === "log_entry" &&
            e?.content === "done"
          );
        }),
      "Pat sees the reply in the chat",
    );
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
    // A request takes no link and no options: the route refuses either key
    // rather than drop it, and opens nothing.
    for (const extra of [
      { link: "/integrations/secrets" },
      { options: ["Save", "Decline"] },
    ]) {
      const r = await call(
        w.srv,
        "POST",
        `/api/agents/${w.asker.id}/secret-requests`,
        w.as(w.asker.id),
        { json: { ...REQUEST, ...extra } },
      );
      expect({ extra, code: r.code }).toEqual({
        extra,
        code: "invalid_request",
      });
    }
    const requestId = await request(w.srv, w.asker.id);
    const owner = { rawSessionId: w.owner.rawSessionId };
    const listed = await call(w.srv, "GET", "/api/asks", owner);
    expect(listed.body).toHaveLength(1);
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
      ["file-task", { text: VALUE }],
      ["simplify", {}],
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
    // Filing it would put the request on the board without its form.
    expect(w.srv.agentManager.getTasks()).toEqual([]);
    expect(
      sentTexts(w.srv, w.asker.id).some((t) => t.includes(ASK_SIMPLIFY_TEXT)),
    ).toBe(false);
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

  it("an office request goes to every owner who can reach the room, not to the agent's manager; the agent's delete withdraws one", async () => {
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
    const outcome = async (r: Promise<Res>) => {
      const { status, code } = await r;
      return `${status} ${code}`;
    };
    expect(await outcome(save(w.srv, agentId, office, pat.rawSessionId))).toBe(
      "403 forbidden",
    );
    expect(
      await outcome(save(w.srv, agentId, personal, w.owner.rawSessionId)),
    ).toBe("403 forbidden");
    expect(
      await outcome(save(w.srv, agentId, office, w.owner.rawSessionId)),
    ).toBe("200 undefined");
    expect(await ids(w.owner.rawSessionId)).toEqual([]);
    // The agent's delete withdraws a secret request: a later save finds
    // nothing.
    const [left] = (
      await call(w.srv, "GET", `/api/agents/${agentId}/asks`, {
        bearer: getAgentTokenRaw(agentId)!,
      })
    ).body as AskEntry[];
    expect(left.secret?.requestId).toBe(personal);
    const deleted = await call(
      w.srv,
      "DELETE",
      `/api/agents/${agentId}/asks/${left.id}`,
      { bearer: getAgentTokenRaw(agentId)! },
    );
    expect(deleted.status).toBe(204);
    expect(
      await outcome(save(w.srv, agentId, personal, pat.rawSessionId)),
    ).toBe("404 not_found");
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
    // The restored agent wakes for the confirmation: it names the secret,
    // never its value.
    const srv = server;
    await waitUntil(
      () => sentTexts(srv, w.asker.id).some((t) => t.includes(REQUEST.name)),
      "the agent is told",
    );
    expect(sentTexts(srv, w.asker.id).some((t) => t.includes(VALUE))).toBe(
      false,
    );
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
    // The push carries the stored entry.
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

  // Task 3f5b8f33: an .mp4 was stored as application/octet-stream, so the
  // card could not play it. iPhone browsers also need byte ranges to play.
  // Task 37a660e8: a video or audio file is referenced where it is, not
  // copied, so a large video costs no copy and has no size cap.
  const referenced = (e: AskEntry) =>
    (e.readFiles ?? []).map((a) => [
      a.originalName,
      a.mediaType,
      a.size,
      (a as { path?: string }).path ?? null,
    ]);
  const askFile = (
    w: Awaited<ReturnType<typeof world>>,
    askId: string,
    filename: string,
    rawSessionId: string,
    headers: Record<string, string> = {},
    query = "",
  ) =>
    w.srv.http(`/api/asks/${askId}/files/${filename}${query}`, {
      method: "GET",
      rawSessionId,
      headers,
    });

  it("references a video or an audio file where it is, with no copy and no size cap, and serves its current bytes in byte ranges", async () => {
    const w = await world();
    const cwd = seed(w);
    const VIDEO = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    writeFileSync(join(cwd, "short.mp4"), VIDEO);
    writeFileSync(join(cwd, "voice.mp3"), Buffer.from([0xff, 0xfb, 0x90]));
    // Over read-file's 20 MB cap (sparse, so it costs no disk).
    const BIG = 20 * 1024 * 1024 + 1;
    writeFileSync(join(cwd, "long.mp4"), "");
    truncateSync(join(cwd, "long.mp4"), BIG);
    const made = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/asks`,
      w.as(w.asker.id),
      {
        json: {
          text: "Publish this Short?",
          readFiles: ["plot.png", "short.mp4", "voice.mp3", "long.mp4"],
        },
      },
    );
    expect(made.status).toBe(201);
    const entry = made.body as AskEntry;
    // The list keeps its order; only the image is a copy, the media files
    // carry the absolute path they are served from.
    const want = [
      ["plot.png", "image/png", PNG.length, null],
      ["short.mp4", "video/mp4", VIDEO.length, join(cwd, "short.mp4")],
      ["voice.mp3", "audio/mpeg", 3, join(cwd, "voice.mp3")],
      ["long.mp4", "video/mp4", BIG, join(cwd, "long.mp4")],
    ];
    expect(referenced(entry)).toEqual(want);
    expect(referenced(stored(w, entry.id)!)).toEqual(want);
    const [listed] = (
      await call(w.srv, "GET", "/api/asks", {
        rawSessionId: w.owner.rawSessionId,
      })
    ).body as AskEntry[];
    expect(referenced(listed)).toEqual(want);
    // Only the image was copied into the files dir.
    const [png, video, voice, long] = entry.readFiles!;
    expect(filesDir(w)).toEqual([png.filename]);
    // Each reference has its own name, with the original extension for the
    // served type.
    expect(new Set([video, voice, long].map((a) => a.filename)).size).toBe(3);
    expect(
      [video, voice, long].map((a) => a.filename.split(".").pop()),
    ).toEqual(["mp4", "mp3", "mp4"]);

    const owner = w.owner.rawSessionId;
    const res = await askFile(w, entry.id, video.filename, owner, {
      Range: "bytes=10-19",
    });
    expect({
      status: res.status,
      type: res.headers.get("content-type"),
      range: res.headers.get("content-range"),
      cache: res.headers.get("cache-control"),
      nosniff: res.headers.get("x-content-type-options"),
    }).toEqual({
      status: 206,
      type: "video/mp4",
      range: `bytes 10-19/${VIDEO.length}`,
      cache: "private, no-cache",
      nosniff: "nosniff",
    });
    expect(
      Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(10, 20)),
    ).toBe(true);
    const audio = await askFile(w, entry.id, voice.filename, owner);
    expect([audio.status, audio.headers.get("content-type")]).toEqual([
      200,
      "audio/mpeg",
    ]);
    expect(Buffer.from(await audio.arrayBuffer())).toEqual(
      Buffer.from([0xff, 0xfb, 0x90]),
    );
    // The file over the cap is served too: its last byte, by range.
    const tail = await askFile(w, entry.id, long.filename, owner, {
      Range: `bytes=${BIG - 1}-${BIG - 1}`,
    });
    expect([tail.status, tail.headers.get("content-range")]).toEqual([
      206,
      `bytes ${BIG - 1}-${BIG - 1}/${BIG}`,
    ]);
    // A download carries the name it asks for.
    const download = await askFile(
      w,
      entry.id,
      video.filename,
      owner,
      {},
      "?download=short.mp4",
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");

    // Not a snapshot: the card plays the bytes at the path now.
    const NEW = Buffer.from("new cut");
    writeFileSync(join(cwd, "short.mp4"), NEW);
    const again = await askFile(w, entry.id, video.filename, owner);
    expect(again.status).toBe(200);
    expect(Buffer.from(await again.arrayBuffer()).equals(NEW)).toBe(true);
  });

  it("serves a reference only to the ask's member, while the ask is open and the path is a regular file outside the credential store", async () => {
    const w = await world();
    const cwd = seed(w);
    const CLIP = Buffer.from("clip bytes");
    const clipPath = join(cwd, "clip.mp4");
    writeFileSync(clipPath, CLIP);
    const made = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/asks`,
      w.as(w.asker.id),
      {
        json: {
          text: "Approve the clip?",
          readFiles: ["plot.png", "clip.mp4"],
        },
      },
    );
    expect(made.status).toBe(201);
    const entry = made.body as AskEntry;
    const [png, clip] = entry.readFiles!;
    const owner = w.owner.rawSessionId;
    const get = async (filename: string, session = owner) => {
      const r = await askFile(w, entry.id, filename, session);
      const body = Buffer.from(await r.arrayBuffer());
      if (r.status === 200) return body.equals(CLIP) ? "200 clip" : "200 other";
      const code = (
        JSON.parse(body.toString()) as { error?: { code?: string } }
      ).error?.code;
      return `${r.status} ${code}`;
    };
    // The enabling case, before and after each refusal below.
    expect(await get(clip.filename)).toBe("200 clip");

    // Pat reaches the agent's room, so only the ask's member refuses Pat.
    const pat = await w.srv.seedMember("Pat");
    const patId = getUserByName(pat.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
    expect(await get(clip.filename, pat.rawSessionId)).toBe("404 not_found");
    // A copy's name, and a name the ask does not hold.
    expect(await get(png.filename)).toBe("404 not_found");
    expect(await get("0000.mp4")).toBe("404 not_found");
    // A reference is not in the files dir.
    const viaFiles = await w.srv.http(
      `/api/files/${w.asker.id}/${clip.filename}`,
      { method: "GET", rawSessionId: owner },
    );
    expect(viaFiles.status).toBe(404);

    // The path turns into a link into the credential store after the ask.
    mkdirSync(join(w.srv.stateRoot, "secrets"), { recursive: true });
    const secretFile = join(w.srv.stateRoot, "secrets", "office.json");
    writeFileSync(secretFile, "{}");
    unlinkSync(clipPath);
    symlinkSync(secretFile, clipPath);
    expect(await get(clip.filename)).toBe("404 not_found");
    unlinkSync(clipPath);
    // A directory, then nothing.
    mkdirSync(clipPath);
    expect(await get(clip.filename)).toBe("404 not_found");
    rmSync(clipPath, { recursive: true });
    expect(await get(clip.filename)).toBe("404 not_found");
    writeFileSync(clipPath, CLIP);
    expect(await get(clip.filename)).toBe("200 clip");

    // A closed ask serves nothing.
    const dismissed = await call(
      w.srv,
      "POST",
      `/api/asks/${entry.id}/dismiss`,
      { rawSessionId: owner },
      { json: {} },
    );
    expect(dismissed.status).toBe(204);
    expect(await get(clip.filename)).toBe("404 not_found");
  });

  it("keeps a reference through an edit that omits the list, and names it anew when the list is sent again", async () => {
    const w = await world();
    const cwd = seed(w);
    writeFileSync(join(cwd, "clip.mp4"), "clip");
    const base = `/api/agents/${w.asker.id}/asks`;
    const made = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: { text: "Approve?", readFiles: ["clip.mp4"] },
    });
    expect(made.status).toBe(201);
    const id = (made.body as AskEntry).id;
    const [first] = (made.body as AskEntry).readFiles!;
    expect((first as { path?: string }).path).toBe(join(cwd, "clip.mp4"));
    const patch = (json: unknown) =>
      call(w.srv, "PATCH", `${base}/${id}`, w.as(w.asker.id), { json });
    const owner = w.owner.rawSessionId;

    const kept = await patch({ text: "Approve now?" });
    expect(kept.status).toBe(200);
    expect((kept.body as AskEntry).readFiles).toEqual([first]);
    expect((await askFile(w, id, first.filename, owner)).status).toBe(200);

    const resent = await patch({ text: "Approve?", readFiles: ["clip.mp4"] });
    expect(resent.status).toBe(200);
    const [second] = (resent.body as AskEntry).readFiles!;
    expect((second as { path?: string }).path).toBe(join(cwd, "clip.mp4"));
    expect(second.filename).not.toBe(first.filename);
    expect((await askFile(w, id, second.filename, owner)).status).toBe(200);
    expect((await askFile(w, id, first.filename, owner)).status).toBe(404);
    expect(filesDir(w)).toEqual([]);
  });

  it("takes them as JSON, and an edit keeps a list it omits, replaces one it sends, and removes one with [] or a lone empty value", async () => {
    const w = await world();
    const cwd = seed(w);
    const base = `/api/agents/${w.asker.id}/asks`;
    // A JSON create: a command's trailing whitespace trimmed, an absolute
    // path as it is.
    const made = await call(w.srv, "POST", base, w.as(w.asker.id), {
      json: {
        text: "Look?",
        commands: [`${CMD}\t`],
        editFiles: [join(cwd, "notes.md")],
        readFiles: [join(cwd, "plot.png")],
      },
    });
    expect(made.status).toBe(201);
    const full = affordances(made.body as AskEntry);
    expect(full).toEqual({
      commands: [CMD],
      editFiles: [{ cwd, path: join(cwd, "notes.md") }],
      readFiles: [["plot.png", "image/png", PNG.length]],
    });
    const id = (made.body as AskEntry).id;
    const patch = (path: string, body: { json?: unknown; text?: string }) =>
      call(w.srv, "PATCH", `${base}/${id}${path}`, w.as(w.asker.id), body);

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
    // A video is referenced, not copied, but takes the same path checks.
    const secretVideo = join(w.srv.stateRoot, "secrets", "clip.mp4");
    writeFileSync(secretVideo, "v");
    mkdirSync(join(cwd, "adir.mp4"), { recursive: true });

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
      [
        "read a credential video",
        { readFiles: [secretVideo] },
        "403 forbidden_path",
      ],
      ["missing video", { readFiles: ["gone.mp4"] }, "422 invalid_read_file"],
      ["video directory", { readFiles: ["adir.mp4"] }, "422 invalid_read_file"],
      // A good copy before a bad reference: every path is checked before
      // any copy.
      [
        "good copy, missing video",
        { readFiles: ["notes.md", "gone.mp4"] },
        "422 invalid_read_file",
      ],
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

// An app opens asks with its app token (task 1f453011; internal-docs/asks-design.md,
// "App asks"). The ask is the app's message target's, for the app's owner
// unless the app names a member, and the answer goes to that agent. The app
// reaches only the asks its own registration opened, wherever its target has
// moved since. Which identities reach /api/app/asks at all is pinned in
// routes-table.test.ts.
describe("an ask an app opens", () => {
  const APP = "triage-bot";
  type World = Awaited<ReturnType<typeof world>>;

  // Register an app through the real route and read its token from the
  // environment file the fake supervisor wrote.
  async function register(
    w: World,
    name: string,
    auth: { bearer?: string; rawSessionId?: string },
  ): Promise<{ token: string; createdAt: number }> {
    const r = await call(w.srv, "POST", "/api/apps", auth, {
      json: { name, command: "bun run serve.ts", cwd: w.srv.stateRoot },
    });
    expect(r.status).toBe(201);
    const token = w.srv.appSupervisor.tokenFiles.get(name);
    if (!token) throw new Error(`no token file for ${name}`);
    return { token, createdAt: (r.body as { createdAt: number }).createdAt };
  }
  const asApp = (
    w: World,
    token: string,
    method: string,
    path: string,
    body?: { json?: unknown; text?: string },
  ) => call(w.srv, method, `/api/app/asks${path}`, { bearer: token }, body);
  // A create the test needs to succeed.
  const opened = async (w: World, token: string, text: string) => {
    const r = await asApp(w, token, "POST", "", { text });
    expect(r.status).toBe(201);
    return r.body as AskAgentWire;
  };
  const retarget = async (w: World, agentId: string) => {
    const r = await call(w.srv, "PATCH", `/api/apps/${APP}`, w.as(w.asker.id), {
      json: { messageTargetAgentId: agentId },
    });
    expect(r.status).toBe(200);
  };
  const agentRead = (w: World, agentId: string, id: string) =>
    call(w.srv, "GET", `/api/agents/${agentId}/asks/${id}`, w.as(agentId));
  // The agent reads a closed ask from the history (task ff590b5e): an app's
  // delete closes it as withdrawn, and the record keeps the app.
  const closedOn = async (w: World, agentId: string, id: string) => {
    const r = await agentRead(w, agentId, id);
    const body = r.body as AskEntry & { closed?: { outcome?: string } };
    return [r.status, body.agentId, body.app?.name, body.closed?.outcome];
  };
  const stored = (w: World, id: string) =>
    (
      JSON.parse(
        readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
      ) as AskEntry[]
    ).find((e) => e.id === id);

  it("opens one in its target agent's name for its owner, and lists, reads, edits and deletes its own only", async () => {
    const w = await world();
    const app = await register(w, APP, w.as(w.asker.id));
    const made = await asApp(w, app.token, "POST", "", {
      text: "Ship the release?\n",
    });
    expect(made.status).toBe(201);
    const entry = made.body as AskAgentWire;
    expect({
      agentId: entry.agentId,
      memberUserId: entry.memberUserId,
      member: entry.member,
      prompt: entry.prompt,
      app: entry.app,
    }).toEqual({
      agentId: w.asker.id,
      memberUserId: w.ownerId,
      member: w.owner.username,
      prompt: "Ship the release?",
      app: { name: APP, createdAt: app.createdAt },
    });

    // The agent and the member see it as the agent's ask, with the app.
    const idsAndApps = (r: Res) =>
      (r.body as AskEntry[]).map((e) => [e.id, e.app?.name ?? null]);
    const mine = await open(w, "The agent's own question?");
    const agentList = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks`,
      w.as(w.asker.id),
    );
    expect(idsAndApps(agentList)).toEqual([
      [entry.id, APP],
      [mine.id, null],
    ]);
    const memberList = await call(w.srv, "GET", "/api/asks", {
      rawSessionId: w.owner.rawSessionId,
    });
    expect(idsAndApps(memberList)).toEqual([
      [entry.id, APP],
      [mine.id, null],
    ]);

    // The app's own routes reach its ask and not the agent's.
    const listed = await asApp(w, app.token, "GET", "");
    expect(listed.status).toBe(200);
    expect((listed.body as AskEntry[]).map((e) => e.id)).toEqual([entry.id]);
    const edited = await asApp(w, app.token, "PATCH", `/${entry.id}`, {
      text: "Ship it today?",
    });
    expect(edited.status).toBe(200);
    const read = await asApp(w, app.token, "GET", `/${entry.id}`);
    expect((read.body as AskEntry).prompt).toBe("Ship it today?");
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { text: "spoof" }],
      ["DELETE", undefined],
    ] as const) {
      const r = await asApp(w, app.token, method, `/${mine.id}`, body);
      expect(`${method} ${r.status} ${r.code}`).toBe(`${method} 404 not_found`);
    }
    const untouched = await agentRead(w, w.asker.id, mine.id);
    expect((untouched.body as AskEntry).prompt).toBe(
      "The agent's own question?",
    );

    const deleted = await asApp(w, app.token, "DELETE", `/${entry.id}`);
    expect(deleted.status).toBe(204);
    expect((await asApp(w, app.token, "GET", `/${entry.id}`)).status).toBe(404);
    expect(await closedOn(w, w.asker.id, entry.id)).toEqual([
      200,
      w.asker.id,
      APP,
      "withdrawn",
    ]);
  });

  // Task 62aa552f: the history keeps every change before the close, with who
  // made it. The agent can edit and withdraw an app's ask, so the entry's app
  // does not say who did.
  it("keeps who made each change, the app or the agent, in the history and in the read by id", async () => {
    const w = await world();
    const app = await register(w, APP, w.as(w.asker.id));
    const entry = await opened(w, app.token, "Ship the release?");
    const byApp = await asApp(w, app.token, "PATCH", `/${entry.id}`, {
      text: "Ship it today?",
    });
    expect(byApp.status).toBe(200);
    const byAgent = await call(
      w.srv,
      "PATCH",
      `/api/agents/${w.asker.id}/asks/${entry.id}`,
      w.as(w.asker.id),
      { text: "Ship it now?" },
    );
    expect(byAgent.status).toBe(200);
    expect((await asApp(w, app.token, "DELETE", `/${entry.id}`)).status).toBe(
      204,
    );
    const mine = await open(w, "The agent's own question?");
    expect(
      (
        await call(
          w.srv,
          "DELETE",
          `/api/agents/${w.asker.id}/asks/${mine.id}`,
          w.as(w.asker.id),
        )
      ).status,
    ).toBe(204);

    const page = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/history`,
      w.as(w.asker.id),
    );
    expect(page.status).toBe(200);
    const [mineClosed, appClosed] = (page.body as { asks: AskClosedWire[] })
      .asks;
    expect([mineClosed.id, appClosed.id]).toEqual([mine.id, entry.id]);
    expect(appClosed.events).toEqual([
      {
        kind: "created",
        at: entry.createdAt,
        ask: { prompt: "Ship the release?" },
      },
      {
        kind: "edited",
        at: (byApp.body as AskAgentWire).updatedAt,
        app: APP,
        before: { prompt: "Ship the release?" },
      },
      {
        kind: "edited",
        at: (byAgent.body as AskAgentWire).updatedAt,
        before: { prompt: "Ship it today?" },
      },
    ]);
    expect("app" in appClosed.events[2]).toBe(false);
    const { at: _appAt, ...appClose } = appClosed.closed;
    expect(appClose).toEqual({ outcome: "withdrawn", by: null, app: APP });
    const { at: _mineAt, ...mineClose } = mineClosed.closed;
    expect(mineClose).toEqual({ outcome: "withdrawn", by: null });
    expect(mineClosed.events).toEqual([
      {
        kind: "created",
        at: mine.createdAt,
        ask: { prompt: "The agent's own question?" },
      },
    ]);
    // The read by id carries the same record as the history.
    expect((await agentRead(w, w.asker.id, entry.id)).body).toEqual(appClosed);
  });

  it("never reaches another app's asks, or an earlier app's of the same name, which stay open on the agent", async () => {
    const w = await world();
    const first = await register(w, APP, w.as(w.asker.id));
    const other = await register(w, "uptime-bot", w.as(w.asker.id));
    const made = await opened(w, first.token, "First app's question?");
    const reachesNothing = async (token: string) => {
      const listed = await asApp(w, token, "GET", "");
      expect([listed.status, listed.body]).toEqual([200, []]);
      for (const [method, body] of [
        ["GET", undefined],
        ["PATCH", { text: "spoof" }],
        ["DELETE", undefined],
      ] as const) {
        const r = await asApp(w, token, method, `/${made.id}`, body);
        expect(`${method} ${r.status} ${r.code}`).toBe(
          `${method} 404 not_found`,
        );
      }
    };
    await reachesNothing(other.token);

    const del = await call(
      w.srv,
      "DELETE",
      `/api/apps/${APP}`,
      w.as(w.asker.id),
    );
    expect(del.status).toBe(204);
    // A later registration gets a later createdAt.
    await sleep(5);
    const reborn = await register(w, APP, w.as(w.asker.id));
    expect(reborn.createdAt).not.toBe(first.createdAt);
    await reachesNothing(reborn.token);

    // The deleted app's ask stays open on its agent, as it was.
    const kept = await agentRead(w, w.asker.id, made.id);
    expect(kept.status).toBe(200);
    expect((kept.body as AskEntry).prompt).toBe("First app's question?");
  });

  it("keeps an ask with the agent that holds it when the owner moves the app's target", async () => {
    const w = await world();
    const app = await register(w, APP, w.as(w.asker.id));
    const before = await opened(w, app.token, "Before the move?");
    await retarget(w, w.other.id);
    const after = await opened(w, app.token, "After the move?");
    expect([before.agentId, after.agentId]).toEqual([w.asker.id, w.other.id]);
    const listed = await asApp(w, app.token, "GET", "");
    expect(
      (listed.body as AskEntry[]).map((e) => [e.id, e.agentId]).sort(),
    ).toEqual(
      [
        [before.id, w.asker.id],
        [after.id, w.other.id],
      ].sort(),
    );

    // An edit of the earlier ask copies its file for the agent that holds
    // it, not for the current target.
    writeFileSync(join(agentOf(w.srv, w.asker.id).cwd, "plan.md"), "# plan\n");
    const edited = await asApp(
      w,
      app.token,
      "PATCH",
      `/${before.id}?readFile=plan.md`,
      { text: "Before the move?" },
    );
    expect(edited.status).toBe(200);
    const [copy] = (edited.body as AskEntry).readFiles ?? [];
    expect(copy?.originalName).toBe("plan.md");
    const filesOf = (agentId: string) =>
      join(w.srv.stateRoot, "logs", agentId, "files", copy.filename);
    expect(existsSync(filesOf(w.asker.id))).toBe(true);
    expect(existsSync(filesOf(w.other.id))).toBe(false);
    const held = await agentRead(w, w.asker.id, before.id);
    expect((held.body as AskEntry).readFiles?.map((f) => f.filename)).toEqual([
      copy.filename,
    ]);

    const deleted = await asApp(w, app.token, "DELETE", `/${before.id}`);
    expect(deleted.status).toBe(204);
    expect(await closedOn(w, w.asker.id, before.id)).toEqual([
      200,
      w.asker.id,
      APP,
      "withdrawn",
    ]);
  });

  it("is for its owner unless it names a member, and names one only while its owner agent lives", async () => {
    const w = await world();
    const pat = await w.srv.seedMember("Pat");
    const patId = getUserByName(pat.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
    // Lee reaches no room.
    const lee = await w.srv.seedMember("Lee");
    const app = await register(w, APP, w.as(w.asker.id));
    const lonely = await register(w, "lonely-bot", w.as(w.asker.id));
    // The target is not the owner agent, so it outlives it below.
    await retarget(w, w.other.id);

    const forPat = await asApp(w, app.token, "POST", "", {
      json: { text: "For Pat?", member: pat.username },
    });
    expect(forPat.status).toBe(201);
    expect([
      (forPat.body as AskEntry).agentId,
      (forPat.body as AskEntry).memberUserId,
    ]).toEqual([w.other.id, patId]);
    const unknown = await asApp(w, app.token, "POST", "", {
      json: { text: "For whom?", member: "nobody" },
    });
    expect([unknown.status, unknown.code]).toEqual([422, "unknown_member"]);
    const noAccess = await asApp(w, app.token, "POST", "", {
      json: { text: "For Lee?", member: lee.username },
    });
    expect([noAccess.status, noAccess.code]).toEqual([422, "member_no_access"]);

    // The owner agent goes: the app still opens asks, for its owner only.
    await w.srv.agentManager.kill(w.asker.id);
    expect(w.srv.agentManager.getAgent(w.asker.id)).toBeUndefined();
    const named = await asApp(w, app.token, "POST", "", {
      json: { text: "For Pat again?", member: pat.username },
    });
    expect([named.status, named.code]).toEqual([403, "forbidden"]);
    const plain = await asApp(w, app.token, "POST", "", {
      text: "For the owner?",
    });
    expect(plain.status).toBe(201);
    expect([
      (plain.body as AskEntry).agentId,
      (plain.body as AskEntry).memberUserId,
    ]).toEqual([w.other.id, w.ownerId]);
    // The other app's target was the agent that went.
    const gone = await asApp(w, lonely.token, "POST", "", {
      text: "Anyone there?",
    });
    expect([gone.status, gone.code]).toEqual([404, "target_gone"]);
  });

  it("is for its owner, not for the target agent's manager", async () => {
    const w = await world();
    // Pat owns the app and reaches the room; Asker's manager is Nil.
    const pat = await w.srv.seedMember("Pat");
    const patId = getUserByName(pat.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
    expect(agentOf(w.srv, w.asker.id).userId).toBe(w.ownerId);
    const app = await register(w, APP, { rawSessionId: pat.rawSessionId });
    const moved = await call(
      w.srv,
      "PATCH",
      `/api/apps/${APP}`,
      { rawSessionId: pat.rawSessionId },
      { json: { messageTargetAgentId: w.asker.id } },
    );
    expect(moved.status).toBe(200);
    const made = await opened(w, app.token, "Pat's call?");
    expect([made.agentId, made.memberUserId, made.member]).toEqual([
      w.asker.id,
      patId,
      pat.username,
    ]);
  });

  it("refuses an app with no agent behind it, and a step", async () => {
    const w = await world();
    const human = await register(w, "human-bot", {
      rawSessionId: w.owner.rawSessionId,
    });
    const none = await asApp(w, human.token, "POST", "", {
      text: "Who answers?",
    });
    expect([none.status, none.code]).toEqual([409, "no_target"]);

    const app = await register(w, APP, w.as(w.asker.id));
    const step = await asApp(w, app.token, "POST", "", {
      json: {
        text: "Sign in?",
        step: { kind: "mcp-sign-in", scope: "personal", name: "linear" },
      },
    });
    expect([step.status, step.code]).toEqual([400, "invalid_request"]);
    const listed = await asApp(w, app.token, "GET", "");
    expect([listed.status, listed.body]).toEqual([200, []]);
  });

  it("sends the member's answer to the agent, naming the app, and records no opening session", async () => {
    const w = await world();
    const sessionOf = () => w.srv.agentManager.getCurrentSessionId(w.asker.id);
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

    const app = await register(w, APP, w.as(w.asker.id));
    const made = await opened(w, app.token, "Merge the release branch?");
    // The agent's session did not open it.
    const kept = stored(w, made.id);
    expect(kept?.app).toEqual({ name: APP, createdAt: app.createdAt });
    expect(kept?.sessionId).toBeUndefined();

    const cleared = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/new-conversation`,
      w.as(w.asker.id),
      { json: {} },
    );
    expect(cleared.status).toBe(204);
    await waitUntil(() => sessionOf() !== opener, "session cleared");

    const r = await call(
      w.srv,
      "POST",
      `/api/asks/${made.id}/reply`,
      { rawSessionId: w.owner.rawSessionId },
      { json: { text: "go ahead" } },
    );
    expect(r.status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.endsWith("go ahead")),
      "reply delivered",
    );
    const sent = sentTexts(w.srv, w.asker.id).find((t) =>
      t.endsWith("go ahead"),
    )!;
    expect(sent).toContain(APP);
    expect(sent).toContain(made.id);
    expect(sent).toContain("Merge the release branch?");
    expect(sent).not.toContain(opener);
    const logged = w.srv.agentManager
      .getAgentLogs(w.asker.id)
      .find((e) => e.kind === "user_message" && e.content === "go ahead")!;
    const ref = logged.metadata?.ask as {
      id?: string;
      app?: { name?: string };
    };
    expect([ref.id, ref.app?.name]).toEqual([made.id, APP]);
    expect((await asApp(w, app.token, "GET", `/${made.id}`)).status).toBe(404);
  });

  it("names the app in a dismiss and in a filed task, which also names the agent", async () => {
    const w = await world();
    const app = await register(w, APP, w.as(w.asker.id));
    const dropped = await opened(w, app.token, "Drop the flaky test?");
    const filed = await opened(w, app.token, "Rotate the keys?");
    const sentFor = async (id: string) => {
      await waitUntil(
        () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(id)),
        `answer to ${id} delivered`,
      );
      return sentTexts(w.srv, w.asker.id).find((t) => t.includes(id))!;
    };
    const owner = { rawSessionId: w.owner.rawSessionId };

    const dismissed = await call(
      w.srv,
      "POST",
      `/api/asks/${dropped.id}/dismiss`,
      owner,
      { json: {} },
    );
    expect(dismissed.status).toBe(204);
    expect(await sentFor(dropped.id)).toContain(APP);

    const r = await call(
      w.srv,
      "POST",
      `/api/asks/${filed.id}/file-task`,
      owner,
      { json: {} },
    );
    expect(r.status).toBe(201);
    const task = r.body as TaskItem;
    expect(task.description).toContain(APP);
    expect(task.description).toContain(w.asker.name);
    const note = await sentFor(filed.id);
    expect(note).toContain(APP);
    expect(note).toContain(task.id);
  });

  it("sends a simplify request naming the app, which reads the mark, and the app's rewrite clears it and keeps the original", async () => {
    const w = await world();
    const app = await register(w, APP, w.as(w.asker.id));
    const entry = await opened(w, app.token, "Drop the flaky test in t-9?");
    const r = await call(
      w.srv,
      "POST",
      `/api/asks/${entry.id}/simplify`,
      { rawSessionId: w.owner.rawSessionId },
      { json: {} },
    );
    expect(r.status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).some((t) => t.includes(entry.id)),
      "simplify delivered",
    );
    expect(sentTexts(w.srv, w.asker.id)).toEqual([
      `[${w.owner.username}] ${askReplyNote({ id: entry.id, prompt: entry.prompt, simplify: true, app: { name: APP } })}${ASK_SIMPLIFY_TEXT}`,
    ]);
    const read = await asApp(w, app.token, "GET", `/${entry.id}`);
    expect(typeof (read.body as AskAgentWire).simplifyRequestedAt).toBe(
      "number",
    );
    const edited = await asApp(w, app.token, "PATCH", `/${entry.id}`, {
      text: "Drop the flaky test?",
    });
    expect(edited.status).toBe(200);
    const after = (await asApp(w, app.token, "GET", `/${entry.id}`))
      .body as AskAgentWire;
    expect([after.simplifyRequestedAt, after.originalPrompt]).toEqual([
      undefined,
      "Drop the flaky test in t-9?",
    ]);
  });

  it("keeps the app on the ask across a restart, and the app still reaches it", async () => {
    const w = await world();
    const app = await register(w, APP, w.as(w.asker.id));
    const made = await opened(w, app.token, "Still yours?");
    server = await w.srv.restart();
    const listed = await call(server, "GET", "/api/app/asks", {
      bearer: app.token,
    });
    expect((listed.body as AskEntry[]).map((e) => [e.id, e.app?.name])).toEqual(
      [[made.id, APP]],
    );
  });
});
