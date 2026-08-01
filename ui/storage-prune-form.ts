// Request-building for the storage panel's prune flow, split out of
// StorageModal.tsx so the part that decides WHAT GETS DELETED is a pure
// function with tests rather than something only a screenshot can check.
//
// The rule this module exists to enforce: a DELETE is derived from the plan the
// user was shown, never from the form controls. The form produces previews; the
// preview produces the delete. Reading the live form at apply time is how you
// end up confirming plan A and deleting policy B - the form can have moved,
// and the confirm dialog quotes numbers from the plan.

import type {
  PrunePlanWire,
  PruneTarget,
  StoragePruneReq,
} from "../shared/contract-shapes.ts";

// The form holds raw input strings, not numbers: an <input type="number"> hands
// back "" for anything it cannot parse, and "" coerces to 0, which is a
// perfectly valid - and destructive - keepPerAgent. Parsing is this module's
// job precisely so that coercion happens in one tested place.
export interface PolicyForm {
  target: PruneTarget;
  olderThanDays: string;
  keepPerAgent: string;
}

// Mirrors the server's MIN_OLDER_THAN_DAYS. A prune that could reach today's
// files is not a retention policy, it is a wipe.
const MIN_OLDER_THAN_DAYS = 1;

function parseInteger(raw: string, min: number): number | null {
  // Number("") === 0 and Number(" ") === 0, both of which would sail through an
  // integer check as a legitimate-looking zero. Reject empty input outright.
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : null;
}

// The dry-run request for the current form, or null when the form is not a
// valid policy yet (which is also what disables the Preview button).
//
// keepPerAgent is OMITTED for attachments rather than sent as a harmless
// extra: the server validates it whenever it is present, so a stale or
// half-typed value left over from the transcripts form (say "5.5", which the
// transcript form itself rejects) would 400 an attachment preview that has no
// business caring about it.
export function previewRequest(form: PolicyForm): StoragePruneReq | null {
  const olderThanDays = parseInteger(form.olderThanDays, MIN_OLDER_THAN_DAYS);
  if (olderThanDays === null) return null;
  if (form.target !== "transcripts") {
    return { target: form.target, olderThanDays };
  }
  const keepPerAgent = parseInteger(form.keepPerAgent, 0);
  if (keepPerAgent === null) return null;
  return { target: form.target, olderThanDays, keepPerAgent };
}

// The delete request for a plan the user has actually seen and confirmed.
// Derived ENTIRELY from that plan - the form is not consulted, so it cannot
// have drifted underneath the confirmation.
//
// keepPerAgent is always sent for transcripts, including 0: the server refuses
// a transcript apply that omits it, on the grounds that "spare nothing on
// recency" is too sharp a setting to inherit silently.
export function applyRequest(plan: PrunePlanWire): StoragePruneReq {
  if (plan.target !== "transcripts") {
    return {
      target: plan.target,
      olderThanDays: plan.policy.olderThanDays,
      apply: true,
    };
  }
  return {
    target: plan.target,
    olderThanDays: plan.policy.olderThanDays,
    keepPerAgent: plan.policy.keepPerAgent,
    apply: true,
  };
}

// True when a plan still describes what the form is asking for. The panel
// throws a plan away on every edit, so this is a backstop for the case an edit
// cannot catch: a preview already in flight when the form changed, whose
// response would otherwise install itself under the new controls.
export function planMatchesForm(
  plan: PrunePlanWire,
  form: PolicyForm,
): boolean {
  const req = previewRequest(form);
  if (!req) return false;
  if (req.target !== plan.target) return false;
  if (req.olderThanDays !== plan.policy.olderThanDays) return false;
  // Attachment plans carry a keepPerAgent the request never set (the server
  // defaults it to 0), so only compare it where the form actually owns it.
  if (
    req.target === "transcripts" &&
    req.keepPerAgent !== plan.policy.keepPerAgent
  )
    return false;
  return true;
}
