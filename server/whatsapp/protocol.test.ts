// The stdio protocol with a WhatsApp bridge child (task d03a61d8): one JSON
// object per line, and a line from the child that is not a valid event is
// dropped (null), never thrown, because the child runs third-party code.

import { describe, expect, it } from "bun:test";
import {
  encodeCommand,
  parseBridgeEvent,
  type BridgeCommand,
  type BridgeEvent,
} from "./protocol.ts";

// A text message in a routed chat (slice 2). ts is in milliseconds.
const MESSAGE: BridgeEvent = {
  ev: "message",
  id: "3EB0C431",
  chat: "1203@g.us",
  group: true,
  ts: 1_800_000_000_000,
  fromMe: false,
  sender: "447700900123@s.whatsapp.net",
  senderName: "Aunt Jo",
  senderPhone: "447700900123",
  text: "hello </x> [Nil]",
  mentionsMe: false,
  quotedId: null,
};

describe("whatsapp bridge protocol", () => {
  it("a command is one line that decodes to itself", () => {
    const commands: BridgeCommand[] = [
      { op: "link", method: "qr" },
      { op: "link", method: "code", phone: "447700900123" },
      { op: "logout" },
      { op: "stop" },
      { op: "routes", chats: [] },
      { op: "routes", chats: ["447700900123@s.whatsapp.net", "1203@g.us"] },
      // A reply (slice 2b): the text can hold line breaks; the line cannot.
      {
        op: "send",
        requestId: "ask-1",
        chat: "447700900123@s.whatsapp.net",
        text: "*Helper*\nsee you at 5\n\nbye",
      },
    ];
    for (const cmd of commands) {
      const line = encodeCommand(cmd);
      expect(line.replace(/\n$/, "")).not.toContain("\n");
      expect(JSON.parse(line)).toEqual(cmd);
    }
  });

  it("parses every event the bridge sends", () => {
    const events: BridgeEvent[] = [
      { ev: "qr", code: "2@abc,def,ghi==" },
      { ev: "pairing-code", code: "ABCD1234" },
      { ev: "linked", phone: "447700900123" },
      { ev: "open" },
      { ev: "closed", statusCode: 401 },
      { ev: "closed", statusCode: null },
      { ev: "log", text: "connection open" },
      { ev: "chat", chat: "1203@g.us", name: "Family", group: true },
      MESSAGE,
      {
        ...MESSAGE,
        senderName: null,
        senderPhone: null,
        quotedId: "m0",
        mentionsMe: true,
      },
      { ev: "sent", requestId: "ask-1", id: "3EB0SENT" },
      { ev: "send-failed", requestId: "ask-1" },
    ];
    for (const event of events)
      expect(parseBridgeEvent(JSON.stringify(event))).toEqual(event);
  });

  it("keeps only the known fields of a message and a send answer: a contact's own WhatsApp name never passes", () => {
    const line = JSON.stringify({
      ...MESSAGE,
      pushName: "Nil",
      verifiedBizName: "Isomux",
    });
    expect(parseBridgeEvent(line)).toEqual(MESSAGE);
    // The send answers too: the supervisor keys on requestId alone.
    expect(
      parseBridgeEvent(
        JSON.stringify({
          ev: "sent",
          requestId: "ask-1",
          id: "3EB0SENT",
          chat: "x",
          text: "y",
        }),
      ),
    ).toEqual({ ev: "sent", requestId: "ask-1", id: "3EB0SENT" });
    expect(
      parseBridgeEvent(
        JSON.stringify({
          ev: "send-failed",
          requestId: "ask-1",
          error: "boom",
        }),
      ),
    ).toEqual({ ev: "send-failed", requestId: "ask-1" });
  });

  it("drops a line that is not a valid event", () => {
    for (const line of [
      "",
      "not json",
      "null",
      "[1]",
      "{}",
      '{"ev":"nope"}',
      '{"ev":"qr"}',
      '{"ev":"qr","code":5}',
      '{"ev":"linked","phone":null}',
      '{"ev":"closed","statusCode":"401"}',
      '{"ev":"log","text":{"x":1}}',
      '{"ev":"chat","chat":"1203@g.us","name":"Family"}',
      '{"ev":"chat","chat":"1203@g.us","name":null,"group":true}',
      '{"ev":"sent","requestId":"ask-1"}',
      '{"ev":"sent","requestId":7,"id":"3EB0SENT"}',
      '{"ev":"sent","requestId":"ask-1","id":null}',
      '{"ev":"send-failed"}',
      '{"ev":"send-failed","requestId":null}',
      ...(
        [
          ["id", 5],
          ["chat", null],
          ["group", "yes"],
          ["ts", "1"],
          ["fromMe", 1],
          ["sender", undefined],
          ["senderName", 3],
          ["senderPhone", false],
          ["text", null],
          ["mentionsMe", "no"],
          ["quotedId", 7],
        ] as const
      ).map(([key, value]) => JSON.stringify({ ...MESSAGE, [key]: value })),
    ])
      expect(parseBridgeEvent(line)).toBeNull();
  });
});
