// Who a `user_message` came from, and whether the reader should treat it as a
// person. Several senders reach an agent through one queue and land in one
// log - a member, another agent, one of the agent's own apps, a schedule, a
// webhook, a script with the member's API token - and the log is what anyone
// reads AFTERWARDS, so the distinction has to survive the trip.

import { describe, it, expect } from "bun:test";
import { Marked } from "marked";
import type { LogEntry } from "../../shared/types.ts";
import {
  chatCopyText,
  describeMessageSender,
  senderIsHuman,
  serializeEntries,
} from "./LogEntryCard.tsx";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { formatApiTokenDevice } from "../../shared/identity.ts";

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
  // Each copied run of one speaker's entries opens with who said it (task
  // 28bd5993): the name the chat header shows for a message, the agent's
  // name for its replies and tool calls. In Markdown the name is bold on a
  // line of its own and a blank line follows; in Plain text the content
  // starts on the next line.
  const BOT = "Bot";
  const md = { agentName: BOT, format: "markdown" } as const;
  const plain = { agentName: BOT, format: "plain" } as const;
  const mdLabel = (name: string) => `**${name}:**`;
  const YOU = EN.t("common.you");
  const PEER = EN.t("common.sender.agent", { name: "Peer" });
  const READ_INPUT = JSON.stringify({ path: "/x" }, null, 2);

  // Two turns, the second started by another agent. Each kind the chat bar's
  // Copy can meet: thinking, tool calls and results, an error, and a send the
  // server records but the chat does not show. The member's message has
  // Markdown characters the chat shows as typed; the first reply has
  // Markdown the chat renders.
  const log: LogEntry[] = [
    entry("user_message", String.raw`First ask, \$5 **as typed**`),
    entry("thinking", "THINKING-1"),
    { ...entry("tool_call", "Bash"), metadata: { input: "echo one" } },
    entry("tool_result", "RESULT-1"),
    entry("text", String.raw`First reply, \$5 **bold**`),
    {
      ...entry("user_message", "Second ask"),
      metadata: { sender_agent_name: "Peer" },
    },
    { ...entry("tool_call", "Read"), metadata: { input: { path: "/x" } } },
    entry("tool_result", "RESULT-2"),
    entry("agent_outbound", "OUTBOUND-2"),
    entry("error", "ERROR-2"),
    entry("text", "Second reply"),
  ];
  const second = log.findIndex((e) => e.content === "Second ask");

  it("Everything names the speaker once per run, in Markdown", () => {
    // Entries the copy leaves out (thinking, results, the error) neither
    // break a run nor start one.
    expect(chatCopyText(EN, log, "everything", md)).toBe(
      [
        mdLabel(YOU),
        String.raw`First ask, \$5 **as typed**`,
        mdLabel(BOT),
        "**Bash**\necho one",
        "First reply, $5 **bold**",
        mdLabel(PEER),
        "Second ask",
        mdLabel(BOT),
        `**Read**\n${READ_INPUT}`,
        "Second reply",
      ].join("\n\n"),
    );
  });

  it("Everything in Plain text strips the agent's Markdown and keeps a message as typed", () => {
    expect(chatCopyText(EN, log, "everything", plain)).toBe(
      [
        `${YOU}:\n` + String.raw`First ask, \$5 **as typed**`,
        `${BOT}:\nBash\necho one`,
        "First reply, $5 bold",
        `${PEER}:\nSecond ask`,
        `${BOT}:\nRead\n${READ_INPUT}`,
        "Second reply",
      ].join("\n\n"),
    );
  });

  it("Messages only keeps each message and reply, in order, and nothing else", () => {
    expect(chatCopyText(EN, log, "messages", md)).toBe(
      [
        mdLabel(YOU),
        String.raw`First ask, \$5 **as typed**`,
        mdLabel(BOT),
        "First reply, $5 **bold**",
        mdLabel(PEER),
        "Second ask",
        mdLabel(BOT),
        "Second reply",
      ].join("\n\n"),
    );
  });

  it("Last exchange starts at the last incoming message, whoever sent it", () => {
    // The last message is from an agent, not a member: a member-only rule
    // would reach back to the first turn.
    expect(second).toBeGreaterThan(0);
    expect(chatCopyText(EN, log, "lastExchange", md)).toBe(
      [
        mdLabel(PEER),
        "Second ask",
        mdLabel(BOT),
        `**Read**\n${READ_INPUT}`,
        "Second reply",
      ].join("\n\n"),
    );
  });

  it("Last exchange is the message alone while the agent has not answered", () => {
    const waiting = [...log, entry("user_message", "Third ask")];
    expect(chatCopyText(EN, waiting, "lastExchange", md)).toBe(
      `${mdLabel(YOU)}\n\nThird ask`,
    );
  });

  it("Last exchange is the whole log when no message started it", () => {
    // Nobody else speaks between the two turns, so one label covers both.
    const noMessage = log.filter((e) => e.kind !== "user_message");
    expect(chatCopyText(EN, noMessage, "lastExchange", md)).toBe(
      [
        mdLabel(BOT),
        "**Bash**\necho one",
        "First reply, $5 **bold**",
        `**Read**\n${READ_INPUT}`,
        "Second reply",
      ].join("\n\n"),
    );
  });

  it("names each kind of sender as the chat header does, without the device", () => {
    const from = (content: string, metadata?: LogEntry["metadata"]) => ({
      ...entry("user_message", content),
      metadata,
    });
    const senders: LogEntry[] = [
      from("m1", { username: "Nil", device: "Phone" }),
      from("m2", { username: "Nil" }),
      from("m3", { sender_agent_name: "Peer", sender_agent_room: "Lab" }),
      from("m4", { sender_agent_name: "Peer" }),
      from("m5", { sender_app_name: "Loop" }),
      from("m6", { sender_cronjob_name: "Nightly" }),
      from("m7", { sender_webhook_name: "Hook" }),
      from("m8", { username: "Ana" }),
      from("m9"),
      entry("text", "r1"),
    ];
    expect(chatCopyText(EN, senders, "messages", plain)).toBe(
      [
        // One sender on two devices is one run.
        "Nil:\nm1",
        "m2",
        `${EN.t("common.sender.agentInRoom", { name: "Peer", room: "Lab" })}:\nm3`,
        `${PEER}:\nm4`,
        `${EN.t("common.sender.app", { name: "Loop" })}:\nm5`,
        `${EN.t("common.sender.cronjob", { name: "Nightly" })}:\nm6`,
        `${EN.t("common.sender.webhook", { name: "Hook" })}:\nm7`,
        "Ana:\nm8",
        `${YOU}:\nm9`,
        `${BOT}:\nr1`,
      ].join("\n\n"),
    );
  });

  it("keeps a name's punctuation and the reply's own Markdown when the copy is rendered", () => {
    // A list that does not start at 1 cannot interrupt a paragraph, so it
    // survives only when a blank line parts it from the name.
    const name = "my_bot*[x]";
    const reply = [entry("text", "2. second\n3. third")];
    const html = new Marked({ gfm: true, breaks: true }).parse(
      chatCopyText(EN, reply, "messages", {
        agentName: name,
        format: "markdown",
      }),
    ) as string;
    expect(html).toContain(`<strong>${name}:</strong>`);
    expect(html).toContain('<ol start="2">');
    expect(
      chatCopyText(EN, reply, "messages", { agentName: name, format: "plain" }),
    ).toBe(`${name}:\n2. second\n3. third`);
  });

  // Task 30cd9913. Each send that is not the viewer typing carries the
  // viewer's name too, so the name alone cannot tell them apart.
  const sent = (content: string, metadata?: LogEntry["metadata"]) => ({
    ...entry("user_message", content),
    metadata,
  });
  const mixed: LogEntry[] = [
    sent(String.raw`Mine A, \$5`, { username: "Nil" }),
    { ...entry("tool_call", "Bash"), metadata: { input: "echo one" } },
    entry("tool_result", "RESULT-1"),
    entry("text", "Reply A"),
    sent("Other member", { username: "Ana" }),
    sent("Agent send", {
      username: "Nil",
      sender_agent_name: "Peer",
      sender_agent_room: "Room",
    }),
    sent("Token send", {
      username: "Nil",
      device: formatApiTokenDevice("ci", "pat-1"),
    }),
    sent("No name"),
    sent("Mine B", { username: "nil", device: "Phone" }),
    entry("text", "Reply B"),
  ];

  it("My messages keeps what the viewer typed, in order, and nothing else", () => {
    // The name matches whatever its case or surrounding spaces. The label is
    // the name each message was sent with.
    for (const self of ["Nil", " NIL "])
      expect(chatCopyText(EN, mixed, "myMessages", { ...md, self })).toBe(
        [
          mdLabel("Nil"),
          String.raw`Mine A, \$5`,
          mdLabel("nil"),
          "Mine B",
        ].join("\n\n"),
      );
  });

  it("My messages keeps every message a member typed when the viewer has no name", () => {
    for (const self of [null, undefined, "", "  "])
      expect(chatCopyText(EN, mixed, "myMessages", { ...md, self })).toBe(
        [
          mdLabel("Nil"),
          String.raw`Mine A, \$5`,
          mdLabel("Ana"),
          "Other member",
          mdLabel(YOU),
          "No name",
          mdLabel("nil"),
          "Mine B",
        ].join("\n\n"),
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
    // A member's WhatsApp contact through a row (task d03a61d8): never the
    // member, whose row it is.
    [
      "a WhatsApp contact",
      {
        sender_messaging_app: "whatsapp",
        sender_messaging_route_id: "r_3f9a0c1d",
        sender_messaging_route_name: "Mom",
        username: "Nil",
      },
      EN.t("common.sender.messaging", { name: "Mom", app: "WhatsApp" }),
      undefined,
      false,
    ],
    // An app a later release queued: the row's name alone, never the raw id.
    [
      "a contact in an app this release does not know",
      {
        sender_messaging_app: "telegram",
        sender_messaging_route_id: "r_3f9a0c1d",
        sender_messaging_route_name: "Mom",
        username: "Nil",
      },
      "Mom",
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
