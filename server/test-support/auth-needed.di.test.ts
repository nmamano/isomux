// The backend adapter decides that a turn needs sign-in and says so with one
// auth_needed event; the orchestrator never reads event text for it. These pin
// both directions at the orchestrator: auth_needed gives the card and a
// waiting desk, and auth-shaped text without it gives neither. The fake's
// detectAuthError calls every text below auth-shaped, so a sniff that comes
// back fails the cases without auth_needed.
import { describe, it, expect } from "bun:test";

import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import type { NormalizedEvent } from "../backends/types.ts";
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

// A rule confirmation can quote any trigger of the auth regex (`4 grep 401`
// is a reasonable thing to type).
const AUTH_SHAPED_NOTE =
  "Allowing any command starting with `grep 401` for this session.";
const AUTH_SHAPED_ERROR = "401 Unauthorized";

// `idle`: the events land after a first turn ended, with no turn waiting on
// them. `queue` and `send`: they end the turn a queued message or a direct
// send started, whose owner then handles the rejected turn too.
async function run(
  events: NormalizedEvent[],
  until: "card" | "text" | "error",
  via: "idle" | "queue" | "send" = "idle",
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
        provider: "codex",
        scope: "office",
        accountStatus: "not_connected",
        loginStatus: "idle",
        canBrowserLogin: true,
      },
    ],
    effectiveProviderAccountTarget: () => ({
      provider: "codex",
      scope: "office",
      dir: "/accounts/office-codex",
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
    "codex",
    undefined,
    "user-a",
  );
  if (!info) throw new Error("spawn returned null");
  // The session is created on the first message, not at spawn.
  if (via === "send")
    void mgr.sendMessage(info.id, "hi", "Boss").catch(() => {});
  else
    mgr.enqueueMessage(info.id, {
      sender: { kind: "user", username: "Boss" },
      text: "hi",
    });
  await waitUntil(
    () => (fake.sessionForAgent(info.id)?.sent.length ?? 0) > 0,
    "message sent",
  );
  const session = fake.sessionForAgent(info.id)!;
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
      .filter((entry) => entry.metadata?.providerLogin === "codex");
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
  };
}

describe("auth_needed is the only sign-in signal the orchestrator reads", () => {
  it("logs auth-shaped provider text as it is, with no card", async () => {
    expect(
      await run([{ kind: "system_text", text: AUTH_SHAPED_NOTE }], "text"),
    ).toMatchObject({ cards: 0, noteLogged: true });
  });

  it("leaves an auth-shaped error without auth_needed in error, with no card", async () => {
    expect(
      await run([{ kind: "error", message: AUTH_SHAPED_ERROR }], "error"),
    ).toEqual({ cards: 0, errors: 1, noteLogged: false, state: "error" });
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
    ).toEqual({ cards: 0, errors: 1, noteLogged: false, state: "error" });
  });

  it("gives one card for auth_needed, however often it comes", async () => {
    const result = await run(
      [{ kind: "auth_needed" }, { kind: "auth_needed" }],
      "card",
    );
    expect(result).toMatchObject({ cards: 1, errors: 0 });
  });

  it("keeps the error line of an error after auth_needed, and the desk waits", async () => {
    expect(
      await run(
        [
          { kind: "auth_needed" },
          { kind: "error", message: AUTH_SHAPED_ERROR },
        ],
        "card",
      ),
    ).toEqual({
      cards: 1,
      errors: 1,
      noteLogged: false,
      state: "waiting_for_response",
    });
  });

  // The turn's owner gets the rejection after the error handler wrote the
  // line and the card: it adds no second line and leaves the desk waiting.
  for (const via of ["queue", "send"] as const) {
    it(`keeps one error line and a waiting desk when auth_needed ends a ${via} turn`, async () => {
      expect(
        await run(
          [
            { kind: "auth_needed" },
            { kind: "error", message: AUTH_SHAPED_ERROR },
          ],
          "card",
          via,
        ),
      ).toEqual({
        cards: 1,
        errors: 1,
        noteLogged: false,
        state: "waiting_for_response",
      });
    });

    it(`leaves the desk in error when an auth-shaped error with no auth_needed ends a ${via} turn`, async () => {
      expect(
        await run(
          [{ kind: "error", message: AUTH_SHAPED_ERROR }],
          "error",
          via,
        ),
      ).toMatchObject({ cards: 0, state: "error" });
    });
  }

  it("keeps the error line of a failed turn after auth_needed, and the desk waits", async () => {
    expect(
      await run(
        [
          { kind: "auth_needed" },
          { kind: "turn_completed", status: "failed", error: "Not logged in" },
        ],
        "card",
      ),
    ).toEqual({
      cards: 1,
      errors: 1,
      noteLogged: false,
      state: "waiting_for_response",
    });
  });

  it("writes no error line for a failed turn with no error after auth_needed", async () => {
    expect(
      await run(
        [{ kind: "auth_needed" }, { kind: "turn_completed", status: "failed" }],
        "card",
      ),
    ).toEqual({
      cards: 1,
      errors: 0,
      noteLogged: false,
      state: "waiting_for_response",
    });
  });
});
