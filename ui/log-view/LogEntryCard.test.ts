// Who a `user_message` came from, and whether the reader should treat it as a
// person. Several senders reach an agent through one queue and land in one
// log - a member, another agent, one of the agent's own apps, a schedule, a
// webhook, a script with the member's API token - and the log is what anyone
// reads AFTERWARDS, so the distinction has to survive the trip.

import { describe, it, expect } from "bun:test";
import type { LogEntry } from "../../shared/types.ts";
import {
  chatCopyText,
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

describe("chatCopyText", () => {
  // Two turns, the second started by another agent. Each kind the chat bar's
  // Copy can meet: thinking, tool calls and results, an error, and a send the
  // server records but the chat does not show.
  const log: LogEntry[] = [
    entry("user_message", String.raw`First ask, \$5`),
    entry("thinking", "THINKING-1"),
    { ...entry("tool_call", "Bash"), metadata: { input: "echo one" } },
    entry("tool_result", "RESULT-1"),
    entry("text", String.raw`First reply, \$5`),
    {
      ...entry("user_message", "Second ask"),
      metadata: { sender_agent_name: "Peer", sender_agent_room: "Room" },
    },
    { ...entry("tool_call", "Read"), metadata: { input: { path: "/x" } } },
    entry("tool_result", "RESULT-2"),
    entry("agent_outbound", "OUTBOUND-2"),
    entry("error", "ERROR-2"),
    entry("text", "Second reply"),
  ];
  const second = log.findIndex((e) => e.content === "Second ask");

  it("Everything is what the button copied before the menu", () => {
    expect(chatCopyText(EN, log, "everything")).toBe(serializeEntries(EN, log));
  });

  it("Messages only keeps each message and reply, in order, and nothing else", () => {
    expect(chatCopyText(EN, log, "messages")).toBe(
      [
        String.raw`First ask, \$5`,
        "First reply, $5",
        "Second ask",
        "Second reply",
      ].join("\n\n"),
    );
  });

  it("Last exchange starts at the last incoming message, whoever sent it", () => {
    // The last message is from an agent, not a member: a member-only rule
    // would reach back to the first turn.
    expect(chatCopyText(EN, log, "lastExchange")).toBe(
      serializeEntries(EN, log.slice(second)),
    );
  });

  it("Last exchange is the message alone while the agent has not answered", () => {
    const waiting = [...log, entry("user_message", "Third ask")];
    expect(chatCopyText(EN, waiting, "lastExchange")).toBe("Third ask");
  });

  it("Last exchange is the whole log when no message started it", () => {
    const noMessage = log.filter((e) => e.kind !== "user_message");
    expect(noMessage.length).toBeGreaterThan(0);
    expect(chatCopyText(EN, noMessage, "lastExchange")).toBe(
      serializeEntries(EN, noMessage),
    );
  });
});

describe("describeMessageSender", () => {
  // Each row: the metadata the server stamps, the label, the device the
  // header shows apart from the label (task 0a911d08: the name is in caps, the
  // device keeps its case), and whether the card treats it as a person (solid
  // band, editable). A non-human sender must win over a username stamped
  // alongside it: the app's owner or the job's creator is not the sender.
  const cases: Array<
    [
      string,
      Record<string, unknown> | undefined,
      string | undefined,
      string | undefined,
      boolean,
    ]
  > = [
    ["a member", { username: "Nil", device: "Phone" }, "Nil", "Phone", true],
    ["a member without a device", { username: "Nil" }, "Nil", undefined, true],
    // The card falls back to "You", and a device alone names nobody.
    ["no metadata", undefined, undefined, undefined, true],
    [
      "a device without a username",
      { device: "Windows" },
      undefined,
      undefined,
      true,
    ],
    [
      "an agent",
      { sender_agent_name: "Isomuxer3", sender_agent_room: "Isomux Dev" },
      EN.t("common.sender.agentInRoom", {
        name: "Isomuxer3",
        room: "Isomux Dev",
      }),
      undefined,
      false,
    ],
    [
      "an app, with its owner's username",
      { sender_app_name: "habits", username: "Nil" },
      EN.t("common.sender.app", { name: "habits" }),
      undefined,
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
      undefined,
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
      undefined,
      false,
    ],
    // The token is the member's authority, so the label stays theirs, but the
    // message came from a script and reads that way (dashed, not editable).
    [
      "an API token",
      { username: "Nil", device: 'API token "test" (pat-123)' },
      "Nil",
      'API token "test" (pat-123)',
      false,
    ],
  ];

  it.each(cases)("%s", (_name, metadata, label, device, fromHuman) => {
    // toEqual: a device left out and a device set to undefined are the same.
    expect(describeMessageSender(EN, metadata)).toEqual({
      label,
      device,
      fromHuman,
    });
    // The edit affordance reads the same answer.
    expect(senderIsHuman(metadata)).toBe(fromHuman);
  });
});
