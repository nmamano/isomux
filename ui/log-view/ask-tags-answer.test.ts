// What the chat shows for a member message that answers an ask (task
// 1466ea8b): a rewrite request with the member's words, and a postpone. The
// translator here returns its key and values, so the tests read which label
// a message gets and what it carries, not the catalog's words.
import { describe, expect, it } from "bun:test";
import { askAnswerText, askRefOf } from "./ask-link.tsx";
import {
  ASK_POSTPONED_TEXT,
  ASK_SIMPLIFY_TEXT,
  type AskRef,
  type LogEntry,
} from "../../shared/types.ts";

const t = ((key: string, vars?: Record<string, unknown>) =>
  `${key}${vars ? ` ${JSON.stringify(vars)}` : ""}`) as Parameters<
  typeof askAnswerText
>[0];
const ref = (fields: Partial<AskRef>): AskRef => ({
  id: "abcd1234",
  prompt: "Ship it?",
  ...fields,
});

describe("a rewrite request", () => {
  it("shows the simplify label for the fixed words, and the member's words under another label", () => {
    const bare = askAnswerText(t, ref({ simplify: true }), ASK_SIMPLIFY_TEXT);
    expect(bare).toBe(t("asks.simplifyRequested"));
    const worded = askAnswerText(t, ref({ simplify: true }), "More context");
    expect(worded).toContain("More context");
    expect(worded).not.toBe(bare);
    // Not shown as a plain reply.
    expect(worded).not.toBe("More context");
  });
});

describe("a postpone", () => {
  it("shows its own label, not the fixed words, a reply or a dismiss; a note goes with it", () => {
    const bare = askAnswerText(t, ref({ postponed: true }), ASK_POSTPONED_TEXT);
    expect(bare).not.toContain(ASK_POSTPONED_TEXT);
    for (const other of [
      askAnswerText(t, ref({ dismissed: true }), "Dismissed"),
      t("asks.dismissed"),
    ])
      expect(bare).not.toBe(other);
    const noted = askAnswerText(
      t,
      ref({ postponed: true }),
      "Circle back at: Monday",
    );
    expect(noted).toContain("Circle back at: Monday");
    expect(noted).not.toBe("Circle back at: Monday");
    expect(noted).not.toBe(
      askAnswerText(t, ref({ dismissed: true }), "Circle back at: Monday"),
    );
    // Its label key differs from the bare one's.
    expect(noted.split(" ")[0]).not.toBe(bare.split(" ")[0]);
  });

  it("is read back from the message's metadata", () => {
    const entry = {
      id: "e1",
      kind: "user_message",
      content: ASK_POSTPONED_TEXT,
      metadata: {
        ask: { id: "abcd1234", prompt: "Ship it?", postponed: true },
      },
    } as unknown as LogEntry;
    expect(askRefOf(entry)?.postponed).toBe(true);
  });
});
