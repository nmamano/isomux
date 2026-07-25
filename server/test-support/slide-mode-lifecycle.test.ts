// Slide Mode lifecycle integration (AgentManager DI seam, FakeBackend, zero LLM).
// Proves the wiring the slide-mode unit tests can't reach on their own, driving
// real turns through createAgentManager:
//   - BOOT terminal boundary: an agent with a settled tail and NO in-flight turn
//     (the state a restart restores: pendingTurn=null) treats the tail as
//     terminal — ensureSlide generates a slide FROM the persisted tail content —
//     and a subsequent send starts a NEW user_message anchor.
//   - Universal drain through the real pendingTurn promise: a slide request
//     parked while the newest turn is IN FLIGHT (non-terminal) is fulfilled when
//     that turn settles via a control-plane path (an interrupt), driving
//     createTurnDeferred's drainOnSettle -> onTurnSettled -> generate. The pure
//     drainOnSettle resolve/reject branches are covered in slide-mode.test.ts;
//     this proves the actual manager settle reaches the drain.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { FakeBackend, type FakeSessionConfig } from "./fake-backend.ts";
import { setOfficeEnvFileProvider } from "../env-loader.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { SLIDE_SYSTEM_PROMPT } from "../slide-mode.ts";
import { STATE_ROOT } from "../config.ts";
import type { AgentEvent } from "../internal-types.ts";
import type { RoomWire } from "../../shared/types.ts";

function rooms(id: string): RoomWire[] {
  return [{ id, name: id, prompt: null, canCloseWhenEmpty: false }];
}

const SLIDE_HTML = '<div style="width:100%;height:100%">Slide</div>';

async function waitUntil(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  setOfficeEnvFileProvider(() => null);
});

