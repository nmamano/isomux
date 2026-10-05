// Cronjobs belong to a room (task f0679cfe). Who sees a job, on every
// surface: the REST list/get, the system prompt, runs and transcripts, the
// WebSocket state and deltas, run updates and live run entries, run files, and
// the /isomux-cronjob-system-prompt picker.
//
//   SEE    - maker, office owners, members of the job's live room: the whole
//            job, runs and transcripts included.
//   MANAGE - maker and office owners only. Room access never widens it.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { saveRuns, appendRunLog } from "../cronjob-persistence.ts";
import { saveFile } from "../persistence.ts";
import {
  cronjobRunStreamId,
  type AgentInfo,
  type Cronjob,
  type CronjobListWire,
  type CronjobRun,
} from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
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

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

const PROMPT = "PRIVATE_PROMPT_MARKER";

function createBody(
  srv: TestServer,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Nightly",
    schedule: { type: "interval", minutes: 60 },
    prompt: PROMPT,
    cwd: srv.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    ...over,
  };
}

function seedJob(
  srv: TestServer,
  username: string,
  roomId: string | undefined,
  name = "Seed",
): Cronjob {
  return srv.cronjobManager.addCronjob({
    name,
    schedule: { type: "interval", minutes: 60 },
    prompt: PROMPT,
    cwd: srv.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username,
    userId: getUserByName(username)?.id ?? null,
    roomId,
  });
}

function seedRun(job: Cronjob, runId: string): CronjobRun {
  const run: CronjobRun = {
    id: runId,
    cronjobId: job.id,
    cronjobName: job.name,
    trigger: "scheduled",
    status: "completed",
    startedAt: 1700000000000,
    endedAt: 1700000060000,
    errorReason: null,
    promptSnapshot: job.prompt,
    agentTypeSnapshot: job.agentType,
    modelFamilySnapshot: job.modelFamily,
    effortSnapshot: job.effort,
    cwdSnapshot: job.cwd,
    permissionModeSnapshot: job.permissionMode,
    rootSessionId: "rsess-1",
    currentSessionId: "rsess-1",
    previewText: "transcript excerpt",
  };
  saveRuns(job.id, [run]);
  appendRunLog(job.id, runId, "rsess-1", {
    id: "entry-1",
    agentId: cronjobRunStreamId(runId),
    timestamp: 1700000030000,
    kind: "text",
    content: "transcript line",
  });
  return run;
}

// An office with an owner, two rooms, and three members: Alice (room A),
// Bob (room B), Maker (room A, makes jobs).
async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Boss");
  const roomA = srv.agentManager.createRoom("Alpha");
  const roomB = srv.agentManager.createRoom("Beta");
  const alice = await srv.seedMember("Alice");
  const bob = await srv.seedMember("Bob");
  const maker = await srv.seedMember("Maker");
  const grant = (name: string, rooms: string[]) =>
    expect(
      updateUserById(getUserByName(name)!.id, { allowedRooms: rooms }).ok,
    ).toBe(true);
  grant("Alice", [roomA]);
  grant("Bob", [roomB]);
  grant("Maker", [roomA]);
  return { srv, owner, alice, bob, maker, roomA, roomB, grant };
}

const ids = (r: Res) => (r.body as CronjobListWire[]).map((c) => c.id);
const typesOf = (sock: TestSocket) =>
  sock.messages.map((m) => (m as { type?: string }).type);

