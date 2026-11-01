// Task 8db21c8b: each session start decides its PID namespace form once, and
// its spawn (CreateSessionOptions.isolation) and its system prompt line follow
// that one decision: agent sessions and scheduled runs. The probe result is
// set, never run; afterEach puts it back to "no result" (off), so no other
// test file's spawns are wrapped.
import { afterEach, describe, expect, it } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";
import type { AgentInfo, RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { createCronjobManager } from "../cronjob-manager.ts";
import type { IsolationForm } from "../process-isolation.ts";
import {
  setProcessIsolationProbe,
  setProcessIsolationSwitch,
} from "../process-isolation-state.ts";
import { processIsolationPromptLine } from "../system-prompt.ts";
import { FakeBackend } from "./fake-backend.ts";
import { makeFakeCronPersistence } from "./fake-cron-persistence.ts";

afterEach(() => {
  setProcessIsolationProbe(null);
  setProcessIsolationSwitch(() => true);
});

const FORMS: IsolationForm[] = ["session", "shared_server"];

// Which form's line the prompt carries, or null for none. Each line is
// non-empty and the two differ, so a prompt carries at most one.
function lineIn(prompt: string): IsolationForm | null {
  const found = FORMS.filter((form) =>
    prompt.includes(processIsolationPromptLine(form)),
  );
  expect(found.length).toBeLessThan(2);
  return found[0] ?? null;
}

describe("the prompt lines", () => {
  it("are one per form, and none for an unwrapped session", () => {
    const [session, shared] = FORMS.map(processIsolationPromptLine);
    expect(session.trim().length).toBeGreaterThan(0);
    expect(shared.trim().length).toBeGreaterThan(0);
    expect(session).not.toBe(shared);
    expect(processIsolationPromptLine(null)).toBe("");
  });
});

function rooms(id: string): RoomWire[] {
  return [{ id, name: id, prompt: null, canCloseWhenEmpty: false }];
}

async function startedSession(
  agentType: AgentInfo["agentType"],
  codexSandbox?: AgentInfo["codexSandbox"],
  access?: AgentAccess,
) {
  const fake = new FakeBackend({
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
  const room = `room-iso-${agentType}-${codexSandbox ?? "none"}-${access ?? "standard"}`;
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms(room) }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn(
    `iso ${agentType}`,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    room,
    undefined,
    agentType === "opencode" ? "gate/gate-model" : undefined,
    undefined,
    undefined,
    agentType,
    codexSandbox,
    undefined,
    undefined,
    access === undefined
      ? undefined
      : { grant: { access }, refusal: () => null },
  );
  await mgr.sendMessage(info!.id, "hello", "tester");
  const session = fake.sessionForAgent(info!.id)!;
  fake.sessions.forEach((s) => s.close());
  return {
    isolation: session.opts.isolation ?? null,
    line: lineIn(session.opts.systemPrompt),
  };
}

describe("an agent session start", () => {
  it("gives the spawn and the prompt the same form on every engine", async () => {
    setProcessIsolationProbe({ available: true });
    const cases = [
      ["claude", undefined, "session"],
      ["codex", "danger-full-access", "session"],
      ["codex", "read-only", null],
      ["opencode", undefined, "shared_server"],
    ] as const;
    for (const [agentType, sandbox, form] of cases) {
      const got = await startedSession(agentType, sandbox);
      expect([agentType, sandbox, got]).toEqual([
        agentType,
        sandbox,
        { isolation: form, line: form },
      ]);
    }
  });

  // Below standard the agent has no shell: the wrap stays, and the line,
  // which speaks of ps and sudo, is left out.
  it("wraps an agent below standard but gives it no line", async () => {
    setProcessIsolationProbe({ available: true });
    expect(await startedSession("claude", undefined, "chat")).toEqual({
      isolation: "session",
      line: null,
    });
  });

  it("gives neither a wrap nor a line when the owner turned it off", async () => {
    setProcessIsolationProbe({ available: true });
    setProcessIsolationSwitch(() => false);
    expect(await startedSession("claude")).toEqual({
      isolation: null,
      line: null,
    });
  });
});

describe("a scheduled run", () => {
  it("gives its spawn and its prompt the same form", async () => {
    setProcessIsolationProbe({ available: true });
    for (const [on, form] of [
      [true, "session"],
      [false, null],
    ] as const) {
      setProcessIsolationSwitch(() => on);
      const fake = new FakeBackend({
        session: { onSend: (_t, _a, s) => s.completeTurn({ text: "done" }) },
      });
      const mgr = createCronjobManager({
        resolveBackend: () => fake,
        resolveEnv: () => ({}),
        resolveEnvironmentKey: () => "test-environment",
        resolveEnvironmentRevision: () => "test-revision",
        resolveUser: () => undefined,
        persistence: makeFakeCronPersistence(),
        clock: { now: () => 1_000_000 },
        // Never fires: the run starts through runCronjobNow only.
        scheduler: {
          setTimeout: (() => 0) as unknown as typeof setTimeout,
          clearTimeout: () => {},
          setInterval: (() => 0) as unknown as typeof setInterval,
          clearInterval: () => {},
        },
        renderMemoryForPrompt: () => null,
      });
      const job = mgr.addCronjob({
        name: `IsoJob${on}`,
        schedule: { type: "interval", minutes: 60 },
        prompt: "do the thing",
        cwd: STATE_ROOT,
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
        username: "Nil",
      });
      mgr.runCronjobNow(job.id, "Nil");
      for (let i = 0; i < 200 && fake.createSessionCount === 0; i++)
        await Bun.sleep(5);
      const opts = fake.lastSession!.opts;
      expect([on, opts.isolation ?? null, lineIn(opts.systemPrompt)]).toEqual([
        on,
        form,
        form,
      ]);
      fake.sessions.forEach((s) => s.close());
    }
  });
});
