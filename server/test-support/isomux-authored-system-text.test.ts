// The orchestrator sniffs every `system_text` for provider auth trouble with
// a regex that matches 401/403/"authentication"/"not logged in". That is right
// for relayed provider output (Codex's stderr arrives this way) and wrong for
// breadcrumbs Isomux writes itself, which quote commands and prefix rules the
// user typed: `4 grep 401` must not produce a sign-in card.
//
// This pins BOTH directions at the layer that decides - a backend-level test
// can only assert the flag is set, not that anything honours it.
import { describe, it, expect } from "bun:test";

import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import type { EventHandler } from "../internal-types.ts";
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

// Text carrying every trigger the auth regex looks for, as a rule confirmation
// plausibly would (`4 grep 401` is an entirely reasonable thing to type).
const AUTH_SHAPED =
  "Allowing any command starting with `grep 401` for this session.";

async function emitSystemText(
  isomuxAuthored: true | undefined,
): Promise<string[]> {
  const logs: string[] = [];
  const sink: EventHandler = (e) => {
    if (e.type === "log_entry" && e.entry.kind === "system")
      logs.push(e.entry.content);
  };
  // The real backends' detectAuthError is the 401/403/"not logged in" regex;
  // FakeBackend defaults to "never", so give it the same shape to test against.
  const fake = new FakeBackend({
    isAuthError: (t) => /401|403|not logged in|authentication/i.test(t),
    loginInstructions: { text: "Sign in to continue." },
  });
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: room() }),
    initialRooms: [],
    eventSink: sink,
  });
  mgr.configurePluginHooksDeps();
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
    undefined,
    "codex",
  );
  if (!info) throw new Error("spawn returned null");
  // The session is created on the first message, not at spawn.
  mgr.enqueueMessage(info.id, {
    sender: { kind: "user", username: "Boss" },
    text: "hi",
  });
  await waitUntil(
    () => fake.sessionForAgent(info.id) !== undefined,
    "session created",
  );
  fake.sessionForAgent(info.id)!.push({
    kind: "system_text",
    text: AUTH_SHAPED,
    ...(isomuxAuthored ? { isomuxAuthored } : {}),
  });
  await waitUntil(
    () => logs.some((l) => l.includes("grep 401")),
    "breadcrumb logged",
  );
  // Login instructions are emitted right after, so one more tick settles it.
  await sleep(50);
  return logs;
}

describe("system_text auth sniffing", () => {
  it("relayed backend text still triggers the sign-in card", async () => {
    const logs = await emitSystemText(undefined);
    expect(logs.some((l) => /sign in|login|log in/i.test(l))).toBe(true);
  });

  it("Isomux-authored text never does, however auth-shaped it reads", async () => {
    const logs = await emitSystemText(true);
    expect(logs.some((l) => l.includes("grep 401"))).toBe(true);
    expect(logs.some((l) => /sign in|login|log in/i.test(l))).toBe(false);
  });
});
