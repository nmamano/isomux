// Files sent with a slash command (task 43b0bc69). Seam: createAgentManager +
// FakeBackend; the fake records the attachments each backend send got.
//
// What this freezes:
//   - A skill takes the files to the engine with its expanded prompt, and
//     the chat echo of the command shows them, on an idle agent and on a
//     busy one (queued, then flushed).
//   - /plan takes them too: `/plan <text>` and a bare `/plan` with files
//     send them, and a bare `/plan` with files turns plan mode on, never off.
//   - Any other command, Isomux's or the engine's, refuses files: it does
//     not run, and the chat says why.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import type { Attachment, LogEntry, RoomWire } from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import { STATE_ROOT } from "../config.ts";

const { t } = translatorFor("en");

const ROOM: RoomWire = {
  id: "room-slash-att",
  name: "room-slash-att",
  prompt: null,
  canCloseWhenEmpty: true,
};
const USER = "Morgan";
const SKILL = "att-skill";
const MARKER = "attachment skill body marker";
const IMAGE: Attachment = {
  filename: "f00dfeed.png",
  originalName: "screenshot.png",
  mediaType: "image/png",
  size: 4,
};

const fakes: FakeBackend[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0))
    for (const session of fake.sessions) session.close();
});

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Completes every turn, except one whose text holds HOLD: that one runs
// until the test completes it.
function backend(
  opts: { planMode?: boolean; slashCommands?: string[] } = {},
): FakeBackend {
  return new FakeBackend({
    planMode: opts.planMode,
    session: {
      slashCommands: opts.slashCommands,
      onSend: (text, _a, s) => {
        if (!text.includes("HOLD")) s.completeTurn({ text: "ok" });
      },
    },
  });
}

type Mgr = ReturnType<typeof createAgentManager>;

async function setup(fake: FakeBackend) {
  fakes.push(fake);
  const skillDir = join(STATE_ROOT, "skills", SKILL);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), MARKER);
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: [ROOM] }),
    initialRooms: [],
    eventSink: () => {},
  });
  mgr.configureAgentTurnDeps();
  const agent = await mgr.spawn(
    "A",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    ROOM.id,
    undefined,
    undefined,
    undefined,
    USER,
    "claude",
  );
  if (!agent) throw new Error("spawn returned null");
  return { mgr, agent };
}

// A first message gives the agent a live session.
async function liveSession(
  mgr: Mgr,
  fake: FakeBackend,
  agentId: string,
): Promise<FakeSession> {
  await mgr.sendMessage(agentId, "hello", USER);
  const session = fake.sessionForAgent(agentId);
  if (!session) throw new Error("no session");
  await waitUntil(() => mgr.getAgent(agentId)?.state !== "thinking", "idle");
  return session;
}

const sendWith = (mgr: Mgr, agentId: string, text: string) =>
  mgr.sendMessage(agentId, text, USER, undefined, [IMAGE]);

const fileNames = (atts: Attachment[] | undefined) =>
  (atts ?? []).map((a) => a.filename);

function echoes(mgr: Mgr, agentId: string, content: string): LogEntry[] {
  return mgr
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "user_message" && e.content === content);
}

const systemLines = (mgr: Mgr, agentId: string) =>
  mgr
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => e.content);

