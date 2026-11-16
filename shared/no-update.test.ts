// The reply that means "nothing for the members" (task 51c187f4). The chat
// folds an entry this accepts and draws every other text as a card, so a
// false positive hides a real reply and a false negative shows the keyword.

import { describe, expect, it } from "bun:test";
import type { LogEntry } from "./types.ts";
import { isNoUpdateReply, NO_UPDATE } from "./no-update.ts";

const text = (content: string): Pick<LogEntry, "kind" | "content"> => ({
  kind: "text",
  content,
});
// The phrase agents were told to reply with before the keyword.
const LEGACY = "(nothing to bring to the members' attention)";

describe("isNoUpdateReply", () => {
  it("accepts the keyword alone, in the forms agents write it", () => {
    const forms = [
      NO_UPDATE,
      `  ${NO_UPDATE}\n`,
      `\n\n${NO_UPDATE}\n\n`,
      `*${NO_UPDATE}*`,
      `**${NO_UPDATE}**`,
      `_${NO_UPDATE}_`,
      `\`${NO_UPDATE}\``,
      `${NO_UPDATE}.`,
      `\`${NO_UPDATE}\`.`,
      NO_UPDATE.replaceAll("_", "\\_"),
    ];
    for (const content of forms)
      expect({ content, folds: isNoUpdateReply(text(content)) }).toEqual({
        content,
        folds: true,
      });
  });

  it("accepts the phrase of older logs, straight or curly apostrophe, with or without emphasis", () => {
    const forms = [
      LEGACY,
      `_${LEGACY}_`,
      `*${LEGACY}*`,
      ` _${LEGACY}_ \n`,
      `${LEGACY}.`,
      LEGACY.replace("'", "’"),
      `_${LEGACY.replace("'", "’")}_`,
    ];
    for (const content of forms)
      expect({ content, folds: isNoUpdateReply(text(content)) }).toEqual({
        content,
        folds: true,
      });
  });

  it("refuses a reply that says anything else", () => {
    const forms = [
      "",
      "   ",
      "Done.",
      `Replied to the worker.\n\n${NO_UPDATE}`,
      `${NO_UPDATE}\n\nOne more thing: the build is red.`,
      `The agent answers ${NO_UPDATE} when nothing changed.`,
      `${NO_UPDATE} ${NO_UPDATE}`,
      `${NO_UPDATE}..`,
      `NO UPDATE`,
      `no_update`,
      `Approved and handed back.\n\n_${LEGACY}_`,
      `_${LEGACY}_ The task is done.`,
      "(nothing to bring)",
    ];
    for (const content of forms)
      expect({ content, folds: isNoUpdateReply(text(content)) }).toEqual({
        content,
        folds: false,
      });
  });

  it("only a text entry is a reply", () => {
    const kinds: LogEntry["kind"][] = [
      "user_message",
      "thinking",
      "system",
      "error",
      "tool_result",
      "tool_call",
    ];
    for (const kind of kinds) {
      for (const content of [NO_UPDATE, `_${LEGACY}_`])
        expect({
          kind,
          content,
          folds: isNoUpdateReply({ kind, content }),
        }).toEqual({ kind, content, folds: false });
    }
  });
});