// Point CLAUDE_CONFIG_DIR at a unique temp dir (via an office env file) so the
// Claude resume preflight consults a path we control, and we can seed the
// existence-only .jsonl it checks. Same pattern as context-usage.test.ts.
let envSuffix = 0;
function wireClaudeHome(): string {
  const suffix = `slide-life-${++envSuffix}`;
  const claudeHome = join(STATE_ROOT, `claude-home-${suffix}`);
  const envFile = join(STATE_ROOT, `office-${suffix}.env`);
  writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeHome}\n`);
  setOfficeEnvFileProvider(() => envFile);
  return claudeHome;
}

// Build a manager wired to a FakeBackend, spawn one agent, and capture events +
// the prompts the slide formatter (oneShotPrompt) was called with.
async function setup(
  session: FakeSessionConfig,
  // What the FORMATTER returns (or throws). Topic generation, which shares
  // oneShotPrompt, always gets the plain fake reply.
  formatter: () => string = () => SLIDE_HTML,
) {
  // Record ONLY slide-formatter calls. Topic generation shares oneShotPrompt on
  // the same backend, so counting its prompt here would make "generated exactly
  // once" assertions meaningless; the system prompt tells the two apart.
  const prompts: string[] = [];
  const fake = new FakeBackend({
    oneShot: (prompt: string, opts: { systemPrompt?: string }) => {
      if (opts.systemPrompt !== SLIDE_SYSTEM_PROMPT) return SLIDE_HTML;
      prompts.push(prompt);
      return formatter();
    },
    session,
  });
  const events: AgentEvent[] = [];
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms("room-a") }),
    initialRooms: [],
    eventSink: (e) => events.push(e),
  });
  mgr.configurePluginHooksDeps();
  const info = await mgr.spawn(
    "SlideAgent",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
  );
  const agentId = info!.id;
  cleanup = () => fake.sessionForAgent(agentId)?.close();
  const userMsgIds = () =>
    events
      .filter(
        (e): e is AgentEvent & { entry: { id: string; kind: string } } =>
          e.type === "log_entry" &&
          (e as { entry: { kind: string } }).entry.kind === "user_message",
      )
      .map((e) => e.entry.id);
  const slideReadyFor = (entryId: string) =>
    events.find(
      (e) => e.type === "slide_ready" && (e as { entryId: string }).entryId === entryId,
    ) as
      | {
          sessionId: string;
          slide: { html: string | null; placeholder: boolean };
        }
      | undefined;
  const slideFailedFor = (entryId: string) =>
    events.find(
      (e) =>
        e.type === "slide_failed" &&
        (e as { entryId: string }).entryId === entryId,
    ) as { sessionId: string; reason: string } | undefined;
  return {
    mgr,
    fake,
    events,
    prompts,
    agentId,
    userMsgIds,
    slideReadyFor,
    slideFailedFor,
  };
}

describe("Slide Mode lifecycle (DI integration)", () => {
  it("BOOT: a settled tail with no in-flight turn is terminal — generates from the tail; next send is a new anchor", async () => {
    // onSend completes the turn -> user_message + text logged, turn_completed,
    // pendingTurn=null. That is exactly the post-boot / idle shape: no running
    // turn owns the tail.
    const h = await setup({
      onSend: (_t, _a, s) =>
        s.completeTurn({ text: "The persisted tail answer." }),
    });
    h.mgr.enqueueMessage(h.agentId, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    await waitUntil(() => h.userMsgIds().length >= 1);
    const anchor = h.userMsgIds()[0];
    // Wait for the turn to settle (the text answer landed).
    await waitUntil(() =>
      h.events.some(
        (e) => e.type === "log_entry" && (e as { entry: { kind: string } }).entry.kind === "text",
      ),
    );

    // No in-flight turn owns this anchor now -> ensure treats it terminal and
    // generates from the tail (the formatter prompt carries the tail content).
    const res = h.mgr.ensureSlide(h.agentId, anchor);
    expect(res.status).toBe("pending");
    await waitUntil(() => !!h.slideReadyFor(anchor));
    expect(h.slideReadyFor(anchor)?.slide.html).toBe(SLIDE_HTML);
    expect(h.prompts.some((p) => p.includes("The persisted tail answer."))).toBe(true);

    // A subsequent send opens a NEW turn under a distinct user_message anchor —
    // it does not continue the persisted tail.
    h.mgr.enqueueMessage(h.agentId, {
      sender: { kind: "user", username: "tester" },
      text: "again",
    });
    await waitUntil(() => h.userMsgIds().length >= 2);
    const anchors = h.userMsgIds();
    expect(anchors[1]).not.toBe(anchors[0]);
  });

  it("FAILURE: a formatter that throws reaches the wire as slide_failed, not silence", async () => {
    // The deck cannot tell a failed generation from a slow one, so this event is
    // the whole contract (task 01a7327a). Proves it survives the manager wiring,
    // and that the room-visible reason is the stable code rather than the
    // backend's exception text.
    const h = await setup(
      { onSend: (_t, _a, s) => s.completeTurn({ text: "An answer." }) },
      () => {
        throw new Error("backend exploded: /home/someone/.creds not readable");
      },
    );
    h.mgr.enqueueMessage(h.agentId, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    await waitUntil(() => h.userMsgIds().length >= 1);
    const anchor = h.userMsgIds()[0];
    await waitUntil(() =>
      h.events.some(
        (e) =>
          e.type === "log_entry" &&
          (e as { entry: { kind: string } }).entry.kind === "text",
      ),
    );

    expect(h.mgr.ensureSlide(h.agentId, anchor).status).toBe("pending");
    await waitUntil(() => !!h.slideFailedFor(anchor));
    expect(h.slideFailedFor(anchor)?.reason).toBe("generation_failed");
    expect(h.slideFailedFor(anchor)?.reason).not.toContain("creds");
    expect(h.slideReadyFor(anchor)).toBeUndefined(); // no record written
  });

  it("MODEL SWAP: a conversation-continuing model change keeps the same slide identity", async () => {
    // The case that decided epoch vs root session id (and the one the office
    // just exercised switching to Opus 5). A settings-driven model swap resumes
    // the SAME session — it doesn't reset the conversation — so the slide
    // identity must survive it and in-flight work must not be dropped. The
    // slide_ready event carries the deck's root session id, so comparing it
    // across the swap asserts the identity directly.
    const claudeHome = wireClaudeHome();
    const h = await setup({
      onSend: (_t, _a, s) => s.completeTurn({ text: "An answer." }),
    });
    h.mgr.enqueueMessage(h.agentId, {
      sender: { kind: "user", username: "tester" },
      text: "before",
    });
    await waitUntil(() => h.userMsgIds().length >= 1);
    const first = h.userMsgIds()[0];
    h.mgr.ensureSlide(h.agentId, first);
    await waitUntil(() => !!h.slideReadyFor(first));
    const rootBefore = h.slideReadyFor(first)!.sessionId;

    // Seed the existence-only .jsonl the resume preflight checks, so the swap
    // takes the auto-resume path (continue) instead of falling back to a fresh
    // session — which is what makes this a CONTINUING swap.
    const sessionId = h.mgr.getCurrentSessionId(h.agentId)!;
    const dir = claudeProjectDir(h.mgr.getAgent(h.agentId)!.cwd, {
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), "");

    // A continuing model swap (settings replace, not a new conversation).
    await h.mgr.editAgent(h.agentId, { modelFamily: "sonnet" });
    // The conversation itself continued: same session id, no reset.
    expect(h.mgr.getCurrentSessionId(h.agentId)).toBe(sessionId);

    h.mgr.enqueueMessage(h.agentId, {
      sender: { kind: "user", username: "tester" },
      text: "after",
    });
    await waitUntil(() => h.userMsgIds().length >= 2);
    const second = h.userMsgIds()[1];
    h.mgr.ensureSlide(h.agentId, second);
    await waitUntil(() => !!h.slideReadyFor(second));
    expect(h.slideReadyFor(second)!.sessionId).toBe(rootBefore);
  });

  it("DRAIN: a request parked on an in-flight turn is fulfilled when the turn settles (backend death) via the real pendingTurn promise", async () => {
    // onSend streams some assistant text but does NOT complete the turn: the
    // user_message is logged (anchor stamped) and the turn stays in flight
    // (pendingTurn set, no turn_completed), so the newest turn is non-terminal.
    const h = await setup({
      onSend: (_t, _a, s) =>
        s.push({ kind: "assistant_text", text: "Working on the answer." }),
    });
    h.mgr.enqueueMessage(h.agentId, {
      sender: { kind: "user", username: "tester" },
      text: "work on it",
    });
    await waitUntil(() => h.userMsgIds().length >= 1);
    const anchor = h.userMsgIds()[0];

    // Park a request on the in-flight newest turn (gated -> pending). The unit
    // tests (slide-mode.test.ts) prove a non-terminal turn generates NOTHING;
    // here we prove the DRAIN wiring: when the turn settles, the parked request
    // is fulfilled through createTurnDeferred's drainOnSettle -> onTurnSettled.
    const res = h.mgr.ensureSlide(h.agentId, anchor);
    expect(res.status).toBe("pending");

    // Settle the turn through the real manager control-plane. The consumer
    // settles pendingTurn -> createTurnDeferred's drainOnSettle fires ->
    // onTurnSettled generates the parked slide from the turn's content. (The pure
    // resolve- AND reject-branch coverage of drainOnSettle is in slide-mode.test.ts;
    // this proves the actual manager settle reaches the drain and fulfils the
    // parked request end-to-end.)
    h.fake.sessionForAgent(h.agentId)!.completeTurn({ status: "completed" });
    await waitUntil(() => !!h.slideReadyFor(anchor));
    expect(h.slideReadyFor(anchor)?.slide.html).toBe(SLIDE_HTML);
    expect(h.prompts).toHaveLength(1); // the parked request generated exactly once
    expect(h.prompts[0]).toContain("Working on the answer.");
  });
});
