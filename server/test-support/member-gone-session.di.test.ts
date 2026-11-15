// A member's agent whose stored conversation the engine cannot find
// (internal-docs/member-os-user-design.md, slice 1, "Agent space"; task
// b94dfd25 part 2b-i). The sync checks trust an isolated member's stored
// session, so the engine's own error at resume is the first word of it: the
// office drops the id, starts a new conversation and sends the waiting
// message to it once. An office agent, and an error that names another id,
// change nothing. The end-to-end proof with the real engine errors is the
// member rig case "recovers a member's agent whose stored conversation is
// gone or empty"; this file pins the manager's part.
//
// Seam: the DI manager with a FakeBackend, and the recording member host of
// member-host-fixture.ts, so hostFor(member) is a runner host. The engine's
// report is a failed turn_completed with sessionNotFound (Claude, OpenCode)
// or a send that throws StoredSessionNotFoundError before the engine takes
// the message (Codex's thread/resume).
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "os";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { StoredSessionNotFoundError } from "../internal-types.ts";
import type { PersistedAgent } from "../persistence.ts";
import { loadMessageQueuesRaw } from "../persistence.ts";
import { createMember, deleteUserById } from "../users.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";
import {
  officeAgentHost,
  setOfficeAgentHost,
  type AgentHost,
} from "../agent-host.ts";
import { hostFor } from "../member-hosts.ts";

type Manager = ReturnType<typeof createAgentManager>;

const ROOM = "room-gone-session";
// An existing folder: the wake checks it.
const CWD = tmpdir();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

let iso: IsolatedMember;
let alice: string;
let bob: string;
const created: string[] = [];

function member(name: string): string {
  const made = createMember(name, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  created.push(made.user.id);
  return made.user.id;
}

beforeEach(async () => {
  alice = member(`GoneAlice${created.length}`);
  bob = member(`GoneBob${created.length}`);
  iso = await isolateMember(alice);
});

afterEach(() => {
  iso.dispose();
  for (const id of created.splice(0)) deleteUserById(id);
});

// How the engine reports the stored id it cannot find.
type Report = "turn" | "send";

// The first session resumes `stored`; the engine reports `reported` as gone,
// the Claude way (a failed turn, then the process exits) or the Codex way (a
// send that throws before the engine takes the message). Every later session
// answers each send.
function backend(
  stored: string,
  reported: string,
  how: Report,
): { fake: FakeBackend; gone: () => FakeSession[] } {
  const fake: FakeBackend = new FakeBackend({
    storedSessionState: "durable",
    session: {
      onSend: (_t, _a, s) => {
        if (!(s.isResume && s.sessionId === stored)) {
          s.completeTurn({ text: "ok" });
          return;
        }
        if (how === "send")
          throw new StoredSessionNotFoundError(
            `no rollout found for thread id ${reported} (code -32600)`,
            reported,
            true,
          );
        s.push({
          kind: "turn_completed",
          status: "failed",
          error: `Agent stopped: error_during_execution. No conversation found with session ID: ${reported}`,
          sessionNotFound: reported,
        });
        s.endStream();
      },
    },
  });
  const gone = () =>
    fake.sessions.filter((s) => s.isResume && s.sessionId === stored);
  return { fake, gone };
}

async function restored(
  fake: FakeBackend,
  userId: string,
  sessionId: string,
): Promise<{ mgr: Manager; id: string }> {
  const persisted = {
    id: `gone-agent-${crypto.randomUUID()}`,
    name: "Gone",
    desk: 0,
    cwd: CWD,
    outfit: {
      hat: "none",
      color: "#000000",
      hair: "#000000",
      hairStyle: "short",
      skin: "#ffffff",
      beard: "none",
      accessory: null,
    },
    permissionMode: "default",
    modelFamily: "opencode/fake",
    effort: "high",
    agentType: "opencode",
    lastSessionId: sessionId,
    topic: null,
    customInstructions: null,
    userId,
    username: null,
  } as unknown as PersistedAgent;
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({
      rooms: [{ id: ROOM, name: ROOM, prompt: null }],
    }),
    initialRooms: [{ id: ROOM, name: ROOM, prompt: null, agents: [persisted] }],
  });
  mgr.configureAgentTurnDeps();
  await mgr.restoreAgents();
  expect(mgr.getCurrentSessionId(persisted.id)).toBe(sessionId);
  return { mgr, id: persisted.id };
}

const sendsOf = (sessions: FakeSession[], text: string) =>
  sessions.reduce(
    (n, s) => n + s.sent.filter((m) => m.text.includes(text)).length,
    0,
  );

const userMessages = (mgr: Manager, id: string, text: string) =>
  mgr
    .getAgentLogs(id)
    .filter(
      (e) =>
        e.kind === "user_message" &&
        typeof e.content === "string" &&
        e.content.includes(text),
    ).length;

// The chat lines that say why the conversation started again: the note for
// a gone conversation, or the line for messages sent again in its place.
function restartNotes(mgr: Manager, id: string): number {
  return mgr
    .getAgentLogs(id)
    .filter((entry) =>
      (entry.message ?? []).some(
        (part) =>
          typeof part !== "string" &&
          (part.key.startsWith("systemEntries.sessionNotResumable") ||
            part.key.startsWith("systemEntries.unsavedResent")),
      ),
    ).length;
}

