// When Claude refuses to let a signed-in account use Claude Code (for example,
// its subscription expired), the SDK sends a synthetic message whose text
// blames "your organization". The Claude adapter marks it `claudeAccessDenied`
// from the SDK error code; the orchestrator must
// replace the raw text with its own reason and the sign-in card, without the
// account probe the generic auth path runs (that probe reports "connected"
// here and would print the wrong advice).
import { describe, it, expect } from "bun:test";

import { OfficeState } from "../../shared/office-state.ts";
import type { AgentBackendType, RoomWire } from "../../shared/types.ts";
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

const CLI_TEXT =
  "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
const OTHER_TEXT = "Provider session initialized.";

async function emit(
  agentType: AgentBackendType,
  text: string,
  claudeAccessDenied: true | undefined,
) {
  const fake = new FakeBackend();
  let accountReads = 0;
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: room() }),
    initialRooms: [],
    listProviderAccounts: async () => {
      accountReads++;
      return [];
    },
    effectiveProviderAccountTarget: () => ({
      provider: "claude",
      scope: "office",
      dir: "/accounts/office-claude",
    }),
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
    agentType,
    undefined,
    "user-a",
  );
  if (!info) throw new Error("spawn returned null");
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
    text,
    ...(claudeAccessDenied ? { claudeAccessDenied } : {}),
  });
  // A trailing marker: once it lands, the event before it has been handled.
  fake.sessionForAgent(info.id)!.push({ kind: "system_text", text: OTHER_TEXT });
  await waitUntil(
    () => mgr.getAgentLogs(info.id).some((e) => e.content === OTHER_TEXT),
    "events handled",
  );
  return { logs: mgr.getAgentLogs(info.id), accountReads };
}

describe("Claude access-denied notice", () => {
  it("replaces the CLI text with the reason and the Claude sign-in card", async () => {
    const { logs, accountReads } = await emit("claude", CLI_TEXT, true);
    const cards = logs.filter((e) => e.metadata?.providerLogin === "claude");
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("system");
    expect(cards[0].content).not.toBe(CLI_TEXT);
    expect(cards[0].content.length).toBeGreaterThan(0);
    expect(logs.some((e) => e.content === CLI_TEXT)).toBe(false);
    // No generic auth probe: its "checking" and "connected" entries would
    // add a second card.
    expect(accountReads).toBe(0);
  });

  it("relays the same text unchanged when the adapter did not flag it", async () => {
    const { logs } = await emit("claude", CLI_TEXT, undefined);
    expect(logs.some((e) => e.content === CLI_TEXT)).toBe(true);
    expect(logs.some((e) => e.metadata?.providerLogin)).toBe(false);
  });

  it("ignores the flag on a non-Claude agent", async () => {
    const { logs } = await emit("codex", CLI_TEXT, true);
    expect(logs.some((e) => e.content === CLI_TEXT)).toBe(true);
    expect(logs.some((e) => e.metadata?.providerLogin)).toBe(false);
  });
});
