// The stop-notice slot (ManagedAgent.stopNotice) for agent-initiated aborts.
// An arm goes in before its abort runs and settles when the abort answers.
// Each arm is a fresh object, so runAgentTurn can tell the arm it sent from a
// later one. `backing` links the arms an arm replaced; after every failure the
// chain keeps only live arms (pending, or the one confirmed stop not yet
// explained), so its length is bounded by the aborts still in flight.

import type { StopNoticeArm } from "./internal-types.ts";

type SlotHolder = { stopNotice: StopNoticeArm | null };

export function pushStopArm(holder: SlotHolder, text: string): StopNoticeArm {
  const arm: StopNoticeArm = {
    text,
    state: "pending",
    backing: holder.stopNotice,
  };
  holder.stopNotice = arm;
  return arm;
}

export function settleStopArm(
  holder: SlotHolder,
  arm: StopNoticeArm,
  stopped: boolean,
): void {
  if (stopped) {
    arm.state = "confirmed";
    // A confirmed arm stands on its own; nothing behind it is needed.
    arm.backing = null;
    return;
  }
  arm.state = "failed";
  const head = holder.stopNotice;
  if (!head) return;
  // Unlink every failed arm behind the head. The head itself stays even when
  // it failed, as long as a live arm is behind it: a send in progress may hold
  // it, and swapping the object would make that send's consumption miss.
  for (let node: StopNoticeArm | null = head; node; node = node.backing) {
    let next: StopNoticeArm | null = node.backing;
    while (next && next.state === "failed") next = next.backing;
    node.backing = next;
  }
  if (head.state === "failed" && !head.backing) holder.stopNotice = null;
}