function unsavedItems(id: string): number {
  const record = (loadMessageQueuesRaw()[id] ?? {}) as {
    unsaved?: { items: unknown[] };
  };
  return record.unsaved?.items.length ?? 0;
}

// A loop would make a session per pass: give one the time to start.
const SETTLE_MS = 300;

describe("a member's agent whose stored conversation the engine cannot find", () => {
  const cases: {
    name: string;
    how: Report;
    via: "queue" | "send";
  }[] = [
    { name: "the turn fails (Claude, OpenCode)", how: "turn", via: "queue" },
    { name: "the turn fails, on a direct send", how: "turn", via: "send" },
    {
      name: "the send throws (Codex), from the queue",
      how: "send",
      via: "queue",
    },
    {
      name: "the send throws (Codex), on a direct send",
      how: "send",
      via: "send",
    },
  ];
  for (const c of cases)
    // MUTANTS: memberSessionGone answers false (nothing is sent again);
    // recoverGoneMemberSession without the drop (a failed turn's message is
    // lost; after a refused send, no line says why the chat is new); the
    // turn end clears the unsaved record anyway, or resolves the turn in
    // place of the rejection (the message is lost); the direct send's
    // requeue not called (the message is lost); the requeue with echoed:true
    // (the cleared chat does not show it).
    it(`starts a new conversation that gets the message once: ${c.name}`, async () => {
      const stored = crypto.randomUUID();
      const { fake, gone } = backend(stored, stored, c.how);
      const { mgr, id } = await restored(fake, alice, stored);

      if (c.via === "queue")
        expect(
          mgr.enqueueMessage(id, {
            sender: { kind: "user", username: "tester" },
            text: "hello",
          }).ok,
        ).toBe(true);
      else void mgr.sendMessage(id, "hello", "tester").catch(() => {});

      await waitUntil(
        () => fake.sessions.some((s) => !s.isResume && s.sent.length > 0),
        "a new conversation got a send",
      );
      await waitUntil(
        () => mgr.getAgent(id)?.state === "waiting_for_response",
        "the new conversation's turn ended",
      );
      await sleep(SETTLE_MS);

      // The enabling condition: the gone session was resumed and got it.
      expect(gone().length).toBe(1);
      expect(sendsOf(gone(), "hello")).toBe(1);
      // One new conversation, which got it once; no loop.
      const fresh = fake.sessions.filter((s) => !s.isResume);
      expect(fake.sessions.length).toBe(2);
      expect(fresh.length).toBe(1);
      expect(sendsOf(fresh, "hello")).toBe(1);
      // The office dropped the gone id for the new conversation's.
      expect(mgr.getCurrentSessionId(id)).toBe(fresh[0].sessionId);
      expect(mgr.getAgent(id)?.state).toBe("waiting_for_response");
      expect(unsavedItems(id)).toBe(0);
      // The cleared chat shows the message once, and one line says why.
      expect(userMessages(mgr, id, "hello")).toBe(1);
      expect(restartNotes(mgr, id)).toBe(1);
    });

  // An office in split mode (Hosted) runs its own agents through a runner
  // host too: the office agent is told apart by its member, not by its
  // host's kind.
  // MUTANTS: memberSessionGone without the member check (the office
  // recovers through this path too); the check on the host's kind (red in
  // split mode only).
  for (const office of ["local", "split"] as const)
    it(`changes nothing for an office agent: the turn fails as before (${office} office)`, async () => {
      const before = officeAgentHost();
      if (office === "split")
        setOfficeAgentHost({ ...before, kind: "runner" } as AgentHost);
      try {
        expect(hostFor(bob).kind).toBe(office === "split" ? "runner" : "local");
        const stored = crypto.randomUUID();
        const { fake, gone } = backend(stored, stored, "turn");
        const { mgr, id } = await restored(fake, bob, stored);

        void mgr.sendMessage(id, "hello", "tester").catch(() => {});
        await waitUntil(() => gone().length === 1, "the gone session resumed");
        await waitUntil(
          () => mgr.getAgent(id)?.state === "error",
          "turn failed",
        );
        await sleep(SETTLE_MS);

        expect(sendsOf(gone(), "hello")).toBe(1);
        expect(
          sendsOf(
            fake.sessions.filter((s) => !s.isResume),
            "hello",
          ),
        ).toBe(0);
        expect(mgr.getAgent(id)?.state).toBe("error");
      } finally {
        setOfficeAgentHost(before);
      }
    });

  // MUTANT: memberSessionGone without the id check (a report about any id
  // drops the member's stored conversation).
  for (const how of ["turn", "send"] as const)
    it(`keeps the stored conversation when the engine names another id (${how})`, async () => {
      const stored = crypto.randomUUID();
      const { fake, gone } = backend(stored, crypto.randomUUID(), how);
      const { mgr, id } = await restored(fake, alice, stored);

      void mgr.sendMessage(id, "hello", "tester").catch(() => {});
      await waitUntil(() => gone().length === 1, "the gone session resumed");
      await waitUntil(
        () => sendsOf(gone(), "hello") === 1,
        "the gone session got the send",
      );
      await sleep(SETTLE_MS);

      expect(
        sendsOf(
          fake.sessions.filter((s) => !s.isResume),
          "hello",
        ),
      ).toBe(0);
      expect(mgr.getCurrentSessionId(id)).toBe(stored);
    });
});
