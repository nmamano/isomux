// The backend adapter decides that a turn needs sign-in and says so with one
// auth_needed event; the orchestrator never reads event text for it. These pin
// both directions at the orchestrator: auth_needed gives the card and a
// waiting desk, and auth-shaped text without it gives neither. The fake's
// detectAuthError calls every text below auth-shaped, so a sniff that comes
// back fails the cases without auth_needed.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import type { NormalizedEvent } from "../backends/types.ts";
import type { AgentBackendType } from "../../shared/types.ts";
import { msg } from "../../shared/i18n/log-message.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { FakeBackend } from "./fake-backend.ts";
import { removeStateDir } from "./temp-state.ts";

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

// A rule confirmation can quote any trigger of the auth regex (`4 grep 401`
// is a reasonable thing to type).
const AUTH_SHAPED_NOTE =
  "Allowing any command starting with `grep 401` for this session.";
const AUTH_SHAPED_ERROR = "401 Unauthorized";
// What diagnoseProcessExit can add under a Claude agent's error line.
const EXIT_HINT_KEYS: string[] = [
  "systemEntries.claudeExit.cwdMissing",
  "systemEntries.claudeSession.missingAfterExit",
];

// A file skill, so `/<name>` runs as a skill turn.
const SKILL = "authneededskill";
const skillDir = join(STATE_ROOT, "skills", SKILL);
beforeAll(() => {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "Do the thing.");
});
afterAll(() => removeStateDir(skillDir));

// `idle`: the events land after a first turn ended, with no turn waiting on
// them. The others end the turn that a queued message, a direct send or a
// skill started, whose owner then handles the rejected turn too. (`/plan
// <text>` ends through the same command-turn path as a skill.)
async function run(
  events: NormalizedEvent[],
  until: "card" | "text" | "error",
  via: "idle" | "queue" | "send" | "skill" = "idle",
  agentType: AgentBackendType = "codex",
) {
  const fake = new FakeBackend({
    isAuthError: (t) => /401|not logged in|authentication/i.test(t),
    loginInstructions: {
      text: "Sign in to continue.",
      commands: ["codex login --device-auth"],
    },
  });
  expect(fake.detectAuthError(AUTH_SHAPED_NOTE)).toBe(true);
  expect(fake.detectAuthError(AUTH_SHAPED_ERROR)).toBe(true);
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: room() }),
    initialRooms: [],
    listProviderAccounts: async () => [
      {
        provider: agentType === "claude" ? "claude" : "codex",
        scope: "office",
        accountStatus: "not_connected",
        loginStatus: "idle",
        canBrowserLogin: true,
      },
    ],
    effectiveProviderAccountTarget: (_userId, provider) => ({
      provider,
      scope: "office",
      dir: `/accounts/office-${provider}`,
    }),
    // An owner manager: a member's office card says to ask an owner.
    findUser: () => ({ id: "user-a", role: "owner" }),
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
  // The session is created on the first message, not at spawn.
  const typed = { send: "hi", skill: `/${SKILL}` } as const;
  if (via === "send" || via === "skill")
    void mgr.sendMessage(info.id, typed[via], "Morgan").catch(() => {});
  else
    mgr.enqueueMessage(info.id, {
      sender: { kind: "user", username: "Morgan" },
      text: "hi",
    });
  await waitUntil(
    () => (fake.sessionForAgent(info.id)?.sent.length ?? 0) > 0,
    "message sent",
  );
  const session = fake.sessionForAgent(info.id)!;
  // The turn is the kind `via` names: a skill sends the skill's prompt.
  if (via === "skill") expect(session.sent[0].text).toContain("Do the thing.");
  if (via === "idle") {
    session.completeTurn({ text: "ok" });
    await waitUntil(
      () => mgr.getAgent(info.id)?.state === "waiting_for_response",
      "first turn done",
    );
  }
  session.pushAll(events);
  const card = () =>
    mgr
      .getAgentLogs(info.id)
      .filter((entry) => entry.metadata?.providerLogin === agentType);
  await waitUntil(() => {
    const logs = mgr.getAgentLogs(info.id);
    if (until === "card") return card().length > 0;
    if (until === "text")
      return logs.some((entry) => entry.content === AUTH_SHAPED_NOTE);
    return mgr.getAgent(info.id)?.state === "error";
  }, until);
  // The card is written after an account read: give a wrong one time to land.
  await sleep(50);
  const logs = mgr.getAgentLogs(info.id);
  return {
    cards: card().length,
    errors: logs.filter((entry) => entry.kind === "error").length,
    noteLogged: logs.some((entry) => entry.content === AUTH_SHAPED_NOTE),
    state: mgr.getAgent(info.id)?.state,
    // The provider's own words anywhere in the chat, metadata included.
    providerText: JSON.stringify(logs).includes(AUTH_SHAPED_ERROR),
    // The Claude process-exit hint that annotates an error line.
    exitHints: logs.filter((entry) =>
      entry.message?.some(
        (part) => typeof part === "object" && EXIT_HINT_KEYS.includes(part.key),
      ),
    ).length,
  };
}

