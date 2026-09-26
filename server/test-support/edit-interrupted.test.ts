// Regression for task eb9002b4 - edit after Stop, and edited text kept on
// every failed edit.
//
// Repro (Nil, 2026-09-25, Codex): send a message, press Stop at once, then
// edit that message. The edit failed with "Cannot edit: could not locate
// message in backend session." and the edited text was lost.
//
// Cause: the stopped message never reached the backend history. Codex writes
// the user message only after turn setup, and a Stop inside that window drops
// it; Claude and OpenCode never get it when Stop lands in isomux's pre-send
// window. The fake models exactly that end state: the log holds the second
// message, the backend transcript ends at the first turn.
//
// Seam: the DI manager (createAgentManager + FakeBackend + event sink), same
// idiom as edit-attachments.test.ts. Zero LLM calls.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import {
  loadLog,
  loadLogWithAncestors,
  loadSessionsMap,
} from "../persistence.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { FakeBackend, type FakeBackendConfig } from "./fake-backend.ts";
import { BackendNotConfiguredError } from "../internal-types.ts";
import type { EventHandler } from "../internal-types.ts";
import type { LogEntry, RoomWire } from "../../shared/types.ts";
import { failedEditText } from "../../shared/failed-edit.ts";

const PARENT_SID = "fake-session-1";
const FORK_SID = "forked-1";

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

const activeFakes: FakeBackend[] = [];

afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
  clearTestManagedOfficeEnv();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

function claudeHome(): string {
  return join(STATE_ROOT, "claude-home");
}

function seedClaudeSession(cwd: string, sessionId: string): void {
  const dir = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: claudeHome() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "");
}

// First turn completes; the second is stopped before the backend recorded it,
// so the transcript holds only the first exchange. `failAfterFork` makes every
// turn on the forked session fail with a backend error.
function interruptedFake(
  backendUsers: string[] = ["first"],
  extra: Partial<FakeBackendConfig> = {},
) {
  // failAfterFork: how the forked session's turn fails, via an error event
  // or via a failed turn_completed.
  const state: { failAfterFork: false | "error-event" | "failed-turn" } = {
    failAfterFork: false,
  };
  const cfg: FakeBackendConfig = {
    session: {
      onSend: (text, _a, s) => {
        if (state.failAfterFork && s.sessionId === FORK_SID) {
          if (state.failAfterFork === "error-event")
            s.push({ kind: "error", message: "provider exploded" });
          else s.completeTurn({ status: "failed", error: "provider exploded" });
          return;
        }
        // Left running until Stop (or to keep the agent busy).
        if (text.endsWith("second") || text.endsWith("left running")) return;
        s.completeTurn({ text: "reply" });
      },
    },
    forkResult: {
      kind: "fork",
      sessionId: FORK_SID,
      forkedFromSessionId: PARENT_SID,
    },
    sessionMessages: backendUsers.flatMap((text, i) => [
      { uuid: `u-${i}`, role: "user" as const, text },
      { uuid: `a-${i}`, role: "assistant" as const, text: "reply" },
    ]),
    ...extra,
  };
  return { fake: new FakeBackend(cfg), state };
}

async function setup(fake: FakeBackend) {
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
  const events: LogEntry[] = [];
  const sink: EventHandler = (e) => {
    if (e.type === "log_entry") events.push(e.entry);
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms("room-a") }),
    initialRooms: [],
    eventSink: sink,
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(fake);
  const info = (await mgr.spawn(
    "A",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
  ))!;
  const idle = () => mgr.getAgent(info.id)?.state === "waiting_for_response";
  await mgr.sendMessage(info.id, "first");
  await waitUntil(
    () => idle() && loadLog(info.id, PARENT_SID).some((e) => e.kind === "text"),
    3000,
    "first turn settled",
  );
  void mgr.sendMessage(info.id, "second");
  await waitUntil(() => !idle(), 2000, "second turn running");
  // Stop: the fake's transcript never records "second".
  expect((await mgr.abort(info.id)).ok).toBe(true);
  await waitUntil(idle, 2000, "second turn stopped");
  seedClaudeSession(info.cwd, FORK_SID);
  const secondId = loadLog(info.id, PARENT_SID).find(
    (e) => e.kind === "user_message" && e.content === "second",
  )!.id;
  events.length = 0;
  return { mgr, info, events, secondId, idle };
}

function errorsOf(events: LogEntry[]): LogEntry[] {
  return events.filter((e) => e.kind === "error");
}

