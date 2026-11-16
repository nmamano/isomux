import { describe, expect, it } from "bun:test";
import type { LogEntry } from "../../shared/types.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import {
  pinnedHumanMessageId,
  pinnedMessageSenderLabel,
  type VerticalRect,
} from "./pinned-message.ts";

function message(id: string, metadata?: Record<string, unknown>): LogEntry {
  return {
    id,
    agentId: "agent-1",
    timestamp: 1,
    kind: "user_message",
    content: id,
    metadata,
  };
}

const above: VerticalRect = { top: -30, bottom: -10 };
const viewport: VerticalRect = { top: 0, bottom: 500 };

describe("pinnedHumanMessageId", () => {
  it("skips newer agent messages and pins the older human message", () => {
    const logs = [
      message("human", { username: "Nil" }),
      message("agent-1", { sender_agent_name: "Worker 1" }),
      message("agent-2", { sender_agent_name: "Worker 2" }),
    ];
    expect(pinnedHumanMessageId(logs, () => above, viewport)).toBe("human");
  });

  it("returns null without crashing when no human message exists", () => {
    const logs = [
      message("agent", { sender_agent_name: "Worker" }),
      message("app", { sender_app_name: "watcher" }),
    ];
    expect(pinnedHumanMessageId(logs, () => above, viewport)).toBeNull();
  });

  it("does not pin a message sent through a personal API token", () => {
    const logs = [
      message("token", {
        username: "Nil",
        device: 'API token "phone" (pat-1)',
      }),
    ];
    expect(pinnedHumanMessageId(logs, () => above, viewport)).toBeNull();
  });
});

// Task b364e680: the bar named every pinned message "You", so another
// member's message read as the viewer's own.
describe("pinnedMessageSenderLabel", () => {
  const EN = translatorFor("en");
  const you = EN.t("common.you");

  it("names another member by the name the chat card shows, without the device", () => {
    expect(
      pinnedMessageSenderLabel(
        EN,
        { username: "Yu", device: "Windows" },
        "Nil",
      ),
    ).toBe("Yu");
  });

  it("says You for the viewer's own message, in any case and spacing", () => {
    expect(pinnedMessageSenderLabel(EN, { username: "Nil" }, "Nil")).toBe(you);
    expect(pinnedMessageSenderLabel(EN, { username: " nil " }, "NIL")).toBe(
      you,
    );
  });

  it("says You for a message with no name, as the chat card does", () => {
    expect(pinnedMessageSenderLabel(EN, {}, "Nil")).toBe(you);
    expect(pinnedMessageSenderLabel(EN, undefined, "Nil")).toBe(you);
  });

  it("names the sender when the viewer has no name", () => {
    expect(pinnedMessageSenderLabel(EN, { username: "Yu" }, null)).toBe("Yu");
    expect(pinnedMessageSenderLabel(EN, { username: "Yu" }, "")).toBe("Yu");
  });
});
