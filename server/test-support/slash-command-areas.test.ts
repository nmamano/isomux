// Chat commands follow the area of their HTTP twin (task 79d755d7). A member
// with a permission pack, or a limited API token, that may send to an agent
// but lacks the twin's area is refused the command with the route's own 403
// (code forbidden, the area in the error), and nothing runs: /isomux-diff and
// /isomux-edit need files read (as GET /api/agents/:id/file), /model, /effort
// and /rename need agentManagement write (as PATCH /api/agents/:id and PUT
// /topic), /isomux-storage needs office read (as GET /api/storage/usage). An
// answer to a model or effort picker another member opened needs the same
// area as the command. The target is a Chat agent: it fits every sender.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import { FAILED_EDIT_TEXT_KEY } from "../../shared/failed-edit.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "slash-areas-"));
  folders.push(dir);
  return dir;
}

// A git working tree with one untracked file: /isomux-diff of it makes a
// diff entry that carries the file's content.
function projectWithChanges(): string {
  const dir = freshFolder();
  const init = Bun.spawnSync(["git", "init", "-q", dir]);
  expect(init.exitCode).toBe(0);
  writeFileSync(join(dir, "notes.txt"), "dummy content\n");
  return dir;
}

interface Res {
  status: number;
  error: Record<string, unknown>;
}

const refusal = (res: Res) => ({
  status: res.status,
  code: res.error.code,
  area: res.error.area,
});

