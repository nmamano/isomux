// The member's Run of an ask's command (task c3b91695) through the real
// server and a real shell: the command runs in the agent's folder, the card
// gets the result, a success answers and closes the ask as the member, a
// failure keeps it open and tells the agent. Only a signed-in member who may
// use the agent's terminal panel runs it, and not for an agent below
// Standard access. A restart during a run leaves its result unknown.

import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { mintApiToken } from "../api-tokens.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";
import type { AskClosedWire } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 4000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(20);
  }
}

type Auth = { bearer?: string; rawSessionId?: string };
type Res = { status: number; code?: string; body: unknown };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: Auth,
  json?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    rawSessionId: auth.rawSessionId,
  });
  const parsed = await res.json().catch(() => null);
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    body: parsed,
  };
}

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

// Nil owns the office and manages Asker; Casey is a member in the same room
// with an agent of their own.
async function world() {
  server = await startTestServer({
    fakeBackend: new FakeBackend({
      storedSessionState: "durable",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    }),
  });
  const srv = server;
  const owner = await srv.seedOwner("Nil");
  const ownerId = getUserByName(owner.username)!.id;
  const casey = await srv.seedMember("Casey");
  const caseyId = getUserByName(casey.username)!.id;
  const [room] = srv.agentManager.getRooms();
  const access = await call(
    srv,
    "PUT",
    `/api/users/${casey.username}/access`,
    { rawSessionId: owner.rawSessionId },
    { allowedRooms: [room.id] },
  );
  expect(access.status).toBe(200);
  const spawn = async (
    name: string,
    manager: { username: string; id: string },
  ): Promise<AgentInfo & { folder: string }> => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "ask-run-")));
    folders.push(folder);
    const info = await srv.agentManager.spawn(
      name,
      folder,
      "default",
      undefined,
      undefined,
      room.id,
      undefined,
      undefined,
      undefined,
      manager.username,
      "claude",
      undefined,
      manager.id,
    );
    if (!info) throw new Error(`spawn ${name} failed`);
    return { ...info, folder };
  };
  const asker = await spawn("Asker", { username: owner.username, id: ownerId });
  const caseys = await spawn("Helper", {
    username: casey.username,
    id: caseyId,
  });
  const ownerSession = { rawSessionId: owner.rawSessionId };
  const caseySession = { rawSessionId: casey.rawSessionId };
  const agentAuth = (agentId: string) => ({
    bearer: getAgentTokenRaw(agentId)!,
  });
  const open = async (agentId: string, commands: string[]) => {
    const r = await call(
      srv,
      "POST",
      `/api/agents/${agentId}/asks`,
      agentAuth(agentId),
      {
        text: "Run the checks?",
        commands,
      },
    );
    expect(r.status).toBe(201);
    return (r.body as AskEntry).id;
  };
  const tap = (askId: string, command: string, auth: Auth = ownerSession) =>
    call(srv, "POST", `/api/asks/${askId}/run`, auth, { command });
  const listed = async (auth: Auth = ownerSession) =>
    (await call(srv, "GET", "/api/asks", auth)).body as AskEntry[];
  const entry = async (askId: string, auth: Auth = ownerSession) =>
    (await listed(auth)).find((e) => e.id === askId);
  return {
    srv,
    owner,
    ownerId,
    casey,
    caseyId,
    asker,
    caseys,
    ownerSession,
    caseySession,
    agentAuth,
    open,
    tap,
    entry,
  };
}

describe("a Run from the card", () => {
  it("runs in the agent's folder; a success shows on the card, answers the ask as the member and closes it", async () => {
    const w = await world();
    const ws = await w.srv.connectWs(w.owner.rawSessionId);
    const command = "pwd; echo ran-c3b91695";
    const askId = await w.open(w.asker.id, [command]);
    const r = await w.tap(askId, command);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ command, state: "running", by: w.ownerId });

    expect((await ws.waitFor("ask_removed", 4000)).id).toBe(askId);
    // The done run reached the card before the ask closed.
    const upserts = (ws.messages as Array<{ type?: string; entry?: AskEntry }>)
      .filter((m) => m.type === "ask_upserted" && m.entry?.id === askId)
      .map((m) => m.entry!);
    const doneRun = upserts.at(-1)?.runs?.find((x) => x.command === command);
    expect(doneRun).toMatchObject({ state: "done", exitCode: 0 });
    expect(doneRun?.output).toBe(`${w.asker.folder}\nran-c3b91695\n`);

    await waitUntil(
      () =>
        sentTexts(w.srv, w.asker.id).some((t) => t.includes("ran-c3b91695")),
      "the answer reached the agent",
    );
    const history = await call(
      w.srv,
      "GET",
      `/api/agents/${w.asker.id}/asks/history`,
      w.agentAuth(w.asker.id),
    );
    const [closed] = (history.body as { asks: AskClosedWire[] }).asks;
    expect(closed.id).toBe(askId);
    expect(closed.closed).toMatchObject({
      outcome: "replied",
      by: w.owner.username,
    });
    expect(closed.closed.answer).toContain("ran-c3b91695");
  });

  it("a failure keeps the ask open with the result on the card, and the agent gets a notice", async () => {
    const w = await world();
    const command = "echo boom-c3b91695 >&2; exit 3";
    const askId = await w.open(w.asker.id, [command]);
    expect((await w.tap(askId, command)).status).toBe(202);
    await waitUntil(
      async () => (await w.entry(askId))?.runs?.[0]?.state === "done",
      "the done run",
    );
    expect((await w.entry(askId))?.runs?.[0]).toMatchObject({
      command,
      state: "done",
      exitCode: 3,
      output: "boom-c3b91695\n",
    });
    await waitUntil(
      () =>
        sentTexts(w.srv, w.asker.id).some((t) => t.includes("boom-c3b91695")),
      "the notice",
    );
    // The member can run it again.
    expect((await w.tap(askId, command)).status).toBe(202);
  });
});

