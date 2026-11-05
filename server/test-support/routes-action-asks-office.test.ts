// Action asks, part 5 (task e3d1bc63): a member's removal, restore and
// delete for good, and the storage prune and compress, run from the card.
// The create refuses what the member could not run or what is done; the run
// dispatches the page's route as the member, with the ask on its audit row;
// the ask closes when the state reaches the value, by the card or by hand on
// the page. The office update is in server/step-asks.test.ts: no test boot
// may launch the updater.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import { REMOVED_MEMBER_RETENTION_MS } from "../removed-members.ts";
import { STATE_ROOT } from "../config.ts";
import type { AgentInfo, AskEntry, AskStep } from "../../shared/types.ts";
import type { RemovedMemberWire } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

interface Res {
  status: number;
  body: unknown;
}

// Morgan owns the office; Casey and Dana are members with its first room.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const casey = await srv.seedMember("Casey");
  const dana = await srv.seedMember("Dana");
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
    dana: dana.rawSessionId,
    danaName: dana.username,
    danaId: getUserByName(dana.username)!.id,
  };
  for (const name of [o.caseyName, o.danaName])
    expect(
      (
        await asSession(o, o.morgan, "PUT", `/api/users/${name}/access`, {
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
  manager: "Morgan" | "Casey" | "Dana" = "Morgan",
): Promise<AgentInfo> {
  const cwd = mkdtempSync(join(tmpdir(), "action-asks-office-"));
  folders.push(cwd);
  const [username, userId] =
    manager === "Morgan"
      ? [o.morganName, o.morganId]
      : manager === "Casey"
        ? [o.caseyName, o.caseyId]
        : [o.danaName, o.danaId];
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
  o: Office,
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

const ask = (o: Office, askerId: string, step: Record<string, unknown>) =>
  asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Please do this.",
    step,
  });

async function opened(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
): Promise<AskEntry> {
  const res = await ask(o, askerId, step);
  expect(outcome(res)).toEqual({ status: 201, code: undefined });
  return res.body as AskEntry;
}

// "open", the closed ask's outcome, or the status of a refused read.
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

const run = (o: Office, session: string, askId: string) =>
  asSession(o, session, "POST", `/api/asks/${askId}/action`);

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

// An ask that must stay open: a hook had time to run and did not close it.
async function staysOpen(o: Office, askerId: string, askId: string) {
  await Bun.sleep(100);
  expect(await askStatus(o, askerId, askId)).toBe("open");
}

// The step lines in the agent's chat.
const stepLines = (o: Office, agentId: string) =>
  o.srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => JSON.stringify(e).match(/systemEntries\.stepAsk\.\w+/)?.[0])
    .filter((key): key is string => key !== undefined);

// The rows of `operation` that name the ask, as [actor kind, actor id].
const auditRows = (operation: string, askId: string) =>
  officeAuditStore()
    .list({ operation, limit: 1000 })
    .items.filter((r) => r.targets.includes(askId))
    .map((r) => [r.actor.kind, r.actor.id]);

const removedIds = async (o: Office) => {
  const res = await asSession(o, o.morgan, "GET", "/api/removed-members");
  expect(res.status).toBe(200);
  return (res.body as { members: RemovedMemberWire[] }).members.map(
    (m) => m.user.id,
  );
};

const removeByHand = async (o: Office, username: string) =>
  expect(
    (await asSession(o, o.morgan, "DELETE", `/api/users/${username}`)).status,
  ).toBeLessThan(300);

const removeStep = (username: string) => ({ kind: "member-remove", username });
const restoreStep = (username: string, agents?: boolean) => ({
  kind: "member-restore",
  username,
  ...(agents === undefined ? {} : { agents }),
});
const purgeStep = (username: string) => ({ kind: "member-purge", username });

describe("a member-remove ask", () => {
  it("opens for an owner for a member and for a member for themself, stored by id; nothing runs at the create", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    const forCasey = await opened(o, asker.id, removeStep(o.caseyName));
    expect([forCasey.step, forCasey.link]).toEqual([
      { kind: "member-remove", userId: o.caseyId },
      undefined,
    ]);
    const own = await opened(o, caseys.id, removeStep(o.caseyName));
    expect(own.step).toEqual({ kind: "member-remove", userId: o.caseyId });
    expect(getUserByName(o.caseyName)?.id).toBe(o.caseyId);
    expect(await removedIds(o)).toEqual([]);
  });

  it("refuses another member's removal for a member (403), an owner's own (403), an unknown member (422) and a bad shape (400)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    expect(outcome(await ask(o, caseys.id, removeStep(o.danaName)))).toEqual(
      refused(403, "member_not_allowed"),
    );
    expect(outcome(await ask(o, asker.id, removeStep(o.morganName)))).toEqual(
      refused(403, "owner_self_delete"),
    );
    expect(outcome(await ask(o, asker.id, removeStep("nobody")))).toEqual(
      refused(422, "unknown_member"),
    );
    for (const step of [
      { kind: "member-remove" },
      { kind: "member-remove", userId: o.caseyId },
      { kind: "member-remove", username: o.caseyName, agents: true },
    ])
      expect(outcome(await ask(o, asker.id, step))).toEqual(
        refused(400, "invalid_request"),
      );
    expect(getUserByName(o.danaName)?.id).toBe(o.danaId);
  });

  it("runs the delete as the owner: the member is in Removed members and signed out, the ask closes with one line, one users.delete row names the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, removeStep(o.caseyName));
    expect((await asSession(o, o.casey, "GET", "/api/sessions")).status).toBe(
      200,
    );
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBeLessThan(300);
    expect(getUserByName(o.caseyName)).toBeFalsy();
    expect(await removedIds(o)).toEqual([o.caseyId]);
    expect((await asSession(o, o.casey, "GET", "/api/sessions")).status).toBe(
      401,
    );
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    expect(auditRows("users.delete", entry.id)).toEqual([
      ["member", o.morganId],
    ]);
  });

  it("removes the member under the name they have at the run, after a rename", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, removeStep(o.caseyName));
    const renamed = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/users/${o.caseyName}`,
      { name: "Cassidy" },
    );
    expect(renamed.status).toBe(200);
    expect(getUserByName("Cassidy")?.id).toBe(o.caseyId);
    expect((await run(o, o.morgan, entry.id)).status).toBeLessThan(300);
    expect(getUserByName("Cassidy")).toBeFalsy();
    expect(await removedIds(o)).toEqual([o.caseyId]);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("a member's own removal from the card: they are removed and signed out, and their ask still closes with one line in the agent's chat", async () => {
    const o = await office();
    const caseys = await spawn(o, "Helper", "Casey");
    const entry = await opened(o, caseys.id, removeStep(o.caseyName));
    expect((await run(o, o.casey, entry.id)).status).toBeLessThan(300);
    expect(await removedIds(o)).toEqual([o.caseyId]);
    expect((await asSession(o, o.casey, "GET", "/api/sessions")).status).toBe(
      401,
    );
    await closedAsDone(o, caseys.id, entry.id);
    expect(stepLines(o, caseys.id)).toHaveLength(1);
    expect(auditRows("users.delete", entry.id)).toEqual([
      ["member", o.caseyId],
    ]);
  });

  it("a removal by hand on the Members page closes it; another member's removal does not", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, removeStep(o.caseyName));
    await removeByHand(o, o.danaName);
    await staysOpen(o, asker.id, entry.id);
    await removeByHand(o, o.caseyName);
    await closedAsDone(o, asker.id, entry.id);
  });
});

describe("a member-restore ask", () => {
  it("opens for an owner for a removed member, stored by id with agents on unless the step turns them off", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await removeByHand(o, o.caseyName);
    const plain = await opened(o, asker.id, restoreStep(o.caseyName));
    expect(plain.step).toEqual({
      kind: "member-restore",
      userId: o.caseyId,
      agents: true,
    });
    const off = await opened(o, asker.id, restoreStep(o.caseyName, false));
    expect(off.step).toEqual({
      kind: "member-restore",
      userId: o.caseyId,
      agents: false,
    });
    expect(getUserByName(o.caseyName)).toBeFalsy();
  });

  it("refuses a live member or nobody (422), a member's ask (403), and a bad shape (400)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const danas = await spawn(o, "Helper", "Dana");
    await removeByHand(o, o.caseyName);
    expect(outcome(await ask(o, asker.id, restoreStep(o.danaName)))).toEqual(
      refused(422, "unknown_member"),
    );
    expect(outcome(await ask(o, asker.id, restoreStep("nobody")))).toEqual(
      refused(422, "unknown_member"),
    );
    expect(outcome(await ask(o, danas.id, restoreStep(o.caseyName)))).toEqual(
      refused(403, "member_not_allowed"),
    );
    for (const step of [
      { kind: "member-restore" },
      { kind: "member-restore", username: o.caseyName, agents: "yes" },
      { kind: "member-restore", userId: o.caseyId },
    ])
      expect(outcome(await ask(o, asker.id, step))).toEqual(
        refused(400, "invalid_request"),
      );
  });

  it("runs the restore as the owner: the same member is back, their agent with them; the ask closes, one users.restore row names the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    await removeByHand(o, o.caseyName);
    expect(o.srv.agentManager.getAgent(caseys.id)?.userId).toBe(o.morganId);
    const entry = await opened(o, asker.id, restoreStep(o.caseyName));
    expect((await run(o, o.morgan, entry.id)).status).toBeLessThan(300);
    expect(getUserByName(o.caseyName)?.id).toBe(o.caseyId);
    expect(await removedIds(o)).toEqual([]);
    expect(o.srv.agentManager.getAgent(caseys.id)?.userId).toBe(o.caseyId);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    expect(auditRows("users.restore", entry.id)).toEqual([
      ["member", o.morganId],
    ]);
  });

  it("with agents off, the restore leaves the member's agent with the heir", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    await removeByHand(o, o.caseyName);
    const entry = await opened(o, asker.id, restoreStep(o.caseyName, false));
    expect((await run(o, o.morgan, entry.id)).status).toBeLessThan(300);
    expect(getUserByName(o.caseyName)?.id).toBe(o.caseyId);
    expect(o.srv.agentManager.getAgent(caseys.id)?.userId).toBe(o.morganId);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("a restore by hand on the Removed members page closes it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await removeByHand(o, o.caseyName);
    await removeByHand(o, o.danaName);
    const entry = await opened(o, asker.id, restoreStep(o.caseyName));
    const other = await asSession(
      o,
      o.morgan,
      "POST",
      `/api/removed-members/${o.danaId}/restore`,
      { agents: true },
    );
    expect(other.status).toBeLessThan(300);
    await staysOpen(o, asker.id, entry.id);
    const byHand = await asSession(
      o,
      o.morgan,
      "POST",
      `/api/removed-members/${o.caseyId}/restore`,
      { agents: true },
    );
    expect(byHand.status).toBeLessThan(300);
    await closedAsDone(o, asker.id, entry.id);
  });
});

describe("a member-purge ask", () => {
  it("opens for an owner for a removed member, stored by id; refuses a live member or nobody (422) and a member's ask (403)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const danas = await spawn(o, "Helper", "Dana");
    await removeByHand(o, o.caseyName);
    const entry = await opened(o, asker.id, purgeStep(o.caseyName));
    expect(entry.step).toEqual({ kind: "member-purge", userId: o.caseyId });
    expect(await removedIds(o)).toEqual([o.caseyId]);
    expect(outcome(await ask(o, asker.id, purgeStep(o.danaName)))).toEqual(
      refused(422, "unknown_member"),
    );
    expect(outcome(await ask(o, asker.id, purgeStep("nobody")))).toEqual(
      refused(422, "unknown_member"),
    );
    expect(outcome(await ask(o, danas.id, purgeStep(o.caseyName)))).toEqual(
      refused(403, "member_not_allowed"),
    );
  });

  it("runs Delete now as the owner: the member is gone from Removed members and not live; the ask closes, one users.purge row names the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await removeByHand(o, o.caseyName);
    const entry = await opened(o, asker.id, purgeStep(o.caseyName));
    expect((await run(o, o.morgan, entry.id)).status).toBeLessThan(300);
    expect(await removedIds(o)).toEqual([]);
    expect(getUserByName(o.caseyName)).toBeFalsy();
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    expect(auditRows("users.purge", entry.id)).toEqual([
      ["member", o.morganId],
    ]);
  });

  it("a member restored meanwhile: the ask stays open, and a run deletes nothing and leaves it open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await removeByHand(o, o.caseyName);
    const entry = await opened(o, asker.id, purgeStep(o.caseyName));
    const restored = await asSession(
      o,
      o.morgan,
      "POST",
      `/api/removed-members/${o.caseyId}/restore`,
      { agents: true },
    );
    expect(restored.status).toBeLessThan(300);
    await staysOpen(o, asker.id, entry.id);
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(getUserByName(o.caseyName)?.id).toBe(o.caseyId);
    expect(auditRows("users.purge", entry.id)).toEqual([]);
    await staysOpen(o, asker.id, entry.id);
  });

  it("Delete now by hand closes it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await removeByHand(o, o.caseyName);
    const entry = await opened(o, asker.id, purgeStep(o.caseyName));
    const byHand = await asSession(
      o,
      o.morgan,
      "DELETE",
      `/api/removed-members/${o.caseyId}`,
    );
    expect(byHand.status).toBeLessThan(300);
    await closedAsDone(o, asker.id, entry.id);
  });

  it("the 30 days run out while the server is down: the next boot deletes the member and closes the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    await removeByHand(o, o.caseyName);
    const entry = await opened(o, asker.id, purgeStep(o.caseyName));
    const indexFile = join(STATE_ROOT, "removed-members.json");
    const index = JSON.parse(readFileSync(indexFile, "utf8")) as Record<
      string,
      { removedAt: number }
    >;
    index[o.caseyId].removedAt =
      Date.now() - REMOVED_MEMBER_RETENTION_MS - 60_000;
    writeFileSync(indexFile, JSON.stringify(index));
    const next = await o.srv.restart();
    server = next;
    o.srv = next;
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

// Two transcripts and an attachment of an agent that no longer exists,
// `days` old.
function seedOldLogs(days = 400, agentId = "agent-ghost") {
  const dir = join(STATE_ROOT, "logs", agentId);
  mkdirSync(join(dir, "files"), { recursive: true });
  const aged = (Date.now() - days * DAY_MS) / 1000;
  for (const name of ["old-a.jsonl", "old-b.jsonl"]) {
    const p = join(dir, name);
    writeFileSync(p, '{"id":"1"}\n');
    utimesSync(p, aged, aged);
  }
  const att = join(dir, "files", "old.png");
  writeFileSync(att, "x".repeat(64));
  utimesSync(att, aged, aged);
  return dir;
}

const pruneStep = (
  target: string,
  olderThanDays: number,
  keepPerAgent?: number,
) => ({
  kind: "storage-prune" as const,
  target,
  olderThanDays,
  ...(keepPerAgent === undefined ? {} : { keepPerAgent }),
});
const compressStep = (olderThanDays: number) => ({
  kind: "storage-compress" as const,
  olderThanDays,
});

const pruneByHand = async (o: Office, body: Record<string, unknown>) => {
  const res = await asSession(o, o.morgan, "POST", "/api/storage/prune", body);
  expect(res.status).toBe(200);
  return res;
};
const compressByHand = async (o: Office, body: Record<string, unknown>) => {
  const res = await asSession(
    o,
    o.morgan,
    "POST",
    "/api/storage/compress",
    body,
  );
  expect(res.status).toBe(200);
  return res;
};

describe("a storage-prune ask", () => {
  it("opens for an owner with old files, stored as asked; nothing is deleted at the create", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const dir = seedOldLogs();
    const entry = await opened(o, asker.id, pruneStep("transcripts", 30, 0));
    expect(entry.step).toEqual(pruneStep("transcripts", 30, 0) as AskStep);
    const attachments = await opened(o, asker.id, pruneStep("attachments", 30));
    expect(attachments.step).toEqual(pruneStep("attachments", 30) as AskStep);
    expect(existsSync(join(dir, "old-a.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "files", "old.png"))).toBe(true);
  });

  it("refuses what the route refuses (400), a member's ask (403), and a prune with nothing to delete (409 step_done)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    expect(
      outcome(await ask(o, asker.id, pruneStep("transcripts", 30, 0))),
    ).toEqual(refused(409, "step_done"));
    seedOldLogs();
    for (const step of [
      pruneStep("everything", 30, 0),
      pruneStep("transcripts", 0, 0),
      pruneStep("transcripts", 1.5, 0),
      pruneStep("transcripts", 30, -1),
      // A transcript prune states keepPerAgent, as its apply must.
      pruneStep("transcripts", 30),
      { ...pruneStep("attachments", 30), apply: true },
    ])
      expect((await ask(o, asker.id, step)).status).toBe(400);
    expect(
      outcome(await ask(o, caseys.id, pruneStep("transcripts", 30, 0))),
    ).toEqual(refused(403, "member_not_allowed"));
  });

  it("runs the prune as the owner: the files are gone, the answer carries what it deleted, the ask closes, one storage.prune row names the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const dir = seedOldLogs();
    const entry = await opened(o, asker.id, pruneStep("transcripts", 30, 0));
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(200);
    expect(
      (res.body as { applied: { deleted: number } | null }).applied?.deleted,
    ).toBe(2);
    expect(existsSync(join(dir, "old-a.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "old-b.jsonl"))).toBe(false);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    expect(auditRows("storage.prune", entry.id)).toEqual([
      ["member", o.morganId],
    ]);
  });

  it("closes on an apply by hand that covers the step, and stays open on a dry run, another target, an older line or more kept per agent", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    seedOldLogs();
    const entry = await opened(o, asker.id, pruneStep("transcripts", 30, 1));
    for (const body of [
      { target: "transcripts", olderThanDays: 30, keepPerAgent: 1 },
      { target: "attachments", olderThanDays: 30, apply: true },
      {
        target: "transcripts",
        olderThanDays: 60,
        keepPerAgent: 1,
        apply: true,
      },
      {
        target: "transcripts",
        olderThanDays: 30,
        keepPerAgent: 2,
        apply: true,
      },
    ]) {
      await pruneByHand(o, body);
      await staysOpen(o, asker.id, entry.id);
    }
    // A wider prune than asked covers it.
    await pruneByHand(o, {
      target: "transcripts",
      olderThanDays: 10,
      keepPerAgent: 0,
      apply: true,
    });
    await closedAsDone(o, asker.id, entry.id);
  });

  it("an apply from before the ask opened does not close it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    seedOldLogs();
    const tokenLogs = join(STATE_ROOT, "token-logs");
    mkdirSync(tokenLogs, { recursive: true });
    const oldLog = (name: string) => {
      const file = join(tokenLogs, name);
      writeFileSync(file, "retained log");
      const aged = new Date(Date.now() - 40 * DAY_MS);
      utimesSync(file, aged, aged);
      return file;
    };
    oldLog("0123456789abcdef.jsonl");
    // An apply that covers the step and deleted a file: it stamps.
    const before = await pruneByHand(o, {
      target: "token-logs",
      olderThanDays: 30,
      apply: true,
    });
    expect(before.body).toMatchObject({ applied: { deleted: 1 } });
    const file = oldLog("fedcba9876543210.jsonl");
    const entry = await opened(o, asker.id, pruneStep("token-logs", 30));
    // Another prune's apply runs the close check.
    const other = await pruneByHand(o, {
      target: "attachments",
      olderThanDays: 30,
      apply: true,
    });
    expect(other.body).toMatchObject({ applied: { deleted: 1 } });
    await staysOpen(o, asker.id, entry.id);
    expect(existsSync(file)).toBe(true);
  });

  it("a run whose apply is abandoned before it deletes anything leaves the ask open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const tokenLogs = join(STATE_ROOT, "token-logs");
    mkdirSync(tokenLogs, { recursive: true });
    const file = join(tokenLogs, "0123456789abcdef.jsonl");
    writeFileSync(file, "retained log");
    const aged = new Date(Date.now() - 40 * DAY_MS);
    utimesSync(file, aged, aged);
    const entry = await opened(o, asker.id, pruneStep("token-logs", 30));
    // The folder goes before the run: the apply cannot read it.
    rmSync(tokenLogs, { recursive: true });
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(200);
    expect(
      (res.body as { applied: { aborted?: string } | null }).applied?.aborted,
    ).toEqual(expect.any(String));
    await staysOpen(o, asker.id, entry.id);
  });

  it("a run while the message queue cannot be read deletes nothing, answers queue_state_unreadable, and leaves the ask open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const dir = seedOldLogs();
    const entry = await opened(o, asker.id, pruneStep("attachments", 30));
    writeFileSync(join(STATE_ROOT, "message-queues.json"), "{not json");
    expect(outcome(await run(o, o.morgan, entry.id))).toEqual(
      refused(409, "queue_state_unreadable"),
    );
    expect(existsSync(join(dir, "files", "old.png"))).toBe(true);
    await staysOpen(o, asker.id, entry.id);
  });
});

describe("a storage-compress ask", () => {
  it("opens for an owner with old transcripts, stored as asked; refuses a bad line (400), a member's ask (403) and nothing to compress (409 step_done)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const caseys = await spawn(o, "Helper", "Casey");
    expect(outcome(await ask(o, asker.id, compressStep(30)))).toEqual(
      refused(409, "step_done"),
    );
    const dir = seedOldLogs();
    const entry = await opened(o, asker.id, compressStep(30));
    expect(entry.step).toEqual(compressStep(30));
    expect(existsSync(join(dir, "old-a.jsonl.gz"))).toBe(false);
    for (const step of [
      compressStep(0),
      { kind: "storage-compress" },
      { ...compressStep(30), apply: true },
    ])
      expect((await ask(o, asker.id, step)).status).toBe(400);
    expect(outcome(await ask(o, caseys.id, compressStep(30)))).toEqual(
      refused(403, "member_not_allowed"),
    );
  });

  it("runs the compress as the owner: the transcripts are gzipped, the answer carries the count, the ask closes, one storage.compress row names the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const dir = seedOldLogs();
    const entry = await opened(o, asker.id, compressStep(30));
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(200);
    expect(
      (res.body as { applied: { compressed: number } | null }).applied
        ?.compressed,
    ).toBe(2);
    expect(existsSync(join(dir, "old-a.jsonl.gz"))).toBe(true);
    await closedAsDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toHaveLength(1);
    expect(auditRows("storage.compress", entry.id)).toEqual([
      ["member", o.morganId],
    ]);
  });

  it("closes on an apply by hand that covers the step; a dry run or an older line leaves it open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    seedOldLogs();
    const entry = await opened(o, asker.id, compressStep(30));
    await compressByHand(o, { olderThanDays: 30 });
    await staysOpen(o, asker.id, entry.id);
    await compressByHand(o, { olderThanDays: 60, apply: true });
    await staysOpen(o, asker.id, entry.id);
    await compressByHand(o, { olderThanDays: 20, apply: true });
    await closedAsDone(o, asker.id, entry.id);
  });
});
