// The storage panel's destructive path, tested where it is decidable: what
// request each user action produces. The races the panel has to survive (a
// preview in flight when the form changes; a delete pressed after the form
// moved) are state questions, not pixel questions, so they live here rather
// than in a screenshot.
import { describe, it, expect } from "bun:test";
import {
  previewRequest,
  applyRequest,
  planMatchesForm,
  type PolicyForm,
} from "./storage-prune-form.ts";
import type { PrunePlanWire } from "../shared/contract-shapes.ts";

const form = (over: Partial<PolicyForm> = {}): PolicyForm => ({
  target: "transcripts",
  olderThanDays: "90",
  keepPerAgent: "5",
  ...over,
});

const planFor = (over: Partial<PrunePlanWire> = {}): PrunePlanWire => ({
  target: "transcripts",
  policy: { olderThanDays: 90, keepPerAgent: 5 },
  candidates: [],
  bytes: 0,
  skipped: [],
  ...over,
});

describe("previewRequest", () => {
  it("builds a dry run with no apply flag", () => {
    expect(previewRequest(form())).toEqual({
      target: "transcripts",
      olderThanDays: 90,
      keepPerAgent: 5,
    });
  });

  it("sends keepPerAgent 0 for transcripts rather than dropping it", () => {
    // 0 is the sharpest setting there is; it has to be stated, not implied.
    expect(previewRequest(form({ keepPerAgent: "0" }))).toEqual({
      target: "transcripts",
      olderThanDays: 90,
      keepPerAgent: 0,
    });
  });

  it("omits keepPerAgent entirely for attachments", () => {
    expect(previewRequest(form({ target: "attachments" }))).toEqual({
      target: "attachments",
      olderThanDays: 90,
    });
  });

  it("does not leak a transcripts-invalid keepPerAgent into an attachment preview", () => {
    // The regression: the keep field is hidden for attachments but its state
    // survives the switch. Sending "5.5" along would 400 a request that has no
    // business carrying it.
    for (const stale of ["5.5", "-1", "abc"]) {
      const req = previewRequest(
        form({ target: "attachments", keepPerAgent: stale }),
      );
      expect(req).toEqual({ target: "attachments", olderThanDays: 90 });
      expect(req && "keepPerAgent" in req).toBe(false);
    }
  });

  it("rejects an empty age instead of reading it as 0 days", () => {
    // Number("") is 0, which would be a same-day wipe.
    expect(previewRequest(form({ olderThanDays: "" }))).toBeNull();
    expect(previewRequest(form({ olderThanDays: "   " }))).toBeNull();
  });

  it("rejects an empty keep field instead of reading it as keep-nothing", () => {
    expect(previewRequest(form({ keepPerAgent: "" }))).toBeNull();
  });

  it("rejects ages below the server's floor of 1 day", () => {
    expect(previewRequest(form({ olderThanDays: "0" }))).toBeNull();
    expect(previewRequest(form({ olderThanDays: "-3" }))).toBeNull();
  });

  it("rejects non-integers the server would refuse", () => {
    expect(previewRequest(form({ olderThanDays: "1.5" }))).toBeNull();
    expect(previewRequest(form({ keepPerAgent: "2.5" }))).toBeNull();
    expect(previewRequest(form({ olderThanDays: "abc" }))).toBeNull();
  });
});

describe("applyRequest", () => {
  it("derives the delete from the plan, never from the form", () => {
    // The whole point: the user confirmed THIS plan, so this is what runs.
    expect(
      applyRequest(
        planFor({ policy: { olderThanDays: 365, keepPerAgent: 2 } }),
      ),
    ).toEqual({
      target: "transcripts",
      olderThanDays: 365,
      keepPerAgent: 2,
      apply: true,
    });
  });

  it("always states keepPerAgent on a transcript apply, including 0", () => {
    const req = applyRequest(
      planFor({ policy: { olderThanDays: 30, keepPerAgent: 0 } }),
    );
    expect(req.keepPerAgent).toBe(0);
    expect("keepPerAgent" in req).toBe(true);
  });

  it("omits keepPerAgent on an attachment apply", () => {
    const req = applyRequest(
      planFor({
        target: "attachments",
        policy: { olderThanDays: 60, keepPerAgent: 0 },
      }),
    );
    expect(req).toEqual({
      target: "attachments",
      olderThanDays: 60,
      apply: true,
    });
  });
});

describe("planMatchesForm - the stale-preview backstop", () => {
  it("accepts a plan that still describes the form", () => {
    expect(planMatchesForm(planFor(), form())).toBe(true);
  });

  it("rejects a plan whose target the form moved away from", () => {
    // Repro: preview transcripts, switch to attachments mid-flight, the old
    // response arrives. It must not install itself under the new controls.
    expect(planMatchesForm(planFor(), form({ target: "attachments" }))).toBe(
      false,
    );
  });

  it("rejects a plan whose age the form moved away from", () => {
    expect(planMatchesForm(planFor(), form({ olderThanDays: "1" }))).toBe(
      false,
    );
  });

  it("rejects a plan whose keep count the form moved away from", () => {
    expect(planMatchesForm(planFor(), form({ keepPerAgent: "0" }))).toBe(false);
  });

  it("rejects any plan while the form is invalid", () => {
    expect(planMatchesForm(planFor(), form({ olderThanDays: "" }))).toBe(false);
  });

  it("ignores keepPerAgent for attachments, which the form does not own", () => {
    // The server defaults an unsent keepPerAgent to 0 and echoes it back in the
    // plan's policy; that echo is not a mismatch with a form that never set it.
    const attachmentPlan = planFor({
      target: "attachments",
      policy: { olderThanDays: 90, keepPerAgent: 0 },
    });
    expect(
      planMatchesForm(
        attachmentPlan,
        form({ target: "attachments", keepPerAgent: "5" }),
      ),
    ).toBe(true);
  });
});
