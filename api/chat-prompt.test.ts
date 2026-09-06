import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { SYSTEM_PROMPT, buildSystemPrompt } from "./chat.ts";

describe("site chatbot mobile app guidance", () => {
  it("pins the iPhone and Android PWA setup copy verbatim", () => {
    expect(SYSTEM_PROMPT).toContain(
      "When someone asks whether Isomux has a mobile app or how to use it on a phone, explain that Isomux installs as a PWA with no app store. On iPhone: open the office in Safari, tap Share, then tap Add to Home Screen. On Android: open the office in Chrome, tap Install app when prompted, or open the menu and tap Install app.",
    );
  });
});

describe("site chatbot page context", () => {
  it("gives hosted visitors the dashboard access fact and managed-product direction", () => {
    const prompt = buildSystemPrompt("hosted");
    expect(prompt).toContain(
      "Hosted customers sign in at the Hosted Isomux dashboard and open their office from there.",
    );
    expect(prompt).toContain(
      "The user is interested in Hosted Isomux. Answer for someone who wants a managed Isomux office.",
    );
    expect(prompt).toContain(
      "Do not quote prices, provisioning times, launch dates, or promises beyond what those pages say.",
    );
  });

  it("uses a neutral context when page identity is absent or unrecognised", () => {
    const neutral =
      "Answer for the Isomux option that fits the user's question. Do not assume they are self-hosting.";
    expect(buildSystemPrompt(undefined)).toContain(neutral);
    expect(buildSystemPrompt("unknown")).toContain(neutral);
  });

  it("does not contradict authoritative context on a docs page", () => {
    const prompt = buildSystemPrompt("main", true);
    expect(prompt).toBe(SYSTEM_PROMPT);
    expect(prompt).not.toContain("Do not assume they are self-hosting.");
  });

  it("sends a closed page identity from the shared widget", () => {
    const widget = readFileSync(
      join(import.meta.dir, "..", "site", "chatbot.js"),
      "utf8",
    );
    // The language prefix (/es, /ca) comes off before the classification, so
    // /es/hosted is the hosted page, not the landing (i18n S10).
    expect(widget).toContain(
      'window.location.pathname.replace(LANGUAGE_PREFIX, "")',
    );
    expect(widget).toContain('pagePath.startsWith("/hosted")');
    expect(widget).toMatch(/messages: messages\.map[\s\S]*\n\s*page,/u);
  });
});
