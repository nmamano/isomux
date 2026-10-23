// Who a `user_message` came from, and whether the reader should treat it as a
// person. Several senders reach an agent through one queue and land in one
// log - a member, another agent, one of the agent's own apps, a schedule, a
// webhook, a script with the member's API token - and the log is what anyone
// reads AFTERWARDS, so the distinction has to survive the trip.

import { describe, it, expect } from "bun:test";
import type { LogEntry } from "../../shared/types.ts";
import {
  describeMessageSender,
  senderIsHuman,
  serializeEntries,
} from "./LogEntryCard.tsx";
import { translatorFor } from "../../shared/i18n/translate.ts";

const EN = translatorFor("en");

function entry(kind: LogEntry["kind"], content: string): LogEntry {
  return { id: content, agentId: "agent-1", timestamp: 1, kind, content };
}

describe("serializeEntries", () => {
  it("drops the dollar escape from agent replies only", () => {
    // A reply renders as markdown, so its \$ shows as "$". A message and a
    // tool input render as typed, so their \$ is what the reader sees.
    expect(
      serializeEntries(EN, [
        entry("user_message", String.raw`Budget \$5?`),
        entry("text", String.raw`It costs \$5, see ` + "`echo \\$HOME`"),
        {
          ...entry("tool_call", "Bash"),
          metadata: { input: String.raw`echo \$HOME` },
        },
      ]),
    ).toBe(
      String.raw`Budget \$5?` +
        "\n\n" +
        "It costs $5, see `echo \\$HOME`" +
        "\n\n**Bash**\n" +
        String.raw`echo \$HOME`,
    );
  });
});

describe("describeMessageSender", () => {
  // Each row: the metadata the server stamps, the label, and whether the card
  // treats it as a person (solid band, editable). A non-human sender must win
  // over a username stamped alongside it: the app's owner or the job's creator
  // is not the sender.
  const cases: Array<
    [string, Record<string, unknown> | undefined, string | undefined, boolean]
  > = [
    ["a member", { username: "Nil", device: "Phone" }, "Nil (Phone)", true],
    // The card falls back to "You".
    ["no metadata", undefined, undefined, true],
    [
      "an agent",
      { sender_agent_name: "Isomuxer3", sender_agent_room: "Isomux Dev" },
      EN.t("common.sender.agentInRoom", {
        name: "Isomuxer3",
        room: "Isomux Dev",
      }),
      false,
    ],
    [
      "an app, with its owner's username",
      { sender_app_name: "habits", username: "Nil" },
      EN.t("common.sender.app", { name: "habits" }),
      false,
    ],
    [
      "a schedule, with its creator's username",
      {
        sender_cronjob_id: "08366d7d",
        sender_cronjob_name: "Business health check",
        username: "Nil",
      },
      EN.t("common.sender.cronjob", { name: "Business health check" }),
      false,
    ],
    [
      "a webhook",
      {
        sender_webhook_id: "wh_3f9a0c1d2e4b5a69",
        sender_webhook_name: "pr-review",
        username: "Nil",
      },
      EN.t("common.sender.webhook", { name: "pr-review" }),
      false,
    ],
    // The token is the member's authority, so the label stays theirs, but the
    // message came from a script and reads that way (dashed, not editable).
    [
      "an API token",
      { username: "Nil", device: 'API token "test" (pat-123)' },
      'Nil (API token "test" (pat-123))',
      false,
    ],
  ];

  it.each(cases)("%s", (_name, metadata, label, fromHuman) => {
    expect(describeMessageSender(EN, metadata)).toEqual({ label, fromHuman });
    // The edit affordance reads the same answer.
    expect(senderIsHuman(metadata)).toBe(fromHuman);
  });
});