describe("cron rooms: who sees a cronjob over REST", () => {
  it("a room member gets the whole record without manage authority; a non-member gets 404; the maker and owners may manage", async () => {
    const { srv, owner, alice, bob, maker, roomA } = await office();
    const job = seedJob(srv, "Maker", roomA, "Report");

    const asAlice = await api(srv, `/api/cronjobs/${job.id}`, {
      rawSessionId: alice.rawSessionId,
    });
    expect(asAlice.status).toBe(200);
    expect(asAlice.body).toMatchObject({
      id: job.id,
      name: "Report",
      canManage: false,
      roomId: roomA,
      prompt: PROMPT,
      cwd: srv.stateRoot,
      modelFamily: "opus",
    });

    expect(
      (
        await api(srv, `/api/cronjobs/${job.id}`, {
          rawSessionId: bob.rawSessionId,
        })
      ).status,
    ).toBe(404);
    expect(
      ids(await api(srv, "/api/cronjobs", { rawSessionId: bob.rawSessionId })),
    ).not.toContain(job.id);

    for (const who of [maker, owner]) {
      const full = await api(srv, `/api/cronjobs/${job.id}`, {
        rawSessionId: who.rawSessionId,
      });
      expect(full.body).toMatchObject({ canManage: true, prompt: PROMPT });
    }
  });

  it("a roomless job (every stored job written before rooms) is the maker's and office owners' only", async () => {
    const { srv, owner, alice, maker } = await office();
    const job = seedJob(srv, "Maker", undefined, "Legacy");
    expect(job.roomId).toBeUndefined();
    expect(
      ids(
        await api(srv, "/api/cronjobs", { rawSessionId: alice.rawSessionId }),
      ),
    ).not.toContain(job.id);
    for (const who of [maker, owner]) {
      expect(
        ids(
          await api(srv, "/api/cronjobs", { rawSessionId: who.rawSessionId }),
        ),
      ).toContain(job.id);
    }
  });

  it("closing the room leaves the job to its maker and owners, and it keeps its schedule", async () => {
    const { srv, alice, maker } = await office();
    const roomC = srv.agentManager.createRoom("Gamma");
    updateUserById(getUserByName("Alice")!.id, { allowedRooms: [roomC] });
    updateUserById(getUserByName("Maker")!.id, { allowedRooms: [roomC] });
    const job = seedJob(srv, "Maker", roomC, "Orphan");
    expect(
      ids(
        await api(srv, "/api/cronjobs", { rawSessionId: alice.rawSessionId }),
      ),
    ).toContain(job.id);

    expect(srv.agentManager.closeRoom(roomC)).toBe(true);
    expect(
      ids(
        await api(srv, "/api/cronjobs", { rawSessionId: alice.rawSessionId }),
      ),
    ).not.toContain(job.id);
    expect(
      ids(
        await api(srv, "/api/cronjobs", { rawSessionId: maker.rawSessionId }),
      ),
    ).toContain(job.id);
    const stored = srv.cronjobManager
      .listCronjobs()
      .find((c) => c.id === job.id)!;
    expect(stored.enabled).toBe(true);
    expect(stored.roomId).toBe(roomC);
  });
});

describe("cron rooms: runs, transcripts and the system prompt follow SEE", () => {
  it("a room member reads the system prompt, the run list and a transcript; a non-member gets 404; listAllRuns follows suit", async () => {
    const { srv, owner, alice, bob, maker, roomA } = await office();
    const job = seedJob(srv, "Maker", roomA);
    seedRun(job, "run00001");

    for (const path of [
      `/api/cronjobs/${job.id}/system-prompt`,
      `/api/cronjobs/${job.id}/runs`,
      `/api/cronjobs/${job.id}/runs/run00001`,
    ]) {
      const denied = await api(srv, path, { rawSessionId: bob.rawSessionId });
      expect(denied.status).toBe(404);
      expect(JSON.stringify(denied.body)).not.toContain(PROMPT);
      for (const who of [alice, maker, owner]) {
        expect(
          (await api(srv, path, { rawSessionId: who.rawSessionId })).status,
        ).toBe(200);
      }
    }

    const allRuns = (who: string) =>
      api(srv, "/api/cron-runs", { rawSessionId: who }).then((r) =>
        (r.body as { jobs: { cronjobId: string }[] }).jobs.map(
          (j) => j.cronjobId,
        ),
      );
    expect(await allRuns(bob.rawSessionId)).not.toContain(job.id);
    expect(await allRuns(alice.rawSessionId)).toContain(job.id);
    expect(await allRuns(maker.rawSessionId)).toContain(job.id);
    expect(await allRuns(owner.rawSessionId)).toContain(job.id);
  });

  it("runs of a deleted job are office owners' only", async () => {
    const { srv, owner, maker, roomA } = await office();
    const job = seedJob(srv, "Maker", roomA);
    seedRun(job, "run00002");
    srv.cronjobManager.deleteCronjob(job.id);
    const path = `/api/cronjobs/${job.id}/runs/run00002`;
    expect(
      (await api(srv, path, { rawSessionId: maker.rawSessionId })).status,
    ).toBe(404);
    expect(
      (await api(srv, path, { rawSessionId: owner.rawSessionId })).status,
    ).toBe(200);
  });

  it("run files follow SEE, and an unknown run's files deny even an owner", async () => {
    const { srv, owner, alice, bob, maker, roomA } = await office();
    const job = seedJob(srv, "Maker", roomA);
    seedRun(job, "run00003");
    const stream = cronjobRunStreamId("run00003");
    const saved = saveFile(
      stream,
      Buffer.from("run output"),
      "text/plain",
      "out.txt",
    )!;
    const orphan = cronjobRunStreamId("run99999");
    saveFile(orphan, Buffer.from("x"), "text/plain", "out.txt");
    const fileStatus = async (who: string, streamId: string) =>
      (
        await srv.http(`/api/files/${streamId}/${saved.filename}`, {
          rawSessionId: who,
        })
      ).status;
    expect(await fileStatus(bob.rawSessionId, stream)).toBe(404);
    expect(await fileStatus(alice.rawSessionId, stream)).toBe(200);
    expect(await fileStatus(maker.rawSessionId, stream)).toBe(200);
    expect(await fileStatus(owner.rawSessionId, stream)).toBe(200);
    expect(await fileStatus(owner.rawSessionId, orphan)).toBe(404);
  });
});

