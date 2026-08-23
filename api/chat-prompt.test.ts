import { describe, expect, it } from "bun:test";
import { SYSTEM_PROMPT } from "./chat.ts";

describe("site chatbot mobile app guidance", () => {
  it("pins the iPhone and Android PWA setup copy verbatim", () => {
    expect(SYSTEM_PROMPT).toContain(
      "When someone asks whether Isomux has a mobile app or how to use it on a phone, explain that Isomux installs as a PWA with no app store. On iPhone: open the office in Safari, tap Share, then tap Add to Home Screen. On Android: open the office in Chrome, tap Install app when prompted, or open the menu and tap Install app.",
    );
  });
});
