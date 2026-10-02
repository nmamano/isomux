// Member usage cap on edit-to-fork (task 6de8f530): a refused edit rolls the
// fork back, keeps the edited text recoverable, and sends nothing.
//
// Seam: the DI manager (createAgentManager + FakeBackend), the
// edit-attachments.test.ts fixture. No member records exist here, so the
// unattributed edit is a direct input the cap covers (fail closed).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { loadLog } from "../persistence.ts";
import { createAgentManager } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  createMemberUsageCap,
  setMemberUsageCapForTests,
} from "../member-usage-cap.ts";
import { WEEK_MS } from "../office-usage.ts";
import { FAILED_EDIT_TEXT_KEY } from "../../shared/failed-edit.ts";
import type { EventHandler } from "../internal-types.ts";
import type { RoomWire } from "../../shared/types.ts";

const ROOM: RoomWire = {
  id: "room-a",
  name: "room-a",
  prompt: null,
  canCloseWhenEmpty: false,
};
const PARENT_SID = "fake-session-1";
const FORK_SID = "forked-1";
const claudeHome = () => join(STATE_ROOT, "claude-home");

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

const activeFakes: FakeBackend[] = [];
afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
  clearTestManagedOfficeEnv();
  setMemberUsageCapForTests(null);
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

describe("member usage cap: edit-to-fork", () => {
  it("rolls a refused edit back to the parent and keeps the edited text", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "reply" }) },
      forkResult: {
        kind: "fork",
        sessionId: FORK_SID,
        forkedFromSessionId: PARENT_SID,
      },
      sessionMessages: [
        { uuid: "u-1", role: "user", text: "first draft" },
        { uuid: "a-1", role: "assistant", text: "reply" },
      ],
    });
    activeFakes.push(fake);
    const events: Parameters<EventHandler>[0][] = [];
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: [ROOM] }),
      initialRooms: [],
      eventSink: (e) => events.push(e),
    });
    mgr.configureAgentTurnDeps();
    const info = (await mgr.spawn(
      "A",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    ))!;
    await mgr.sendMessage(info.id, "first draft");
    await waitUntil(
      () => mgr.getAgent(info.id)?.state === "waiting_for_response",
      3000,
      "first turn settled",
    );
    const forkDir = claudeProjectDir(info.cwd, {
      CLAUDE_CONFIG_DIR: claudeHome(),
    });
    mkdirSync(forkDir, { recursive: true });
    writeFileSync(join(forkDir, `${FORK_SID}.jsonl`), "");

    setMemberUsageCapForTests(
      createMemberUsageCap({
        reader: {
          async read() {
            return {
              kind: "weekly",
              usedPercent: 90,
              resetsAtMs: Date.now() + WEEK_MS / 2,
              observedAtMs: Date.now(),
            };
          },
          invalidate() {},
          close() {},
        },
        officeDir: () => claudeHome(),
        load: () => true,
      }),
    );
    const sendsBefore = fake.sessions.flatMap((s) => s.sent).length;
    const target = loadLog(info.id, PARENT_SID).find(
      (e) => e.kind === "user_message",
    )!;
    await mgr.editMessage(info.id, target.id, "second draft");

    expect(fake.sessions.flatMap((s) => s.sent)).toHaveLength(sendsBefore);
    expect(mgr.getAgent(info.id)?.state).toBe("waiting_for_response");
    const refusal = mgr
      .getAgentLogs(info.id)
      .filter((e) => e.kind === "error")
      .at(-1);
    expect(refusal?.metadata?.[FAILED_EDIT_TEXT_KEY]).toBe("second draft");
    // The parent conversation is back: its first message is still there.
    expect(
      mgr
        .getAgentLogs(info.id)
        .some((e) => e.kind === "user_message" && e.content === "first draft"),
    ).toBe(true);
  });
});