describe("cron rooms: create and move", () => {
  it('a member files into a room they can access, gets 404 for one they cannot, and "" means no room', async () => {
    const { srv, maker, roomA, roomB } = await office();
    const inA = await api(srv, "/api/cronjobs", {
      method: "POST",
      rawSessionId: maker.rawSessionId,
      body: createBody(srv, { roomId: roomA }),
    });
    expect(inA.status).toBe(201);
    expect(inA.body).toMatchObject({ roomId: roomA, canManage: true });

    const before = srv.cronjobManager.listCronjobs().length;
    const inB = await api(srv, "/api/cronjobs", {
      method: "POST",
      rawSessionId: maker.rawSessionId,
      body: createBody(srv, { roomId: roomB }),
    });
    expect(inB.status).toBe(404);
    expect(srv.cronjobManager.listCronjobs().length).toBe(before);

    const none = await api(srv, "/api/cronjobs", {
      method: "POST",
      rawSessionId: maker.rawSessionId,
      body: createBody(srv, { roomId: "" }),
    });
    expect(none.status).toBe(201);
    expect(none.body).not.toHaveProperty("roomId");
  });

  it("a privileged agent's cronjob defaults to the agent's room; an explicit room follows task rules", async () => {
    const { srv, roomA, roomB } = await office();
    const makerId = getUserByName("Maker")!.id;
    const bot = await spawnAgent(srv, "CronBot", roomA);
    const token = mintAgentToken(bot.id, makerId, true);
    const created = await api(srv, "/api/cronjobs", {
      method: "POST",
      bearer: token,
      body: createBody(srv),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ roomId: roomA, canManage: true });

    expect(
      (
        await api(srv, "/api/cronjobs", {
          method: "POST",
          bearer: token,
          body: createBody(srv, { roomId: roomB }),
        })
      ).status,
    ).toBe(404);
  });

  it("the room stays put when the maker agent moves", async () => {
    const { srv, roomA, roomB } = await office();
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "Mover", roomA);
    const token = mintAgentToken(bot.id, ownerId, true);
    const created = (
      await api(srv, "/api/cronjobs", {
        method: "POST",
        bearer: token,
        body: createBody(srv),
      })
    ).body as Cronjob;
    expect(created.roomId).toBe(roomA);
    expect(srv.agentManager.moveAgent(bot.id, roomB)).toBe(true);
    expect(
      srv.cronjobManager.listCronjobs().find((c) => c.id === created.id)
        ?.roomId,
    ).toBe(roomA);
  });

  it("only the maker or an owner moves a job; a room member cannot", async () => {
    const { srv, alice, maker, roomA } = await office();
    const job = seedJob(srv, "Maker", roomA);
    expect(
      (
        await api(srv, `/api/cronjobs/${job.id}`, {
          method: "PATCH",
          rawSessionId: alice.rawSessionId,
          body: { roomId: "" },
        })
      ).status,
    ).toBe(403);
    const moved = await api(srv, `/api/cronjobs/${job.id}`, {
      method: "PATCH",
      rawSessionId: maker.rawSessionId,
      body: { roomId: "" },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).not.toHaveProperty("roomId");
    // An edit without roomId keeps the room.
    const back = await api(srv, `/api/cronjobs/${job.id}`, {
      method: "PATCH",
      rawSessionId: maker.rawSessionId,
      body: { roomId: roomA },
    });
    expect(back.body).toMatchObject({ roomId: roomA });
    const renamed = await api(srv, `/api/cronjobs/${job.id}`, {
      method: "PATCH",
      rawSessionId: maker.rawSessionId,
      body: { name: "Renamed" },
    });
    expect(renamed.body).toMatchObject({ roomId: roomA, name: "Renamed" });
  });

  it("an API token of the maker sees and manages the job; one of another member does not see it", async () => {
    const { srv, roomA } = await office();
    const job = seedJob(srv, "Maker", undefined);
    const makerToken = await mintApiToken({
      userId: getUserByName("Maker")!.id,
      name: "Laptop",
      expiresInDays: null,
    });
    const aliceToken = await mintApiToken({
      userId: getUserByName("Alice")!.id,
      name: "Laptop",
      expiresInDays: null,
    });
    const asMaker = await api(srv, `/api/cronjobs/${job.id}`, {
      bearer: makerToken.token,
    });
    expect(asMaker.body).toMatchObject({ canManage: true });
    expect(
      (await api(srv, `/api/cronjobs/${job.id}`, { bearer: aliceToken.token }))
        .status,
    ).toBe(404);
    // Filed into room A, Alice's token sees it without manage authority.
    srv.cronjobManager.updateCronjob(job.id, { roomId: roomA });
    expect(
      (await api(srv, `/api/cronjobs/${job.id}`, { bearer: aliceToken.token }))
        .body,
    ).toMatchObject({ prompt: PROMPT, canManage: false });
  });
});

