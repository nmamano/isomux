// failureCheckId reads back the check a described failure names (task
// caa5ca07): the owner's page turns a known check into plain words.
// Properties:
// - it inverts describeFailure for every id, with and without a path, and
//   whatever the detail says (another id in the detail does not count);
// - it names a check only when the reason STARTS with a known id followed by
//   describeFailure's own separator: an id inside the text, an unknown id of
//   the same shape, a longer word that starts with an id, or a bare id give
//   null.
import { expect, it } from "bun:test";
import {
  CHECK_IDS,
  describeFailure,
  failureCheckId,
  type CheckId,
} from "./trusted-checks.ts";

it("reads back the check of every described failure, with and without a path", () => {
  const read: Record<string, CheckId | null> = {};
  const want: Record<string, CheckId> = {};
  for (const check of CHECK_IDS) {
    // The detail names another check, as a raw error text may.
    const other = CHECK_IDS.find((id) => id !== check)!;
    for (const path of [undefined, "/home/office/isomux/state", "/a b/c: d"]) {
      const reason = describeFailure({
        check,
        ...(path === undefined ? {} : { path }),
        detail: `${other}: the agent user can write it`,
      });
      read[reason] = failureCheckId(reason);
      want[reason] = check;
    }
  }
  expect(read).toEqual(want);
});

it("names no check when the reason does not start with a known id and its separator", () => {
  const reasons = [
    "",
    "cannot reach the runner: connect ECONNREFUSED",
    "the trusted checks failed: private-agent-write at /x: boom",
    // An id inside the text, after the first reason's start.
    "the runner said private-owner at /x: wrong owner",
    // Same shape as a check id, but not one.
    "runtime-install: no space left on device",
    "foo-bar at /x: y",
    // Longer words that start with a known id.
    "private-ownerx at /x: y",
    "missing-file: /x",
    "agent-user2: y",
    // A known id with no separator after it.
    "private-owner",
    "missing files under /x",
    "agent-not-root",
    // Not at the start.
    " private-owner at /x: y",
  ];
  const read = Object.fromEntries(reasons.map((r) => [r, failureCheckId(r)]));
  expect(read).toEqual(Object.fromEntries(reasons.map((r) => [r, null])));
});
