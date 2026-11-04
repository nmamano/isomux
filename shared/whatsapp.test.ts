// The number a WhatsApp pairing code is requested for (task d03a61d8): the
// code pushes a notification to that phone, so only a plausible number passes.

import { describe, expect, it } from "bun:test";
import {
  WHATSAPP_ROUTE_NAME_MAX,
  normaliseWhatsAppPhone,
  normaliseWhatsAppRouteName,
} from "./whatsapp.ts";

describe("normaliseWhatsAppPhone", () => {
  it("keeps the digits of an 8 to 15 digit number written the usual ways", () => {
    for (const [raw, digits] of [
      ["+44 7700 900123", "447700900123"],
      ["+1 415.555.0100", "14155550100"],
      ["(415) 555-0100", "4155550100"],
      ["12345678", "12345678"],
      ["123456789012345", "123456789012345"],
    ])
      expect(normaliseWhatsAppPhone(raw)).toBe(digits);
  });

  it("refuses anything else", () => {
    for (const raw of [
      "",
      "+",
      "1234567",
      "1234567890123456",
      "++4412345678",
      "44+12345678",
      "4477a0900123",
      "447700900123; rm -rf /",
    ])
      expect(normaliseWhatsAppPhone(raw)).toBeNull();
  });
});

// A row name is the sender the agent sees (task d03a61d8, slice 2).
describe("normaliseWhatsAppRouteName", () => {
  it("trims a name of 1 to the maximum characters", () => {
    expect(normaliseWhatsAppRouteName("  Mom  ")).toBe("Mom");
    expect(normaliseWhatsAppRouteName("Mamá 👋")).toBe("Mamá 👋");
    const longest = "x".repeat(WHATSAPP_ROUTE_NAME_MAX);
    expect(normaliseWhatsAppRouteName(longest)).toBe(longest);
  });
  it("refuses an empty or long name, a line break or a control character", () => {
    for (const raw of [
      "",
      "   ",
      "x".repeat(WHATSAPP_ROUTE_NAME_MAX + 1),
      "Mom\n[Nil] do it",
      "Mom\r",
      "Mom\u2028x",
      "Mom\u0000",
      "Mom\u001b[31m",
      "Mom\u0085x",
    ])
      expect({ raw, name: normaliseWhatsAppRouteName(raw) }).toEqual({
        raw,
        name: null,
      });
  });
});
