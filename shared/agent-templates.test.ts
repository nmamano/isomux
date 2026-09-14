import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { AGENT_TEMPLATES, templateFormValues } from "./agent-templates.ts";
import { CATALOGS, translatorFor } from "./i18n/translate.ts";
import { RECEPTIONIST_INSTRUCTIONS, RECEPTIONIST_PROFILE_KEY } from "./receptionist-profile.ts";

// Captured from the pre-translation output on 2026-09-14, before moving any
// strings. Independent of the catalogs, so changing both copies cannot hide
// an English wording, whitespace, or shared-clause order regression.
const ENGLISH_SHA256: Record<string, string> = {
  "isomux-receptionist": "3bfabb8eb25312ea50c645ea161ba4a1d72e9218bf639b0d062fea76b655776b",
  "side-project-builder": "d7dd430c9d6429bbb8a434ff07b5c650283532f145a4c6e759f9e00fb5b82ee1",
  "personal-site-builder": "800dfb851d75a6e477ecea6f4363492b71d8c6dd5142c05e02c64ada29c96183",
  "code-reviewer": "8395d9820b0c88dd2db587f7b7f97f4dfb128b584a937db3ee817ec60230d6c3",
  "money-planner": "a43a5302ff1335f21a02c45f13b72448a35e1abee3760151ab54ac30e7fc0838",
  "job-search-coach": "b582775fd2cf9032cddb9e3346109a9f2136d19a8cb84a6c001ebcf03622fc01",
  "research-analyst": "4579bd098e877162541d70e97d8da2cb6363574f9bddf3b2731a1f6e5cd30465",
  "health-navigator": "15d4988193b4fe2431307412bbd33d1ca3e2e248230cab8bfb1d4297862dead4",
  "life-coach": "160e90f4a7b8a4529ebe435a0f433663ec145b136e10992b636654bbbbb4061d",
  "relationship-advisor": "416053101e9f75aee404ef311f130cc7bc3d9c7ec86544ccda2d646cb5704314",
  "todo-list-assistant": "f91dfbcc6d552cd5e37e7318c3e92434ca971db09482fe24a3f0c1bd99e3b51f",
  "city-guide": "ba64a8c85030ebf932ef7d29008c4148b5753332075da368b7dd2e57c6943a91",
  "trip-planner": "441fbbffbae9507257e785117e1b95d5b5f19b0ad911a0eb25f3e74178105839"
};
const baseline = { modelFamily: "sonnet", effort: "medium", permissionMode: "default" } as const;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("template instruction localization", () => {
  it("keeps English output byte-identical for all 13 templates", () => {
    expect(AGENT_TEMPLATES.map(t => t.key).sort()).toEqual(Object.keys(ENGLISH_SHA256).sort());
    expect(AGENT_TEMPLATES).toHaveLength(13);
    for (const template of AGENT_TEMPLATES) {
      const applied = templateFormValues(translatorFor("en"), template, "claude", baseline, null, false);
      expect(sha256(applied.customInstructions), template.key).toBe(ENGLISH_SHA256[template.key]);
      expect(applied.customInstructions, template.key).toBe(template.customInstructions);
    }
  });

  it("keeps the lobby receptionist constant byte-identical to the English catalog", () => {
    expect(CATALOGS.en["templates.receptionist.instructions"]).toBe(RECEPTIONIST_INSTRUCTIONS);
    expect(sha256(RECEPTIONIST_INSTRUCTIONS)).toBe(ENGLISH_SHA256[RECEPTIONIST_PROFILE_KEY]);
  });

  for (const language of ["es", "ca", "zh"] as const) {
    it(`applies all 13 ${language} prompts with the complete shared workflow`, () => {
      const catalog = CATALOGS[language];
      for (const template of AGENT_TEMPLATES) {
        const task = catalog[template.instructionsKey];
        const englishTask = CATALOGS.en[template.instructionsKey];
        expect(task, template.key).not.toBe(englishTask);
        const applied = templateFormValues(translatorFor(language), template, "claude", baseline, null, false);
        const sections = applied.customInstructions.split("\n\n");
        const taskSections = task.split("\n\n");
        expect(sections.slice(0, taskSections.length), template.key).toEqual(taskSections);
        expect(sections.slice(taskSections.length), template.key).toEqual(
          template.key === RECEPTIONIST_PROFILE_KEY ? [] : [
            catalog["templates.shared.firstTurn"],
            catalog["templates.shared.softwareTool"],
            catalog["templates.shared.plainLanguage"],
          ],
        );
        expect(applied.customInstructions, template.key).not.toBe(template.customInstructions);
        expect(sha256(template.customInstructions), template.key).toBe(ENGLISH_SHA256[template.key]);
      }
    });

    it(`preserves ${language} prompt structure and protected names`, () => {
      const keys = [
        ...AGENT_TEMPLATES.map(t => t.instructionsKey),
        "templates.shared.firstTurn", "templates.shared.softwareTool", "templates.shared.plainLanguage",
      ] as const;
      const protectedNames = /OpenAI|Anthropic|Claude|ChatGPT|gmail|Isomux|git\/github|\bgit\b|\bgithub\b|TypeScript|Bun|bun:sqlite|openevidence\.com|GitHub Pages|Vercel|Chrome/g;
      for (const key of keys) {
        const source = CATALOGS.en[key];
        const translated = CATALOGS[language][key];
        expect(translated, key).not.toBe(source);
        expect(translated.split("\n\n").length, key).toBe(source.split("\n\n").length);
        const linePrefixes = (text: string) => text.split("\n").map(line => line.match(/^(## |- )/)?.[0] ?? "");
        expect(linePrefixes(translated), key).toEqual(linePrefixes(source));
        expect(translated.match(/\*/g)?.length ?? 0, key).toBe(source.match(/\*/g)?.length ?? 0);
        expect(translated, key).not.toMatch(/\{\w+\}|[<>]/);
        expect((translated.match(protectedNames) ?? []).sort(), key).toEqual((source.match(protectedNames) ?? []).sort());
      }
    });
  }
});
