// Task 62a7fe97. A background agent's final report reaches the transcript
// only on its settle breadcrumb (task_lifecycle `report`), never as the
// agent's own text. The agent chat must keep it in metadata.taskEvent so the
// UI can expand it; a breadcrumb without a report carries no report key.
import { describe, it, expect } from "bun:test";

import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { FakeBackend } from "./fake-backend.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label = "cond"): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

function room(): RoomWire[] {
  return [
    { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
  ];
}

const REPORT = "**1. Verdict:** fine.\n\n- one\n- two";
const MARKER = "events handled";

describe("task_lifecycle report in the agent chat", () => {
  it("keeps an agent's report on the breadcrumb, and none on a command's", async () => {
    const fake = new FakeBackend();
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: room() }),
      initialRooms: [],
    });
    mgr.configureAgentTurnDeps();
    const info = await mgr.spawn(
      "Worker",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
      undefined,
      undefined,
      undefined,
      "Owner",
      "claude",
      undefined,
      "user-a",
    );
    if (!info) throw new Error("spawn returned null");
    mgr.enqueueMessage(info.id, {
      sender: { kind: "user", username: "Morgan" },
      text: "hi",
    });
    await waitUntil(
      () => fake.sessionForAgent(info.id) !== undefined,
      "session created",
    );
    const session = fake.sessionForAgent(info.id)!;
    session.pushAll([
      {
        kind: "task_lifecycle",
        phase: "completed",
        taskId: "a1",
        label: "agent settled",
        report: REPORT,
      },
      {
        kind: "task_lifecycle",
        phase: "failed",
        taskId: "b1",
        label: "command settled",
      },
      // A trailing marker: once it lands, the events before it are handled.
      { kind: "system_text", text: MARKER },
    ]);
    await waitUntil(
      () => mgr.getAgentLogs(info.id).some((e) => e.content === MARKER),
      MARKER,
    );
    const logs = mgr.getAgentLogs(info.id);
    const agent = logs.find((e) => e.content === "agent settled");
    const command = logs.find((e) => e.content === "command settled");
    expect(agent?.kind).toBe("system");
    expect(agent?.metadata?.taskEvent).toEqual({
      taskId: "a1",
      phase: "completed",
      report: REPORT,
    });
    expect(command?.metadata?.taskEvent).toEqual({
      taskId: "b1",
      phase: "failed",
    });
    // The report is not also logged as an entry of its own.
    expect(logs.filter((e) => e.content.includes("Verdict"))).toHaveLength(0);
    session.close();
  });
});