describe("cron rooms: the WebSocket", () => {
  it("cronjobs_state and deltas are projected per socket; a non-member hears nothing", async () => {
    const { srv, alice, bob, maker, roomA, roomB } = await office();
    const aliceWs = await srv.connectWs(alice.rawSessionId);
    const bobWs = await srv.connectWs(bob.rawSessionId);
    const makerWs = await srv.connectWs(maker.rawSessionId);
    await aliceWs.waitFor("cronjobs_state");
    await bobWs.waitFor("cronjobs_state");

    const job = seedJob(srv, "Maker", roomA, "Live");
    const added = await aliceWs.waitFor("cronjob_added");
    expect(added.cronjob).toMatchObject({
      id: job.id,
      prompt: PROMPT,
      canManage: false,
    });
    const makerAdded = await makerWs.waitFor("cronjob_added");
    expect(makerAdded.cronjob).toMatchObject({
      prompt: PROMPT,
      canManage: true,
    });

    // Moving the job to room B: Alice is told it is gone, Bob learns it.
    srv.cronjobManager.updateCronjob(job.id, { roomId: roomB });
    await waitUntil(
      () =>
        aliceWs.messages.some(
          (m) =>
            (m as { type?: string }).type === "cronjob_deleted" &&
            (m as { id?: string }).id === job.id,
        ),
      "alice cronjob_deleted",
    );
    const bobUpdate = await bobWs.waitFor("cronjob_updated");
    expect(bobUpdate.cronjob).toMatchObject({ id: job.id, canManage: false });
    expect(typesOf(bobWs)).not.toContain("cronjob_added");

    // A connect hydrates only what the socket may see.
    const aliceAgain = await srv.connectWs(alice.rawSessionId);
    const state = await aliceAgain.waitFor("cronjobs_state");
    expect(state.cronjobs as CronjobListWire[]).toEqual([]);
  });

  it("run rows and live run entries reach the maker and room members; a non-member hears none", async () => {
    const { srv, alice, bob, maker, roomA } = await office();
    const job = seedJob(srv, "Maker", roomA, "Runner");
    const aliceWs = await srv.connectWs(alice.rawSessionId);
    const bobWs = await srv.connectWs(bob.rawSessionId);
    const makerWs = await srv.connectWs(maker.rawSessionId);
    await aliceWs.waitFor("cronjobs_state");
    await bobWs.waitFor("cronjobs_state");
    await makerWs.waitFor("cronjobs_state");

    const run = srv.cronjobManager.runCronjobNow(job.id, "Maker")!;
    const sawCompleted = (sock: TestSocket) =>
      sock.messages.some(
        (m) =>
          (m as { type?: string }).type === "cronjob_run_updated" &&
          (m as { run?: CronjobRun }).run?.status === "completed",
      );
    await waitUntil(
      () => sawCompleted(makerWs) && sawCompleted(aliceWs),
      "maker and alice see the run complete",
      5000,
    );
    const stream = cronjobRunStreamId(run.id);
    const sawRunEntry = (sock: TestSocket) =>
      sock.messages.some(
        (m) =>
          (m as { type?: string }).type === "log_entry" &&
          (m as { entry?: { agentId?: string } }).entry?.agentId === stream,
      );
    expect(sawRunEntry(makerWs)).toBe(true);
    expect(sawRunEntry(aliceWs)).toBe(true);
    expect(sawRunEntry(bobWs)).toBe(false);
    expect(typesOf(bobWs)).not.toContain("cronjob_run_updated");
    expect(JSON.stringify(bobWs.messages)).not.toContain(PROMPT);
  });

  it("losing room access re-projects the list live", async () => {
    const { srv, owner, alice, roomA, roomB } = await office();
    const job = seedJob(srv, "Maker", roomA);
    const aliceWs = await srv.connectWs(alice.rawSessionId);
    const first = await aliceWs.waitFor("cronjobs_state");
    expect((first.cronjobs as CronjobListWire[]).map((c) => c.id)).toEqual([
      job.id,
    ]);
    const states = () =>
      aliceWs.messages.filter(
        (m) => (m as { type?: string }).type === "cronjobs_state",
      ) as { cronjobs: CronjobListWire[] }[];
    const res = await api(srv, "/api/users/Alice/access", {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { allowedRooms: [roomB] },
    });
    expect(res.status).toBeLessThan(300);
    await waitUntil(() => states().length >= 2, "a second cronjobs_state");
    expect(states().at(-1)!.cronjobs).toEqual([]);
  });

  it("closing a room re-projects room members' lists live", async () => {
    const { srv, owner, alice } = await office();
    const roomC = srv.agentManager.createRoom("Gamma");
    updateUserById(getUserByName("Alice")!.id, { allowedRooms: [roomC] });
    seedJob(srv, "Maker", roomC);
    const aliceWs = await srv.connectWs(alice.rawSessionId);
    const first = await aliceWs.waitFor("cronjobs_state");
    expect((first.cronjobs as CronjobListWire[]).length).toBe(1);
    const states = () =>
      aliceWs.messages.filter(
        (m) => (m as { type?: string }).type === "cronjobs_state",
      ) as { cronjobs: CronjobListWire[] }[];
    const res = await api(srv, `/api/rooms/${roomC}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBeLessThan(300);
    await waitUntil(() => states().length >= 2, "a second cronjobs_state");
    expect(states().at(-1)!.cronjobs).toEqual([]);
  });
});

describe("cron rooms: /isomux-cronjob-system-prompt", () => {
  async function sendHuman(
    srv: TestServer,
    rawSessionId: string,
    agentId: string,
    text: string,
  ) {
    const res = await srv.http(`/api/agents/${agentId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      rawSessionId,
    });
    expect(res.status).toBeLessThan(400);
  }

  it("lists and resolves only the jobs the typing member may see", async () => {
    const { srv, alice, roomA, roomB } = await office();
    const makersJob = seedJob(srv, "Maker", roomA, "Makers job");
    const bossJob = seedJob(srv, "Boss", roomA, "Boss job");
    const betaJob = seedJob(srv, "Boss", roomB, "Beta job");
    const agent = await spawnAgent(srv, "Picker", roomA);
    const markerFor = (jobId: string) =>
      srv.agentManager
        .getAgentLogs(agent.id)
        .some((entry) => entry.metadata?.cronjobId === jobId);

    const ran = (text: string) =>
      srv.agentManager
        .getAgentLogs(agent.id)
        .some(
          (entry) => entry.kind === "user_message" && entry.content === text,
        );

    // Alice cannot see the room B job.
    const hidden = `/isomux-cronjob-system-prompt ${betaJob.id}`;
    await sendHuman(srv, alice.rawSessionId, agent.id, hidden);
    expect(ran(hidden)).toBe(true);
    expect(markerFor(betaJob.id)).toBe(false);

    await sendHuman(
      srv,
      alice.rawSessionId,
      agent.id,
      "/isomux-cronjob-system-prompt",
    );
    const interaction = srv.agentManager
      .getPendingInteractions()
      .find((item) => item.agentId === agent.id);
    expect(interaction?.choices.map((c) => c.value).sort()).toEqual(
      [makersJob.id, bossJob.id].sort(),
    );

    await sendHuman(
      srv,
      alice.rawSessionId,
      agent.id,
      `/isomux-cronjob-system-prompt ${makersJob.id}`,
    );
    expect(markerFor(makersJob.id)).toBe(true);
  });
});
