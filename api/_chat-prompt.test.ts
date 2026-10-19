import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { SYSTEM_PROMPT, ISOMUX_KNOWLEDGE, buildSystemPrompt } from "./chat.ts";

describe("site chatbot knowledge", () => {
  it("is the tail of the site prompt, from What is Isomux through the guidelines", () => {
    expect(ISOMUX_KNOWLEDGE.startsWith("## What is Isomux?\n")).toBe(true);
    expect(ISOMUX_KNOWLEDGE).toContain("\n## Guidelines\n");
    // The voice header keeps exactly one blank line before the knowledge.
    expect(SYSTEM_PROMPT.endsWith(`\n\n${ISOMUX_KNOWLEDGE}`)).toBe(true);
    expect(SYSTEM_PROMPT.endsWith(`\n\n\n${ISOMUX_KNOWLEDGE}`)).toBe(false);
  });
});

describe("site chatbot page context", () => {
  it("adds one page direction after the shared prompt", () => {
    const hosted = buildSystemPrompt("hosted");
    const neutral = buildSystemPrompt(undefined);
    for (const prompt of [hosted, neutral]) {
      expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(prompt.length).toBeGreaterThan(SYSTEM_PROMPT.length);
    }
    expect(hosted).not.toBe(neutral);
  });

  it("uses the neutral direction when page identity is absent or unrecognised", () => {
    const neutral = buildSystemPrompt(undefined);
    expect(buildSystemPrompt("unknown")).toBe(neutral);
    expect(buildSystemPrompt("main")).toBe(neutral);
  });

  it("adds no direction on a docs page, whose content is the authoritative context", () => {
    expect(buildSystemPrompt("main", true)).toBe(SYSTEM_PROMPT);
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

describe("site chatbot disclosures", () => {
  const root = join(import.meta.dir, "..");

  it("points site visitors at the privacy policy while the handler relays chats", () => {
    const handler = readFileSync(join(import.meta.dir, "chat.ts"), "utf8");
    expect(handler).toContain("DISCORD_WEBHOOK_URL");
    expect(SYSTEM_PROMPT).toContain("isomux.com/hosted-privacy");
    // Office receptionist chats are not relayed, so the shared knowledge
    // carries no such disclosure.
    expect(ISOMUX_KNOWLEDGE).not.toContain("hosted-privacy");
  });

  it("offers Nil's X and LinkedIn, with the URLs the site uses", () => {
    const about = readFileSync(join(root, "site", "about.html"), "utf8");
    for (const host of ["x.com", "linkedin.com"]) {
      const url = ISOMUX_KNOWLEDGE.match(
        new RegExp(`https://${host.replace(".", "\\.")}/[^\\s)]+`),
      )?.[0];
      expect(url).toBeDefined();
      expect(about).toContain(`"${url}"`);
    }
  });

  it("gives install steps that name no shell-specific config file", () => {
    const surfaces = [
      ISOMUX_KNOWLEDGE,
      readFileSync(join(root, "README.md"), "utf8"),
      ...["", "es", "ca", "zh"].map((lang) =>
        readFileSync(join(root, "site", lang, "index.html"), "utf8"),
      ),
    ];
    for (const text of surfaces) {
      expect(text).not.toMatch(/\.bashrc|\.zshrc|config\.fish/u);
    }
  });
});
