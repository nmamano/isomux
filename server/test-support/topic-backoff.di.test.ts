// Topic generation after a failed one-shot: automatic triggers back off per
// model, the manual refresh does not, and a failed refresh keeps the old label.
import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OfficeState } from "../../shared/office-state.ts";
import type { AgentBackendType, RoomWire } from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import { codexBackend } from "../backends/codex/adapter.ts";
import { isCodexAuthenticated } from "../backends/codex/native-bin.ts";
import { STATE_ROOT } from "../config.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";

const MINUTE = 60_000;
const START = new Date("2026-10-17T12:00:00Z").getTime();

afterEach(() => {
  setSystemTime();
  clearTestManagedOfficeEnv();
});

function room(id: string): RoomWire {
  return { id, name: id, prompt: null, canCloseWhenEmpty: false };
}

// setSystemTime freezes Date.now, so the deadline reads performance.now.
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check() && performance.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

// The one-shot is fire-and-forget; give a skipped trigger the same window a
// real one would need to reach the backend.
async function settle(): Promise<void> {
  await Bun.sleep(100);
}

// Each reply in `replies` answers one one-shot call in order: a string is the
// label, an Error is a failed call, a function runs and returns the reply.
async function harness(
  replies: (string | Error | (() => string))[],
  opts: {
    agentType?: AgentBackendType;
    isAuthError?: (text: string) => boolean;
  } = {},
) {
  setSystemTime(START);
  let calls = 0;
  const fake = new FakeBackend({
    models: [
      { id: "slow", label: "Slow", supportedEfforts: [], isDefault: true },
      { id: "fast", label: "Fast", supportedEfforts: [] },
    ],
    oneShot: () => {
      const reply = replies[calls++];
      if (reply === undefined) throw new Error("unexpected one-shot call");
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply() : reply;
    },
    isAuthError: opts.isAuthError,
    session: {
      onSend: (_text, _attachments, session) =>
        session.completeTurn({ text: "ok" }),
    },
  });
  const roomId = `topic-${crypto.randomUUID()}`;
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: [room(roomId)] }),
    initialRooms: [],
    findUser: () => ({ id: "user-a", role: "member" }),
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    `Topic ${roomId}`,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    "slow",
    "high",
    "tester",
    opts.agentType ?? "opencode",
    undefined,
    "user-a",
  );
  const agentId = info!.id;
  const topic = () => mgr.getAgent(agentId)?.topic;
  // Sends one message and waits until any topic call it started has settled.
  const send = async (text: string) => {
    const before = fake.oneShotCount;
    await mgr.sendMessage(agentId, text, "tester");
    await settle();
    if (fake.oneShotCount > before) await waitFor(() => topic() !== "...");
  };
  const refresh = async () => {
    const before = fake.oneShotCount;
    mgr.resetTopic(agentId);
    await waitFor(() => fake.oneShotCount > before && topic() !== "...");
  };
  return { mgr, fake, agentId, topic, send, refresh };
}

const timedOut = () => new Error("OpenCode one-shot prompt timed out.");

