// Conversation summaries (task ac41c60e): the agent manager's triggers. The
// write loop itself is covered in server/session-summary.test.ts; this file
// pins what only the wiring decides - when a write starts, for which session,
// and from which file. Every one-shot answers with a paragraph, so the topic
// call is harmless here and the stored summary is the observable.
import { describe, expect, it } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import type { LogEntry, RoomWire } from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import { STATE_ROOT } from "../config.ts";
import { TIERS } from "../log-search.ts";
import { loadLog, loadSessionsMap } from "../persistence.ts";
import { SUMMARY_ROLLING_EVERY } from "../session-summary.ts";
import { FakeBackend } from "./fake-backend.ts";

function room(id: string): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: false };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check() && performance.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

const isConversation = (e: LogEntry) =>
  (TIERS.conversation ?? []).includes(e.kind);

async function harness() {
  let replies = 0;
  const fake = new FakeBackend({
    models: [
      { id: "slow", label: "Slow", supportedEfforts: [], isDefault: true },
    ],
    oneShot: () => `Paragraph ${++replies}`,
    session: {
      onSend: (_text, _attachments, session) =>
        session.completeTurn({ text: "ok" }),
    },
  });
  const roomId = `summary-${crypto.randomUUID()}`;
  const officeState = new OfficeState({ rooms: [room(roomId)] });
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState,
    initialRooms: [],
    findUser: () => ({ id: "user-a", role: "member" }),
    eventSink: () => {},
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    `Summary ${roomId}`,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    "slow",
    "high",
    "tester",
    // OpenCode: no sign-in state to read on this box.
    "opencode",
    undefined,
    "user-a",
  );
  const agentId = info!.id;
  const sessionId = () => mgr.getCurrentSessionId(agentId);
  // The conversation entries in the session's own file.
  const conversation = (sid: string) =>
    loadLog(agentId, sid).filter(isConversation);
  const stored = (sid: string) => loadSessionsMap(agentId)[sid];
  // Sends one message and waits until its reply is in the session's file.
  const send = async (text: string) => {
    const before = sessionId() ? conversation(sessionId()!).length : 0;
    await mgr.sendMessage(agentId, text, "tester");
    await waitFor(() => {
      const sid = sessionId();
      return !!sid && conversation(sid).length >= before + 2;
    });
  };
  return { mgr, agentId, sessionId, conversation, stored, send };
}

// A fire-and-forget write that should NOT start gets this long to show up.
const settle = () => Bun.sleep(150);

describe("conversation summary triggers", () => {
  it("writes the current session's paragraph once it has the rolling count of new entries", async () => {
    const h = await harness();
    // Each message is a user entry and a reply.
    const below = SUMMARY_ROLLING_EVERY / 2 - 2;
    for (let i = 0; i < below; i++) await h.send(`message ${i}`);
    const sid = h.sessionId()!;
    await settle();
    expect(h.conversation(sid).length).toBeLessThan(SUMMARY_ROLLING_EVERY);
    expect(h.stored(sid)?.summary).toBeUndefined();

    for (let i = below; i < SUMMARY_ROLLING_EVERY / 2 + 4; i++)
      await h.send(`message ${i}`);
    expect(h.sessionId()).toBe(sid);
    await waitFor(() => h.stored(sid)?.summary !== undefined);
    const ids = h.conversation(sid).map((e) => e.id);
    const through = ids.indexOf(h.stored(sid).summaryThroughEntryId!);
    // The write read the session's file: its marker is one of the file's
    // conversation entries, at or past the rolling count.
    expect(through).toBeGreaterThanOrEqual(SUMMARY_ROLLING_EVERY - 2);
    expect(h.stored(sid).summary).toMatch(/^Paragraph \d+$/);
  });

  it("writes the paragraph of a session that a new conversation ends", async () => {
    const h = await harness();
    await h.send("first");
    await h.send("second");
    const ended = h.sessionId()!;
    expect(h.conversation(ended)).toHaveLength(4);
    await settle();
    expect(h.stored(ended)?.summary).toBeUndefined();

    await h.mgr.newConversation(h.agentId);
    await waitFor(() => h.stored(ended)?.summary !== undefined);
    expect(h.stored(ended).summaryThroughEntryId).toBe(
      h.conversation(ended).at(-1)!.id,
    );
  });

  it("counts the rolling entries per session: a new conversation starts again at zero", async () => {
    const h = await harness();
    // Most of the rolling count in the first session.
    const first = SUMMARY_ROLLING_EVERY / 2 - 5;
    for (let i = 0; i < first; i++) await h.send(`a ${i}`);
    const a = h.sessionId()!;
    await h.mgr.newConversation(h.agentId);
    await waitFor(() => h.stored(a)?.summary !== undefined);

    // Together with the first session this passes the rolling count; alone it
    // does not.
    for (let i = 0; i < 8; i++) await h.send(`b ${i}`);
    const b = h.sessionId()!;
    expect(b).not.toBe(a);
    expect(h.conversation(b).length).toBeLessThan(SUMMARY_ROLLING_EVERY);
    expect(h.conversation(a).length + h.conversation(b).length).toBeGreaterThan(
      SUMMARY_ROLLING_EVERY + 2,
    );
    await settle();
    expect(h.stored(b)?.summary).toBeUndefined();
  });
});
