// Turn start (task 459936c8): the context notice's wait for an in-flight
// context sample and the member usage cap's admission do not depend on each
// other, so the wait runs during the admission instead of after it. The
// notice's bound is counted from the turn's start: once the admission took
// longer than that bound, the send goes as soon as the admission answers.
//
// Seam: createAgentManager + FakeBackend, with the office's usage cap swapped
// for one that is on and holds each admission until the test answers it.

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import {
  setMemberUsageCapForTests,
  type Admission,
  type MemberUsageCap,
} from "../member-usage-cap.ts";
import { STATE_ROOT } from "../config.ts";
import type { ContextUsage } from "../backends/types.ts";

setDefaultTimeout(20_000);

// The notice's bound on its wait for a sample (production: 500 ms). Large, so
// a wait that starts only after the admission shows as a gap far above the
// noise of a loaded runner.
const SAMPLE_WAIT_MS = 1_000;
// A name no test makes a user: direct input from it is capped.
const MEMBER = "Cap Member 459936c8";
// Envelope marker of the context notice (a protocol value, not copy).
const NOTICE_MARK = "--- begin isomux: context-check ---";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

let restoreCap: MemberUsageCap | null | undefined;
const fakes: FakeBackend[] = [];
afterEach(() => {
  if (restoreCap !== undefined) setMemberUsageCapForTests(restoreCap);
  restoreCap = undefined;
  for (const fake of fakes.splice(0)) for (const s of fake.sessions) s.close();
});

async function setup() {
  // Admissions answer at once until `hold` is set; then each waits for the
  // test.
  const admission = {
    hold: false,
    held: [] as Array<() => void>,
  };
  const cap: MemberUsageCap = {
    isEnabled: () => true,
    setEnabled() {},
    share: () => 80,
    setShare() {},
    admit: () =>
      new Promise<Admission>((res) => {
        const admit = () => res({ kind: "admitted" });
        if (admission.hold) admission.held.push(admit);
        else admit();
      }),
    peek: () => null,
    status: async () => [],
    invalidate() {},
    close() {},
  };
  restoreCap = setMemberUsageCapForTests(cap);

  // Each sample after a turn parks until the test answers it.
  const samples: Array<(usage: ContextUsage | null) => void> = [];
  const fake = new FakeBackend({
    session: {
      contextUsage: () =>
        new Promise<ContextUsage | null>((res) => samples.push(res)),
      onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
    },
  });
  fakes.push(fake);
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({
      rooms: [{ id: "room-a", name: "room-a", prompt: null }],
    }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps(SAMPLE_WAIT_MS);
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
    "claude",
  );
  if (!info) throw new Error("spawn returned null");
  // The automatic handoff stands in for the context notice: off, so it shows.
  await mgr.editAgent(info.id, { autoHandoff: false });
  const sentTexts = () =>
    (fake.sessionForAgent(info.id)?.sent ?? []).map((m) => m.text);

  // Turn one: admitted at once; its end starts a sample, which stays in
  // flight.
  void mgr.sendMessage(info.id, "one", MEMBER);
  await waitUntil(() => sentTexts().length === 1, "turn one sent");
  await waitUntil(() => samples.length === 1, "turn one's sample in flight");
  await waitUntil(() => {
    const state = mgr.getAgent(info.id)?.state;
    return state !== "thinking" && state !== "tool_executing";
  }, "turn one ended");
  return { mgr, info, admission, samples, sentTexts };
}

// The admission outlasts the notice's bound while the sample stays in flight:
// the turn sends as soon as the admission answers, with no wait after it.
async function expectNoWaitAfterAdmission(
  ctx: Awaited<ReturnType<typeof setup>>,
  send: () => void,
): Promise<void> {
  const { admission, samples, sentTexts } = ctx;
  admission.hold = true;
  send();
  await waitUntil(() => admission.held.length === 1, "admission asked");
  // The condition the case stands for: the sample is still in flight.
  expect(samples.length).toBe(1);
  await sleep(SAMPLE_WAIT_MS + 200);
  expect(sentTexts()).toHaveLength(1);
  const answeredAt = Date.now();
  admission.held[0]!();
  await waitUntil(() => sentTexts().length === 2, "turn two sent");
  expect(Date.now() - answeredAt).toBeLessThan(SAMPLE_WAIT_MS / 2);
  expect(sentTexts()[1]).toContain("two");
}

describe("context notice wait during the usage-cap admission", () => {
  it("a direct message sends as soon as a slow admission answers", async () => {
    const ctx = await setup();
    await expectNoWaitAfterAdmission(ctx, () => {
      void ctx.mgr.sendMessage(ctx.info.id, "two", MEMBER);
    });
  });

  it("a queued message sends as soon as a slow admission answers", async () => {
    const ctx = await setup();
    await expectNoWaitAfterAdmission(ctx, () => {
      const r = ctx.mgr.enqueueMessage(ctx.info.id, {
        sender: { kind: "user", username: MEMBER },
        text: "two",
      });
      if (!r.ok) throw new Error(`enqueue failed: ${r.error}`);
    });
  });

  // The sample answers during the admission: its reading still reaches the
  // turn's notice.
  it("carries the notice from a sample that answered during the admission", async () => {
    const { mgr, info, admission, samples, sentTexts } = await setup();
    admission.hold = true;
    void mgr.sendMessage(info.id, "two", MEMBER);
    await waitUntil(() => admission.held.length === 1, "admission asked");
    samples[0]!({
      model: "fake-model",
      totalTokens: 680_000,
      maxTokens: 1_000_000,
      percentage: 68,
    });
    await sleep(20);
    admission.held[0]!();
    await waitUntil(() => sentTexts().length === 2, "turn two sent");
    expect(sentTexts()[1]!.startsWith(NOTICE_MARK)).toBe(true);
  });
});
