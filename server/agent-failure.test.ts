// nextFailure (task ddf02829): when an agent's failure record is set, kept
// or cleared. The Inbox's Failed item lives exactly as long as this record,
// so a wrong keep is an item that never goes and a wrong clear is a failure
// nobody hears about.
import { describe, expect, it } from "bun:test";
import { nextFailure, type NextFailureInput } from "./agent-failure.ts";
import { en } from "../shared/i18n/en.ts";
import type { AgentFailure, AgentState } from "../shared/types.ts";

const T0 = 1_700_000_000_000;
const boom = {
  content: "Error: boom",
  message: [{ key: "systemEntries.genericError", params: { error: "boom" } }],
  at: T0 + 5,
} as unknown as NonNullable<NextFailureInput["lastError"]>;

function input(over: Partial<NextFailureInput>): NextFailureInput {
  return {
    current: null,
    prevState: "thinking",
    nextState: "error",
    lastError: boom,
    turnMemberIds: ["u1"],
    now: T0 + 10,
    ...over,
  };
}

const earlier: AgentFailure = {
  since: T0,
  content: "Error: old",
  memberIds: ["u9"],
};

describe("nextFailure", () => {
  it("records a failure on a transition into error: now, the turn's error text and its starters", () => {
    for (const prevState of [
      "thinking",
      "tool_executing",
      "waiting_for_response",
      "idle",
    ] as AgentState[]) {
      const got = nextFailure(input({ prevState }));
      expect({ prevState, got }).toEqual({
        prevState,
        got: {
          since: T0 + 10,
          content: boom.content,
          message: boom.message,
          memberIds: ["u1"],
        },
      });
    }
    // An agent-started turn has no starters: the failure goes to the
    // manager alone (ui/inbox-agent-items.ts).
    expect(nextFailure(input({ turnMemberIds: [] }))?.memberIds).toEqual([]);
  });

  it("replaces an earlier failure the agent still carries (a restored agent fails again)", () => {
    const got = nextFailure(input({ current: earlier, prevState: "idle" }));
    expect(got).toEqual({
      since: T0 + 10,
      content: boom.content,
      message: boom.message,
      memberIds: ["u1"],
    });
  });

  it("keeps a copy of the starters, not the live list", () => {
    const starters = ["u1", "u2"];
    const got = nextFailure(input({ turnMemberIds: starters }));
    starters.push("u3");
    expect(got?.memberIds).toEqual(["u1", "u2"]);
  });

  // Not every error transition writes its text first (a restore failure,
  // a failed hand-off): the item still needs a line of its own, never an
  // empty one and never another failure's.
  it("falls back to the 'turn failed' text, in every language, when the turn wrote no error", () => {
    const got = nextFailure(input({ lastError: null }));
    expect(got).not.toBeNull();
    expect(got!.since).toBe(T0 + 10);
    expect(got!.memberIds).toEqual(["u1"]);
    expect(got!.message).toEqual([{ key: "systemEntries.turnFailed" }]);
    expect(got!.content).toBe(en["systemEntries.turnFailed"]);
  });

  it("error to error: a new error entry after the failure starts a new one, none keeps the same object", () => {
    const current = nextFailure(input({}))!;
    // The same entry again (a second updateState("error") of the same turn):
    // unchanged, the same object, so the caller skips broadcast and persist.
    expect(
      nextFailure(input({ current, prevState: "error", now: T0 + 50 })),
    ).toBe(current);
    // No text at all on the second call: still unchanged.
    expect(
      nextFailure(
        input({ current, prevState: "error", lastError: null, now: T0 + 50 }),
      ),
    ).toBe(current);
    // A newer error entry: a new failure, so a dismissed one shows again.
    const later = {
      content: "Error: again",
      message: [
        { key: "systemEntries.genericError", params: { error: "again" } },
      ],
      at: T0 + 40,
    } as unknown as NonNullable<NextFailureInput["lastError"]>;
    expect(
      nextFailure(
        input({ current, prevState: "error", lastError: later, now: T0 + 50 }),
      ),
    ).toEqual({
      since: T0 + 50,
      content: later.content,
      message: later.message,
      memberIds: ["u1"],
    });
  });

  it("clears at a real turn start, and only there", () => {
    for (const nextState of ["thinking", "tool_executing"] as AgentState[]) {
      for (const prevState of [
        "error",
        "idle",
        "waiting_for_response",
      ] as AgentState[]) {
        expect({
          prevState,
          nextState,
          got: nextFailure(
            input({ current: earlier, prevState, nextState, lastError: null }),
          ),
        }).toEqual({ prevState, nextState, got: null });
      }
    }
    // Leaving error without a turn (a flush recovery to
    // waiting_for_response, a stop, a restore that comes back idle) keeps
    // the failure, the same object.
    for (const nextState of [
      "waiting_for_response",
      "idle",
      "stopped",
    ] as AgentState[]) {
      const got = nextFailure(
        input({ current: earlier, prevState: "error", nextState }),
      );
      expect({ nextState, same: got === earlier }).toEqual({
        nextState,
        same: true,
      });
    }
    // No failure and no error: nothing.
    for (const nextState of [
      "thinking",
      "idle",
      "waiting_for_response",
    ] as AgentState[])
      expect(
        nextFailure(input({ prevState: "thinking", nextState })),
      ).toBeNull();
  });
});