describe("who may tap Run", () => {
  it("not the agent, not an API token of the member, not another member who cannot see the ask", async () => {
    const w = await world();
    const command = "echo never-c3b91695";
    const askId = await w.open(w.asker.id, [command]);
    const token = {
      bearer: (
        await mintApiToken({
          userId: w.ownerId,
          name: "Nil",
          expiresInDays: null,
        })
      ).token,
    };
    const outcomes = [];
    for (const [who, auth] of [
      ["agent", w.agentAuth(w.asker.id)],
      ["api token", token],
      ["casey", w.caseySession],
    ] as const) {
      const r = await w.tap(askId, command, auth);
      outcomes.push(`${who} ${r.status}`);
    }
    expect(outcomes).toEqual(["agent 403", "api token 403", "casey 404"]);
    await sleep(100);
    expect(
      sentTexts(w.srv, w.asker.id).some((t) => t.includes("never-c3b91695")),
    ).toBe(false);
    expect((await w.entry(askId))?.runs ?? []).toEqual([]);
  });

  it("not a member with a permission pack, who has no terminal panel", async () => {
    const w = await world();
    const command = "echo never-c3b91695";
    const askId = await w.open(w.caseys.id, [command]);
    // Casey sees and answers the ask before the pack.
    expect((await w.entry(askId, w.caseySession))?.id).toBe(askId);
    const packed = await call(
      w.srv,
      "PUT",
      `/api/users/${w.casey.username}/access`,
      w.ownerSession,
      {
        allowedRooms: [w.caseys.roomId],
        // Every pack ceiling is below Standard: the agent moves down too,
        // and the member's own refusal answers first.
        pack: {
          areas: { asks: "write", agents: "write" },
          agentCeiling: "web",
        },
      },
    );
    expect(packed.status).toBe(200);
    expect((await w.entry(askId, w.caseySession))?.id).toBe(askId);
    const r = await w.tap(askId, command, w.caseySession);
    expect(`${r.status} ${r.code}`).toBe("403 terminal_forbidden");
  });

  it("not for an agent below Standard access", async () => {
    const w = await world();
    const command = "echo never-c3b91695";
    const askId = await w.open(w.asker.id, [command]);
    const lowered = await call(
      w.srv,
      "PUT",
      `/api/agents/${w.asker.id}/access`,
      w.ownerSession,
      { access: "chat" },
    );
    expect(lowered.status).toBe(200);
    const r = await w.tap(askId, command);
    expect(`${r.status} ${r.code}`).toBe("403 agent_limited");
    expect((await w.entry(askId))?.runs ?? []).toEqual([]);
  });
});

describe("a restart during a run", () => {
  it("marks the run lost on the card, keeps the ask, and tells the agent its result is unknown", async () => {
    const w = await world();
    const command = "make deploy-c3b91695";
    const askId = await w.open(w.asker.id, [command]);
    // The run as a server that stopped mid-run leaves it on disk.
    const path = join(w.srv.stateRoot, "asks.json");
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as AskEntry[];
    const seeded = onDisk.map((e) =>
      e.id === askId
        ? {
            ...e,
            runs: [
              {
                command,
                by: w.ownerId,
                startedAt: Date.now(),
                state: "running",
              },
            ],
          }
        : e,
    );
    writeFileSync(path, JSON.stringify(seeded, null, 2));
    server = await w.srv.restart();
    const srv = server;
    const listed = (await call(srv, "GET", "/api/asks", w.ownerSession))
      .body as AskEntry[];
    expect(listed.find((e) => e.id === askId)?.runs?.[0]).toMatchObject({
      command,
      state: "lost",
    });
    await waitUntil(
      () => sentTexts(srv, w.asker.id).some((t) => t.includes(command)),
      "the restart notice",
    );
  });
});