describe("edit after Stop (task eb9002b4)", () => {
  it("edits a stopped message the backend never recorded, keeping the whole history", async () => {
    const { fake } = interruptedFake();
    const { mgr, info, events, secondId } = await setup(fake);

    await mgr.editMessage(info.id, secondId, "second, fixed");
    await waitUntil(
      () => !!loadSessionsMap(info.id)[FORK_SID],
      2000,
      "fork persisted",
    );

    expect(errorsOf(events)).toEqual([]);
    // null: the branch keeps the whole backend history (nothing to cut).
    expect(fake.forkCount).toBe(1);
    expect(fake.lastForkTarget).toBeNull();
    expect(loadSessionsMap(info.id)[FORK_SID]).toMatchObject({
      forkedFrom: PARENT_SID,
      forkMessageId: secondId,
    });
    expect(fake.sessions.at(-1)!.sent.at(-1)?.text).toBe("second, fixed");
    // The branch's timeline replaces the stopped message with the edit.
    await waitUntil(
      () =>
        loadLogWithAncestors(info.id, FORK_SID).some(
          (e) => e.kind === "user_message" && e.content === "second, fixed",
        ),
      2000,
      "edited message persisted",
    );
    expect(
      loadLogWithAncestors(info.id, FORK_SID)
        .filter((e) => e.kind === "user_message")
        .map((e) => e.content),
    ).toEqual(["first", "second, fixed"]);
  });

  it("still refuses when user text follows the predecessor in the backend", async () => {
    // The stopped message may be recorded under text the matching does not
    // recognize; branching would keep the old message in the model's context.
    const { fake } = interruptedFake(["first", "second (wrapped)"]);
    const { mgr, info, events, secondId } = await setup(fake);

    await mgr.editMessage(info.id, secondId, "second, fixed");
    await waitUntil(() => errorsOf(events).length > 0, 2000, "error surfaced");

    expect(fake.forkCount).toBe(0);
    expect(failedEditText(errorsOf(events)[0].metadata)).toBe("second, fixed");
  });

  it("refuses to treat an older message as never sent", async () => {
    const { fake } = interruptedFake();
    const { mgr, info, events } = await setup(fake);
    const firstId = loadLog(info.id, PARENT_SID).find(
      (e) => e.kind === "user_message" && e.content === "first",
    )!.id;
    // The backend has "first", so this is a normal edit: fork before it.
    await mgr.editMessage(info.id, firstId, "first, fixed");
    await waitUntil(
      () => !!loadSessionsMap(info.id)[FORK_SID],
      2000,
      "fork persisted",
    );
    expect(errorsOf(events)).toEqual([]);
    expect(fake.lastForkTarget).toBe("u-0");
  });
});

describe("failed edits keep the edited text (task eb9002b4)", () => {
  it("an unknown message id", async () => {
    const { fake } = interruptedFake();
    const { mgr, info, events } = await setup(fake);
    await mgr.editMessage(info.id, "log-nope", "kept text");
    const [error] = errorsOf(events);
    expect(failedEditText(error.metadata)).toBe("kept text");
    // Persisted with the error, so it survives a reload and another client.
    expect(
      loadLog(info.id, PARENT_SID).find((e) => e.id === error.id)?.metadata,
    ).toEqual(error.metadata);
  });

  it("an edit while the agent is busy", async () => {
    const { fake } = interruptedFake();
    const { mgr, info, events, secondId, idle } = await setup(fake);
    void mgr.sendMessage(info.id, "third, left running");
    await waitUntil(() => !idle(), 2000, "agent busy");
    await mgr.editMessage(info.id, secondId, "kept while busy");
    expect(failedEditText(errorsOf(events)[0].metadata)).toBe(
      "kept while busy",
    );
  });

  it("a failed fork", async () => {
    const { fake } = interruptedFake(["first"], {
      forkError: new Error("fork refused"),
    });
    const { mgr, info, events, secondId } = await setup(fake);
    await mgr.editMessage(info.id, secondId, "kept after fork failure");
    await waitUntil(() => errorsOf(events).length > 0, 2000, "error surfaced");
    const [error] = errorsOf(events);
    expect(error.content).toContain("fork refused");
    expect(failedEditText(error.metadata)).toBe("kept after fork failure");
  });

  it("a backend that is not configured", async () => {
    const { fake } = interruptedFake(["first"], {
      forkError: new BackendNotConfiguredError("backend missing"),
    });
    const { mgr, info, events, secondId } = await setup(fake);
    await mgr.editMessage(info.id, secondId, "kept when unconfigured");
    await waitUntil(() => errorsOf(events).length > 0, 2000, "error surfaced");
    expect(failedEditText(errorsOf(events)[0].metadata)).toBe(
      "kept when unconfigured",
    );
  });

  for (const how of ["error-event", "failed-turn"] as const) {
    it(`a turn that fails after the branch (${how})`, async () => {
      const { fake, state } = interruptedFake();
      const { mgr, info, events, secondId } = await setup(fake);
      state.failAfterFork = how;

      await mgr.editMessage(info.id, secondId, "kept after failure");
      await waitUntil(
        () =>
          errorsOf(events).some(
            (e) => failedEditText(e.metadata) === "kept after failure",
          ),
        3000,
        "error with text",
      );
      // Every error entry of the edited turn keeps the text.
      for (const e of errorsOf(events))
        expect(failedEditText(e.metadata)).toBe("kept after failure");
      const marked = (sid: string) =>
        loadLog(info.id, sid).some(
          (e) =>
            e.kind === "error" &&
            failedEditText(e.metadata) === "kept after failure",
        );
      if (how === "error-event") {
        // A backend error rejects the turn and rolls the branch back: the
        // branch's user_message is gone, the text lives in the error entry
        // on disk in the parent session.
        expect(mgr.getAgentLogs(info.id).map((e) => e.content)).not.toContain(
          "kept after failure",
        );
        expect(marked(PARENT_SID)).toBe(true);
      } else {
        // A failed turn keeps the branch; its error entry still carries the
        // text and the restore action.
        expect(mgr.getAgentLogs(info.id).map((e) => e.content)).toContain(
          "kept after failure",
        );
        expect(marked(FORK_SID)).toBe(true);
        // The mark ends with the edited turn: the next ordinary turn on the
        // branch fails the same way, and its error is not an edit failure.
        const before = errorsOf(events).length;
        void mgr.sendMessage(info.id, "an ordinary message");
        await waitUntil(
          () => errorsOf(events).length > before,
          3000,
          "ordinary turn failed",
        );
        expect(failedEditText(errorsOf(events).at(-1)!.metadata)).toBeNull();
      }
    });
  }
});
