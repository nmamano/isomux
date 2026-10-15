import { describe, expect, it } from "bun:test";
import type { LogEntry } from "../shared/types.ts";
import {
  editLogUserText,
  locateEditTarget,
  type EditBackendUser,
  type EditLogUser,
} from "./edit-target.ts";

// Backend user messages at consecutive message indexes; assistant messages
// sit between them in a real list, which the index gap models.
function backend(...texts: string[]): EditBackendUser[] {
  return texts.map((text, i) => ({ index: i * 2, text }));
}

function log(...texts: string[]): EditLogUser[] {
  return texts.map((text, i) => ({ id: `e${i}`, text }));
}

describe("locateEditTarget", () => {
  it("finds the target by text and occurrence", () => {
    const users = log("a", "b", "a");
    expect(locateEditTarget(backend("a", "b", "a"), users, "e2")).toEqual({
      kind: "found",
      index: 4,
    });
    expect(locateEditTarget(backend("a", "b", "a"), users, "e0")).toEqual({
      kind: "found",
      index: 0,
    });
  });

  it("classifies the latest message as not sent when the backend ends at its predecessor", () => {
    expect(
      locateEditTarget(backend("a", "b"), log("a", "b", "c"), "e2"),
    ).toEqual({ kind: "not_sent" });
    // Empty user messages (Claude tool results) after the predecessor are
    // not user text.
    expect(
      locateEditTarget(backend("a", "b", "", " "), log("a", "b", "c"), "e2"),
    ).toEqual({ kind: "not_sent" });
  });

  it("uses the predecessor's occurrence, not only its text", () => {
    // Log: a, b, a, c(target). The predecessor is the SECOND "a". A backend
    // that holds only the first "a" and then "b" has not reached it.
    const users = log("a", "b", "a", "c");
    expect(locateEditTarget(backend("a", "b"), users, "e3")).toEqual({
      kind: "missing",
    });
    expect(locateEditTarget(backend("a", "b", "a"), users, "e3")).toEqual({
      kind: "not_sent",
    });
  });

  it("treats a repeated last text as not sent when only the earlier copy is recorded", () => {
    const users = log("go", "go");
    expect(locateEditTarget(backend("go"), users, "e1")).toEqual({
      kind: "not_sent",
    });
  });

  it("refuses when user text follows the predecessor", () => {
    // The target may be in the backend under a text the normalization missed.
    expect(
      locateEditTarget(backend("a", "c (wrapped)"), log("a", "c"), "e1"),
    ).toEqual({ kind: "missing" });
  });

  it("refuses a target that is not the latest message", () => {
    expect(
      locateEditTarget(backend("a", "c"), log("a", "b", "c"), "e1"),
    ).toEqual({ kind: "missing" });
  });

  it("refuses when the predecessor itself is not in the backend", () => {
    expect(locateEditTarget(backend("x"), log("a", "b"), "e1")).toEqual({
      kind: "missing",
    });
  });

  it("refuses a target outside the session's log users", () => {
    // An entry from an earlier conversation still on screen is not passed in.
    expect(locateEditTarget(backend(), log("a"), "old-entry")).toEqual({
      kind: "missing",
    });
  });

  it("handles a first message with empty and non-empty backend history", () => {
    expect(locateEditTarget(backend(), log("a"), "e0")).toEqual({
      kind: "not_sent",
    });
    expect(locateEditTarget(backend(""), log("a"), "e0")).toEqual({
      kind: "not_sent",
    });
    expect(locateEditTarget(backend("other"), log("a"), "e0")).toEqual({
      kind: "missing",
    });
  });
});

describe("a native Claude Code command in the history", () => {
  // Claude Code records a command it expands as this tagged text, with the
  // skill body and tool results as further user messages (measured with
  // SDK 0.3.293, 2026-10-15). Isomux sent "/simplify foo.ts" with no member
  // prefix, so the log text never matches: an edit of the command fails
  // closed, and the messages around it still match.
  const recorded =
    "<command-message>simplify</command-message>\n<command-name>/simplify</command-name>\n<command-args>foo.ts</command-args>";
  const entry = (id: string, content: string): LogEntry => ({
    id,
    agentId: "a",
    timestamp: 0,
    kind: "user_message",
    content,
    metadata: { username: "Nil" },
  });
  const users = [
    entry("e0", "before"),
    entry("e1", "/simplify foo.ts"),
    entry("e2", "after"),
  ].map((e) => ({ id: e.id, text: editLogUserText(e) }));
  const history = backend("[Nil] before", recorded, "", "[Nil] after");

  it("does not locate the command itself, even as the latest message", () => {
    expect(locateEditTarget(history, users, "e1")).toEqual({
      kind: "missing",
    });
    expect(
      locateEditTarget(history.slice(0, 3), users.slice(0, 2), "e1"),
    ).toEqual({ kind: "missing" });
  });

  it("still locates the messages before and after it", () => {
    expect(locateEditTarget(history, users, "e0")).toEqual({
      kind: "found",
      index: 0,
    });
    expect(locateEditTarget(history, users, "e2")).toEqual({
      kind: "found",
      index: 6,
    });
  });
});
