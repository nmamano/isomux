// Where an edited user message sits in the backend's history. Shared by the
// agent edit path (agent-manager editMessage) and the cron run edit path
// (cronjob-manager editRunMessage).
//
// The log and the backend are matched by text plus occurrence index: the
// Nth log user message with a given text is the Nth backend user message with
// that text. Callers pass both sides already normalized (sender prefix, sdkText
// and envelope stripping), and pass only the log user messages that belong to
// the backend session and its fork ancestry - an entry from an earlier
// conversation that is still on screen must not count.

import type { LogEntry } from "../shared/types.ts";
import { formatPrefix } from "../shared/identity.ts";

// The text a log user message was sent to the backend with: the sender
// prefix plus `metadata.sdkText` (the expanded prompt of a skill slash
// command) or else the content.
export function editLogUserText(entry: LogEntry): string {
  const username = entry.metadata?.username as string | undefined;
  const device = entry.metadata?.device as string | undefined;
  const sdkText =
    (entry.metadata?.sdkText as string | undefined) ?? entry.content;
  return `${formatPrefix({ username, device })}${sdkText}`;
}

export interface EditLogUser {
  id: string;
  text: string;
}

export interface EditBackendUser {
  // Index into the caller's backend message list.
  index: number;
  text: string;
}

export type EditTargetLocation =
  // The backend holds the target at this index of the backend message list.
  | { kind: "found"; index: number }
  // The target is the latest user message and the backend never recorded it:
  // Stop landed before the backend got it (isomux's pre-send window) or
  // before the backend wrote it (Codex turn setup). The edit keeps the whole
  // backend history and sends the edited text.
  | { kind: "not_sent" }
  // Anything else, including every case this module cannot prove.
  | { kind: "missing" };

function nthMatch(
  backendUsers: readonly EditBackendUser[],
  text: string,
  occurrence: number,
): number {
  let seen = 0;
  for (let i = 0; i < backendUsers.length; i++) {
    if (backendUsers[i].text !== text) continue;
    if (seen === occurrence) return i;
    seen++;
  }
  return -1;
}

function occurrenceBefore(
  logUsers: readonly EditLogUser[],
  position: number,
): number {
  let count = 0;
  for (let j = 0; j < position; j++) {
    if (logUsers[j].text === logUsers[position].text) count++;
  }
  return count;
}

export function locateEditTarget(
  backendUsers: readonly EditBackendUser[],
  logUsers: readonly EditLogUser[],
  targetId: string,
): EditTargetLocation {
  const t = logUsers.findIndex((u) => u.id === targetId);
  if (t === -1) return { kind: "missing" };

  const pos = nthMatch(backendUsers, logUsers[t].text, occurrenceBefore(logUsers, t));
  if (pos !== -1) return { kind: "found", index: backendUsers[pos].index };

  // Only the latest message can be missing for the benign reason: a later
  // message would have run a turn that the backend recorded.
  if (t !== logUsers.length - 1) return { kind: "missing" };

  // The backend must end at the predecessor: no user text after it. Empty
  // user messages are tool results (Claude). Any other text after the
  // predecessor could be the target under a text the normalization missed,
  // and keeping it would leave the old message in the model's context.
  let after = 0;
  if (t > 0) {
    const pred = nthMatch(
      backendUsers,
      logUsers[t - 1].text,
      occurrenceBefore(logUsers, t - 1),
    );
    if (pred === -1) return { kind: "missing" };
    after = pred + 1;
  }
  for (let i = after; i < backendUsers.length; i++) {
    if (backendUsers[i].text.trim() !== "") return { kind: "missing" };
  }
  return { kind: "not_sent" };
}