describe("topic generation backoff", () => {
  it("skips automatic tries until the wait ends, and doubles the wait", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fake, agentId, send } = await harness([
        timedOut(),
        timedOut(),
        timedOut(),
      ]);
      await send("first");
      expect(fake.oneShotCount).toBe(1);
      await send("second, same minute");
      expect(fake.oneShotCount).toBe(1);

      setSystemTime(START + 10 * MINUTE + 1);
      await send("after the first wait");
      expect(fake.oneShotCount).toBe(2);

      // The second failure waits 20 minutes, not 10.
      setSystemTime(START + 20 * MINUTE + 2);
      await send("10 minutes after the second failure");
      expect(fake.oneShotCount).toBe(2);
      setSystemTime(START + 30 * MINUTE + 2);
      await send("20 minutes after the second failure");
      expect(fake.oneShotCount).toBe(3);

      // One journal line per real attempt, none for a skipped one.
      const lines = errors.mock.calls.filter((call) =>
        call.some((arg) => String(arg).includes(agentId)),
      );
      expect(lines).toHaveLength(3);
    } finally {
      errors.mockRestore();
    }
  });

  it("restarts the wait from the base after a success", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { mgr, fake, agentId, topic, send } = await harness([
        timedOut(),
        "Label one",
        timedOut(),
        "Label two",
      ]);
      await send("first");
      setSystemTime(START + 10 * MINUTE + 1);
      await send("after the wait");
      expect(fake.oneShotCount).toBe(2);
      expect(topic()).toBe("Label one");

      // A new conversation has no topic, so its first message tries again.
      await mgr.newConversation(agentId);
      expect(topic()).toBeNull();
      await send("new conversation");
      expect(fake.oneShotCount).toBe(3);

      // Counted as a first failure: 10 minutes, not 20.
      setSystemTime(START + 20 * MINUTE + 2);
      await send("10 minutes later");
      expect(fake.oneShotCount).toBe(4);
      expect(topic()).toBe("Label two");
    } finally {
      errors.mockRestore();
    }
  });

  it("lets the manual refresh run during the wait", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fake, topic, send, refresh } = await harness([
        timedOut(),
        "Manual label",
      ]);
      await send("first");
      expect(fake.oneShotCount).toBe(1);
      // The wait is active: an automatic try in the same minute is skipped.
      await send("second, same minute");
      expect(fake.oneShotCount).toBe(1);
      await refresh();
      expect(fake.oneShotCount).toBe(2);
      expect(topic()).toBe("Manual label");
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the earlier topic when a refresh fails", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { mgr, agentId, topic, send, refresh } = await harness([
        "Earlier label",
        timedOut(),
      ]);
      await send("first");
      expect(topic()).toBe("Earlier label");
      // The reply after the label marks it stale; the refresh failure keeps
      // that flag too.
      expect(mgr.getAgent(agentId)?.topicStale).toBe(true);
      await refresh();
      expect(topic()).toBe("Earlier label");
      expect(mgr.getAgent(agentId)?.topicStale).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it("ignores the wait after a model change", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { mgr, fake, agentId, topic, send } = await harness([
        timedOut(),
        "Fast label",
      ]);
      await send("first");
      expect(fake.oneShotCount).toBe(1);
      await mgr.editAgent(agentId, { modelFamily: "fast" });
      expect(mgr.getAgent(agentId)?.modelFamily).toBe("fast");
      await send("second, same minute");
      expect(fake.oneShotCount).toBe(2);
      expect(topic()).toBe("Fast label");
    } finally {
      errors.mockRestore();
    }
  });
  it("skips the automatic refresh of a stale topic during the wait", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { mgr, fake, agentId, topic, send } = await harness([
        "Good label",
        timedOut(),
      ]);
      await send("first");
      expect(topic()).toBe("Good label");
      // Each message adds a user entry and a reply; past the drift threshold
      // the next message starts an automatic refresh, which fails.
      let fillers = 0;
      while (fake.oneShotCount === 1 && fillers < 30) {
        await mgr.sendMessage(agentId, `filler ${fillers}`, "tester");
        fillers++;
      }
      expect(fake.oneShotCount).toBe(2);
      // About ten messages pass before the threshold, all without a call.
      expect(fillers).toBeGreaterThanOrEqual(8);
      await waitFor(() => topic() !== "...");
      expect(topic()).toBe("Good label");
      expect(mgr.getAgent(agentId)?.topicStale).toBe(true);

      await send("same minute, still stale");
      expect(fake.oneShotCount).toBe(2);
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the earlier topic and starts no wait on a signed-out notice", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const codexHome = join(STATE_ROOT, `topic-codex-${crypto.randomUUID()}`);
      mkdirSync(codexHome, { recursive: true });
      const authFile = join(codexHome, "auth.json");
      writeFileSync(authFile, "{}");
      setTestManagedOfficeEnv({ CODEX_HOME: codexHome, OPENAI_API_KEY: "" });
      const notice = "401 Unauthorized";
      expect(codexBackend.detectAuthError(notice)).toBe(true);
      const { mgr, fake, agentId, topic, send, refresh } = await harness(
        [
          "Earlier label",
          () => {
            // Signed out while the call ran: the reply is the auth notice.
            rmSync(authFile);
            return notice;
          },
          "Fresh label",
        ],
        {
          agentType: "codex",
          isAuthError: (text) => codexBackend.detectAuthError(text),
        },
      );
      await send("first");
      expect(topic()).toBe("Earlier label");
      const stale = mgr.getAgent(agentId)?.topicStale;

      await refresh();
      expect(fake.oneShotCount).toBe(2);
      expect(
        isCodexAuthenticated(mgr.buildEnvForUserId("user-a")),
      ).toBe(false);
      expect(topic()).toBe("Earlier label");
      expect(mgr.getAgent(agentId)?.topicStale).toBe(stale);

      // Signed in again, a new conversation labels at once: no wait.
      writeFileSync(authFile, "{}");
      await mgr.newConversation(agentId);
      expect(topic()).toBeNull();
      await send("new conversation");
      expect(fake.oneShotCount).toBe(3);
      expect(topic()).toBe("Fresh label");
      expect(
        errors.mock.calls.filter((call) =>
          call.some((arg) => String(arg).includes(agentId)),
        ),
      ).toHaveLength(0);
    } finally {
      errors.mockRestore();
    }
  });
});