async function office() {
  const fakeBackend = new FakeBackend({
    storedSessionState: "durable",
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
  const srv = await startTestServer({ fakeBackend });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Casey");
  const room = srv.agentManager.getRooms()[0].id;
  const o = {
    srv,
    owner: owner.rawSessionId,
    ownerName: owner.username,
    ownerId: getUserByName(owner.username)!.id,
    casey: member.rawSessionId,
    caseyName: member.username,
    room,
  };
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function call(
  o: Office,
  auth: { session: string } | { bearer: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const headers: Record<string, string> =
    body === undefined ? {} : { "Content-Type": "application/json" };
  const init = {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const res =
    "session" in auth
      ? await o.srv.http(path, {
          ...init,
          headers,
          rawSessionId: auth.session,
        })
      : await fetch(`${o.srv.baseUrl}${path}`, {
          ...init,
          headers: {
            ...headers,
            Authorization: `Bearer ${auth.bearer}`,
            Connection: "close",
          },
        });
  const json = (await res.json().catch(() => null)) as {
    error?: Record<string, unknown>;
  } | null;
  return { status: res.status, error: json?.error ?? {} };
}

type Sender = { session: string } | { bearer: string };

const send = (o: Office, who: Sender, agentId: string, text: string) =>
  call(o, who, "POST", `/api/agents/${agentId}/messages`, { text });

async function packCasey(o: Office, areas: MemberPack["areas"]) {
  const pack: MemberPack = { areas, agentCeiling: "chat" };
  const res = await call(
    o,
    { session: o.owner },
    "PUT",
    `/api/users/${o.caseyName}/access`,
    { allowedRooms: [o.room], pack },
  );
  expect({
    status: res.status,
    pack: getUserByName(o.caseyName)?.pack,
  }).toEqual({ status: 200, pack });
}

// The owner's own API token, limited at mint.
async function ownerToken(
  o: Office,
  areas: MemberPack["areas"],
): Promise<string> {
  const res = await o.srv.http("/api/me/api-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Script",
      expiresInDays: 30,
      limits: { areas },
    }),
    rawSessionId: o.owner,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as ApiTokenCreateRes).token;
}

// Morgan's agent at the Chat stop, with a session and idle.
async function chatAgent(o: Office): Promise<AgentInfo> {
  const agent = await o.srv.agentManager.spawn(
    "ChatBot",
    freshFolder(),
    "default",
    undefined,
    undefined,
    o.room,
    undefined,
    undefined,
    undefined,
    o.ownerName,
    "claude",
    undefined,
    o.ownerId,
  );
  if (!agent) throw new Error("spawn failed");
  const lowered = await call(
    o,
    { session: o.owner },
    "PUT",
    `/api/agents/${agent.id}/access`,
    { access: "chat" },
  );
  expect(lowered.status).toBe(200);
  expect((await send(o, { session: o.owner }, agent.id, "hello")).status).toBe(
    200,
  );
  await waitUntil(
    () =>
      o.srv.agentManager.getAgent(agent.id)?.state === "waiting_for_response",
    "idle after hello",
  );
  return agent;
}

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

const logsOf = (o: Office, agentId: string): LogEntry[] =>
  o.srv.agentManager.getAgentLogs(agentId);
const entriesOf = (o: Office, agentId: string, kind: string) =>
  logsOf(o, agentId).filter((e) => e.kind === kind);
const echoesOf = (o: Office, agentId: string, text: string) =>
  logsOf(o, agentId).filter(
    (e) => e.kind === "user_message" && e.content === text,
  ).length;
const pendingOf = (o: Office, agentId: string) =>
  o.srv.agentManager
    .getPendingInteractions()
    .filter((item) => item.agentId === agentId);

// Opens a picker as the owner and returns it with the 1-based index of a
// choice that is not the current one.
async function openPicker(o: Office, agentId: string, command: string) {
  expect((await send(o, { session: o.owner }, agentId, command)).status).toBe(
    200,
  );
  await waitUntil(() => pendingOf(o, agentId).length === 1, command);
  const picker = pendingOf(o, agentId)[0];
  const index = picker.choices.findIndex((c) => !c.current);
  expect(index).toBeGreaterThanOrEqual(0);
  return { picker, index: index + 1, choice: picker.choices[index] };
}

describe("chat commands that read server files need the files area", () => {
  it("refuses /isomux-diff, /diff and /isomux-edit to a pack member and a token without files, and runs them with files read", async () => {
    const o = await office();
    const agent = await chatAgent(o);
    const project = projectWithChanges();
    await packCasey(o, { agents: "write", logs: "read" });
    const token = await ownerToken(o, { agents: "write" });
    const texts = [
      `/isomux-diff ${project}`,
      `/diff ${project}`,
      `/ isomux-edit ${join(project, "notes.txt")}`,
      "/isomux-edit /etc",
    ];
    for (const who of [{ session: o.casey }, { bearer: token }]) {
      for (const text of texts) {
        expect({
          text,
          ...refusal(await send(o, who, agent.id, text)),
        }).toEqual({ text, status: 403, code: "forbidden", area: "files" });
      }
    }
    // Nothing ran: no echo, no diff, no edit request, no path answer.
    for (const text of texts) expect(echoesOf(o, agent.id, text)).toBe(0);
    expect(entriesOf(o, agent.id, "diff")).toHaveLength(0);
    expect(entriesOf(o, agent.id, "edit-request")).toHaveLength(0);

    // With files read in the pack, the same member runs both.
    await packCasey(o, { agents: "write", logs: "read", files: "read" });
    expect(
      (await send(o, { session: o.casey }, agent.id, texts[0])).status,
    ).toBe(200);
    await waitUntil(
      () => entriesOf(o, agent.id, "diff").length === 1,
      "diff entry",
    );
    expect(
      (await send(o, { session: o.casey }, agent.id, texts[2])).status,
    ).toBe(200);
    await waitUntil(
      () => entriesOf(o, agent.id, "edit-request").length === 1,
      "edit request",
    );
  });

  it("refuses an edit of an ephemeral entry into /isomux-diff and keeps the entry", async () => {
    const o = await office();
    const agent = await chatAgent(o);
    const project = projectWithChanges();
    await packCasey(o, { agents: "write", logs: "read" });
    // An unknown command: echoed as an ephemeral entry, which an edit
    // re-sends through the command path.
    expect(
      (await send(o, { session: o.casey }, agent.id, "/no-such-command"))
        .status,
    ).toBe(200);
    await waitUntil(
      () => echoesOf(o, agent.id, "/no-such-command") === 1,
      "ephemeral echo",
    );
    const original = logsOf(o, agent.id).find(
      (e) => e.kind === "user_message" && e.content === "/no-such-command",
    )!;
    expect(original.ephemeral).toBe(true);

    const newText = `/isomux-diff ${project}`;
    const edit = await call(
      o,
      { session: o.casey },
      "PATCH",
      `/api/agents/${agent.id}/messages/${original.id}`,
      { newText },
    );
    expect(edit.status).toBe(200);
    // The refusal is an error entry that keeps the edited text.
    await waitUntil(
      () =>
        entriesOf(o, agent.id, "error").some(
          (e) => e.metadata?.[FAILED_EDIT_TEXT_KEY] === newText,
        ),
      "failed edit entry",
    );
    expect(logsOf(o, agent.id).map((e) => e.id)).toContain(original.id);
    expect(echoesOf(o, agent.id, newText)).toBe(0);
    expect(entriesOf(o, agent.id, "diff")).toHaveLength(0);
  });
});

describe("chat commands that change agent settings need agentManagement", () => {
  it("refuses /rename and /model and /effort to a pack member and a token without it", async () => {
    const o = await office();
    const agent = await chatAgent(o);
    await packCasey(o, { agents: "write", logs: "read", office: "read" });
    const token = await ownerToken(o, { agents: "write" });
    const before = o.srv.agentManager.getAgent(agent.id)!;
    for (const who of [{ session: o.casey }, { bearer: token }]) {
      for (const text of ["/rename taken over", "/model", "/effort"]) {
        expect({
          text,
          ...refusal(await send(o, who, agent.id, text)),
        }).toEqual({
          text,
          status: 403,
          code: "forbidden",
          area: "agentManagement",
        });
      }
    }
    const after = o.srv.agentManager.getAgent(agent.id)!;
    expect({
      topic: after.topic,
      model: after.modelFamily,
      effort: after.effort,
    }).toEqual({
      topic: before.topic,
      model: before.modelFamily,
      effort: before.effort,
    });
    expect(pendingOf(o, agent.id)).toHaveLength(0);
    expect(echoesOf(o, agent.id, "/rename taken over")).toBe(0);

    // A token with agentManagement write renames.
    const manager = await ownerToken(o, {
      agents: "write",
      agentManagement: "write",
    });
    expect(
      (await send(o, { bearer: manager }, agent.id, "/rename by the manager"))
        .status,
    ).toBe(200);
    await waitUntil(
      () => o.srv.agentManager.getAgent(agent.id)?.topic === "by the manager",
      "renamed",
    );
  });

  it("refuses a typed or clicked answer to a model picker the owner opened, and settles it with agentManagement", async () => {
    const o = await office();
    const agent = await chatAgent(o);
    await packCasey(o, { agents: "write", logs: "read" });
    const token = await ownerToken(o, { agents: "write" });
    const model = o.srv.agentManager.getAgent(agent.id)!.modelFamily;
    const { picker, index, choice } = await openPicker(o, agent.id, "/model");

    for (const who of [{ session: o.casey }, { bearer: token }]) {
      expect(refusal(await send(o, who, agent.id, String(index)))).toEqual({
        status: 403,
        code: "forbidden",
        area: "agentManagement",
      });
    }
    expect(
      refusal(
        await call(
          o,
          { session: o.casey },
          "POST",
          `/api/agents/${agent.id}/interactions/${picker.id}/respond`,
          { value: choice.value },
        ),
      ),
    ).toEqual({ status: 403, code: "forbidden", area: "agentManagement" });
    // The picker stays open for a member who may answer it.
    expect(pendingOf(o, agent.id).map((p) => p.id)).toEqual([picker.id]);
    expect(o.srv.agentManager.getAgent(agent.id)!.modelFamily).toBe(model);

    // With agentManagement write, the same member's typed answer settles it.
    await packCasey(o, {
      agents: "write",
      logs: "read",
      agentManagement: "write",
    });
    expect(
      (await send(o, { session: o.casey }, agent.id, String(index))).status,
    ).toBe(200);
    await waitUntil(() => pendingOf(o, agent.id).length === 0, "settled");
    await waitUntil(
      () => o.srv.agentManager.getAgent(agent.id)!.modelFamily !== model,
      "model changed",
    );
  });

  it("refuses a clicked answer to an effort picker the owner opened", async () => {
    const o = await office();
    const agent = await chatAgent(o);
    await packCasey(o, { agents: "write", logs: "read" });
    const effort = o.srv.agentManager.getAgent(agent.id)!.effort;
    const { picker, index, choice } = await openPicker(o, agent.id, "/effort");
    expect(
      refusal(
        await call(
          o,
          { session: o.casey },
          "POST",
          `/api/agents/${agent.id}/interactions/${picker.id}/respond`,
          { value: choice.value },
        ),
      ),
    ).toEqual({ status: 403, code: "forbidden", area: "agentManagement" });
    expect(
      refusal(await send(o, { session: o.casey }, agent.id, String(index))),
    ).toEqual({ status: 403, code: "forbidden", area: "agentManagement" });
    expect(pendingOf(o, agent.id).map((p) => p.id)).toEqual([picker.id]);
    expect(o.srv.agentManager.getAgent(agent.id)!.effort).toBe(effort);

    // The owner's click settles it.
    const owned = await call(
      o,
      { session: o.owner },
      "POST",
      `/api/agents/${agent.id}/interactions/${picker.id}/respond`,
      { value: choice.value },
    );
    expect(owned.status).toBe(200);
    await waitUntil(
      () => o.srv.agentManager.getAgent(agent.id)!.effort !== effort,
      "effort changed",
    );
  });
});

describe("chat commands that read office data need office read", () => {
  it("refuses /isomux-storage to a pack member without office read", async () => {
    const o = await office();
    const agent = await chatAgent(o);
    await packCasey(o, { agents: "write", logs: "read" });
    expect(
      refusal(await send(o, { session: o.casey }, agent.id, "/isomux-storage")),
    ).toEqual({ status: 403, code: "forbidden", area: "office" });
    expect(echoesOf(o, agent.id, "/isomux-storage")).toBe(0);

    await packCasey(o, { agents: "write", logs: "read", office: "read" });
    expect(
      (await send(o, { session: o.casey }, agent.id, "/isomux-storage")).status,
    ).toBe(200);
    await waitUntil(
      () => echoesOf(o, agent.id, "/isomux-storage") === 1,
      "storage ran",
    );
  });
});
