// The hold of a member during the file move (agent-manager holdMember and
// releaseMember; internal-docs/member-os-user-design.md 2.2; slice 1c-ii-a of
// task b94dfd25). The properties: the hold cuts the member's running turn and
// resolves only after its process has ended; while held, a message to the
// member's agent queues and starts no session; another member's agent runs;
// the release flushes the queue.
import { afterEach, describe, expect, it } from "bun:test";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { createMember, deleteUserById } from "../users.ts";

const created: string[] = [];
afterEach(() => {
  for (const id of created.splice(0)) deleteUserById(id);
});

function member(name: string): string {
  const made = createMember(name, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  created.push(made.user.id);
  return made.user.id;
}

async function waitFor(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(5);
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
}

const sentTo = (fake: FakeBackend, agentId: string, text: string) =>
  fake.sessions.some(
    (s) =>
      (s.opts as { agentId?: string }).agentId === agentId &&
      s.sent.some((m) => m.text.includes(text)),
  );

describe("a held member", () => {
  it("is cut, starts nothing while held, and runs the queued message after the release; another member runs", async () => {
    const alice = member(`HoldAlice${created.length}`);
    const bob = member(`HoldBob${created.length}`);
    // The sessions keep their turn running; close() parks the stream until
    // endStream(), as a process that takes time to exit.
    const fake = new FakeBackend({ session: { hangOnClose: true } });
    const roomId = `room-hold-${crypto.randomUUID()}`;
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({
        rooms: [{ id: roomId, name: roomId, prompt: null }],
      }),
      initialRooms: [],
    });
    mgr.configureAgentTurnDeps();
    const spawnFor = (name: string, userId: string) =>
      mgr.spawn(
        name,
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        roomId,
        undefined,
        "sonnet",
        "high",
        name,
        "claude",
        undefined,
        userId,
      );
    const a = (await spawnFor("HeldAgent", alice))!;
    const b = (await spawnFor("OtherAgent", bob))!;
    const send = (agentId: string, text: string) =>
      mgr.enqueueMessage(agentId, {
        sender: { kind: "user", username: "tester" },
        text,
      });

    send(a.id, "first");
    await waitFor(() => sentTo(fake, a.id, "first"), "the first turn");
    const running = fake.sessions.find(
      (s) => (s.opts as { agentId?: string }).agentId === a.id,
    ) as FakeSession;

    let held = false;
    const hold = mgr.holdMember(alice).then(() => (held = true));
    await waitFor(() => running.closed, "the cut");
    // The process has not ended yet: the hold waits for it.
    await Bun.sleep(50);
    expect(held).toBe(false);
    // End each closed process (the cut may resume and close one more).
    for (let i = 0; i < 400 && !held; i++) {
      for (const s of fake.sessions) if (s.closed) s.endStream();
      await Bun.sleep(5);
    }
    await hold;
    const ofA = () =>
      fake.sessions.filter(
        (s) => (s.opts as { agentId?: string }).agentId === a.id,
      );
    expect(ofA().every((s) => s.closed)).toBe(true);
    const sessionsOfA = ofA().length;

    const starts = fake.createSessionCount + fake.resumeSessionCount;
    send(a.id, "while held");
    send(b.id, "bob runs");
    await waitFor(
      () => sentTo(fake, b.id, "bob runs"),
      "the other member's turn",
    );
    await Bun.sleep(50);
    expect(sentTo(fake, a.id, "while held")).toBe(false);
    expect(ofA().length).toBe(sessionsOfA);
    expect(fake.createSessionCount + fake.resumeSessionCount).toBe(starts + 1);

    mgr.releaseMember(alice);
    await waitFor(
      () => sentTo(fake, a.id, "while held"),
      "the queued message after the release",
    );
    for (const s of fake.sessions) {
      s.close();
      s.endStream();
    }
  });
});