describe("auth_needed is the only sign-in signal the orchestrator reads", () => {
  it("logs auth-shaped provider text as it is, with no card", async () => {
    expect(
      await run([{ kind: "system_text", text: AUTH_SHAPED_NOTE }], "text"),
    ).toMatchObject({ cards: 0, noteLogged: true });
  });

  // The controls: without auth_needed the provider's words are the error
  // line, so the cases below that find none of them are not blind.
  it("leaves an auth-shaped error without auth_needed in error, with no card", async () => {
    expect(
      await run([{ kind: "error", message: AUTH_SHAPED_ERROR }], "error"),
    ).toEqual({
      cards: 0,
      errors: 1,
      noteLogged: false,
      state: "error",
      providerText: true,
      exitHints: 0,
    });
  });

  it("leaves an auth-shaped failed turn without auth_needed in error, with no card", async () => {
    expect(
      await run(
        [
          {
            kind: "turn_completed",
            status: "failed",
            error: AUTH_SHAPED_ERROR,
          },
        ],
        "error",
      ),
    ).toEqual({
      cards: 0,
      errors: 1,
      noteLogged: false,
      state: "error",
      providerText: true,
      exitHints: 0,
    });
  });

  // Task 604d052b. After auth_needed the sign-in card is the fix: the
  // provider's words (a CLI's "run <command> to sign in") never reach the
  // chat, and the desk waits for the member.
  const SIGN_IN_ONLY = {
    cards: 1,
    errors: 0,
    noteLogged: false,
    state: "waiting_for_response" as const,
    providerText: false,
    exitHints: 0,
  };

  it("writes no provider error line for an error after auth_needed", async () => {
    expect(
      await run(
        [
          { kind: "auth_needed" },
          { kind: "error", message: AUTH_SHAPED_ERROR },
        ],
        "card",
      ),
    ).toEqual(SIGN_IN_ONLY);
  });

  // The turn's owner gets the rejection after the event handler wrote the
  // card: it adds no line of its own and leaves the desk waiting.
  for (const via of ["queue", "send", "skill"] as const) {
    it(`writes only the card and a waiting desk when auth_needed ends a ${via} turn`, async () => {
      expect(
        await run(
          [
            { kind: "auth_needed" },
            { kind: "error", message: AUTH_SHAPED_ERROR },
          ],
          "card",
          via,
        ),
      ).toEqual(SIGN_IN_ONLY);
    });

    it(`leaves the desk in error when an auth-shaped error with no auth_needed ends a ${via} turn`, async () => {
      expect(
        await run(
          [{ kind: "error", message: AUTH_SHAPED_ERROR }],
          "error",
          via,
        ),
      ).toMatchObject({ cards: 0, state: "error", providerText: true });
    });
  }

  it("writes no provider error line for a failed turn after auth_needed", async () => {
    expect(
      await run(
        [
          { kind: "auth_needed" },
          {
            kind: "turn_completed",
            status: "failed",
            error: AUTH_SHAPED_ERROR,
          },
        ],
        "card",
      ),
    ).toEqual(SIGN_IN_ONLY);
  });

  it("writes no error line for a failed turn with no error after auth_needed", async () => {
    expect(
      await run(
        [{ kind: "auth_needed" }, { kind: "turn_completed", status: "failed" }],
        "card",
      ),
    ).toEqual(SIGN_IN_ONLY);
  });

  // A line Isomux wrote itself (a message, not provider text) is not the
  // provider's sign-in advice: it still shows under the card.
  const ISOMUX_ERROR = msg("systemEntries.codexTokenRefresh");
  for (const [name, ev] of [
    ["an error", { kind: "error", message: ISOMUX_ERROR }],
    [
      "a failed turn",
      { kind: "turn_completed", status: "failed", error: ISOMUX_ERROR },
    ],
  ] as const) {
    it(`keeps Isomux's own error line for ${name} after auth_needed`, async () => {
      expect(
        await run([{ kind: "auth_needed" }, ev as NormalizedEvent], "card"),
      ).toEqual({ ...SIGN_IN_ONLY, errors: 1 });
    });
  }

  // A Claude agent's error line gets a process-exit hint (here: no
  // transcript for the session). With no line, the hint goes too.
  it("writes a Claude exit hint under the error line without auth_needed", async () => {
    expect(
      await run(
        [{ kind: "error", message: AUTH_SHAPED_ERROR }],
        "error",
        "idle",
        "claude",
      ),
    ).toEqual({
      cards: 0,
      errors: 1,
      noteLogged: false,
      state: "error",
      providerText: true,
      exitHints: 1,
    });
  });

  it("writes no Claude exit hint when auth_needed drops the error line", async () => {
    expect(
      await run(
        [
          { kind: "auth_needed" },
          { kind: "error", message: AUTH_SHAPED_ERROR },
        ],
        "card",
        "idle",
        "claude",
      ),
    ).toEqual(SIGN_IN_ONLY);
  });
});