describe("a slash command sent with files", () => {
  it("a skill on an idle agent sends them with its prompt and shows them on its echo", async () => {
    const fake = backend();
    const { mgr, agent } = await setup(fake);
    const session = await liveSession(mgr, fake, agent.id);

    await sendWith(mgr, agent.id, `/${SKILL} look at this`);
    await waitUntil(() => session.sent.length === 2, "the skill turn");

    const sent = session.sent[1];
    // The enabling condition: this send is the expanded skill.
    expect(sent.text).toContain(MARKER);
    expect(fileNames(sent.attachments)).toEqual([IMAGE.filename]);
    const echo = echoes(mgr, agent.id, `/${SKILL} look at this`);
    expect(echo).toHaveLength(1);
    expect(fileNames(echo[0].attachments)).toEqual([IMAGE.filename]);
  });

  it("a skill on a busy agent queues them and the flush sends them", async () => {
    const fake = backend();
    const { mgr, agent } = await setup(fake);
    // sendMessage resolves when its turn ends; this one runs until the
    // test completes it.
    const held = mgr.sendMessage(agent.id, "HOLD", USER);
    await waitUntil(
      () => (fake.sessionForAgent(agent.id)?.sent.length ?? 0) === 1,
      "the held turn",
    );
    const session = fake.sessionForAgent(agent.id)!;

    await sendWith(mgr, agent.id, `/${SKILL}`);
    const queue = mgr.getAllAgents().find((a) => a.id === agent.id)?.queue;
    // The enabling condition: the skill waits in the queue, not in a send.
    expect(session.sent).toHaveLength(1);
    expect(queue?.map((m) => m.text)).toEqual([`/${SKILL}`]);
    expect(fileNames(queue?.[0].attachments)).toEqual([IMAGE.filename]);

    session.completeTurn({ text: "done" });
    await held;
    await waitUntil(() => session.sent.length === 2, "the flush");
    expect(session.sent[1].text).toContain(MARKER);
    expect(fileNames(session.sent[1].attachments)).toEqual([IMAGE.filename]);
  });

  it("/plan <text> sends them with the text", async () => {
    const fake = backend({ planMode: true });
    const { mgr, agent } = await setup(fake);
    const session = await liveSession(mgr, fake, agent.id);

    await sendWith(mgr, agent.id, "/plan fix the spacing");
    await waitUntil(() => session.sent.length === 2, "the plan turn");

    expect(session.planModeCalls).toEqual([true]);
    expect(session.sent[1].text).toEndWith("fix the spacing");
    expect(fileNames(session.sent[1].attachments)).toEqual([IMAGE.filename]);
  });

  it("a bare /plan sends them and turns plan mode on, never off", async () => {
    const fake = backend({ planMode: true });
    const { mgr, agent } = await setup(fake);
    const session = await liveSession(mgr, fake, agent.id);

    await sendWith(mgr, agent.id, "/plan");
    await waitUntil(() => session.sent.length === 2, "the first plan turn");
    expect(session.planModeCalls).toEqual([true]);
    expect(fileNames(session.sent[1].attachments)).toEqual([IMAGE.filename]);

    // Plan mode is on now: a bare /plan without files would turn it off.
    await sendWith(mgr, agent.id, "/plan");
    await waitUntil(() => session.sent.length === 3, "the second plan turn");
    expect(session.planModeCalls).toEqual([true]);
    expect(fileNames(session.sent[2].attachments)).toEqual([IMAGE.filename]);
    expect(echoes(mgr, agent.id, "/plan")).toHaveLength(2);
  });

  it("any other command refuses them and does not run", async () => {
    const fake = backend();
    const { mgr, agent } = await setup(fake);
    const session = await liveSession(mgr, fake, agent.id);

    await sendWith(mgr, agent.id, "/clear");
    expect(systemLines(mgr, agent.id)).toContain(
      t("commands.native.attachments", { name: "clear" }),
    );
    expect(echoes(mgr, agent.id, "/clear")).toHaveLength(1);
    await mgr.sendMessage(agent.id, "still here", USER);
    await waitUntil(() => session.sent.length === 2, "the next message");
    expect(fake.sessions).toHaveLength(1);

    // The enabling condition: the same /clear without files does start a
    // new conversation.
    await mgr.sendMessage(agent.id, "/clear", USER);
    await mgr.sendMessage(agent.id, "after clear", USER);
    await waitUntil(() => fake.sessions.length === 2, "a new session");
  });

  // The engine expands a command it reports only at the start of a message,
  // and a file notice after it stops the expansion.
  it("a command the engine reports refuses them and sends nothing", async () => {
    const fake = backend({ slashCommands: ["verify"] });
    const { mgr, agent } = await setup(fake);
    // The first message starts the session that reports the command.
    const session = await liveSession(mgr, fake, agent.id);

    await sendWith(mgr, agent.id, "/verify now");
    expect(systemLines(mgr, agent.id)).toContain(
      t("commands.native.attachments", { name: "verify" }),
    );
    // The enabling condition: without files the command goes as typed.
    await mgr.sendMessage(agent.id, "/verify now", USER);
    await waitUntil(() => session.sent.length === 2, "the command");
    expect(session.sent[1].text).toBe("/verify now");
  });
});
