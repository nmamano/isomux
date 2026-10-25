import { describe, expect, it } from "bun:test";
import { AGENT_TEMPLATES, templateFormValues } from "./agent-templates.ts";
import { CATALOGS, translatorFor } from "./i18n/translate.ts";
import {
  RECEPTIONIST_INSTRUCTIONS,
  RECEPTIONIST_PROFILE_KEY,
} from "./receptionist-profile.ts";

const baseline = {
  modelFamily: "sonnet",
  effort: "medium",
  permissionMode: "default",
} as const;

describe("template instruction localization", () => {
  // The server's receptionist profile reads this constant, the template the
  // catalog: two copies of one text.
  it("keeps the lobby receptionist constant equal to the English catalog", () => {
    expect(CATALOGS.en["templates.receptionist.instructions"]).toBe(
      RECEPTIONIST_INSTRUCTIONS,
    );
  });

  // The task text, then the three shared clauses, in the reader's language;
  // the receptionist has no shared clauses.
  for (const language of ["en", "es", "ca", "zh"] as const) {
    it(`applies all ${language} prompts with the complete shared workflow`, () => {
      const catalog = CATALOGS[language];
      for (const template of AGENT_TEMPLATES) {
        const task = catalog[template.instructionsKey];
        const applied = templateFormValues(
          translatorFor(language),
          template,
          "claude",
          baseline,
          null,
          false,
        );
        const sections = applied.customInstructions.split("\n\n");
        const taskSections = task.split("\n\n");
        expect(sections.slice(0, taskSections.length), template.key).toEqual(
          taskSections,
        );
        expect(sections.slice(taskSections.length), template.key).toEqual(
          template.key === RECEPTIONIST_PROFILE_KEY
            ? []
            : [
                catalog["templates.shared.firstTurn"],
                catalog["templates.shared.softwareTool"],
                catalog["templates.shared.plainLanguage"],
              ],
        );
      }
    });
  }

  for (const language of ["es", "ca", "zh"] as const) {
    it(`preserves ${language} prompt structure and protected names`, () => {
      const keys = [
        ...AGENT_TEMPLATES.map((t) => t.instructionsKey),
        "templates.shared.firstTurn",
        "templates.shared.softwareTool",
        "templates.shared.plainLanguage",
      ] as const;
      const protectedNames =
        /OpenAI|Anthropic|Claude|ChatGPT|gmail|Isomux|git\/github|\bgit\b|\bgithub\b|TypeScript|Bun|bun:sqlite|openevidence\.com|GitHub Pages|Vercel|Chrome/g;
      for (const key of keys) {
        const source = CATALOGS.en[key];
        const translated = CATALOGS[language][key];
        expect(translated, key).not.toBe(source);
        expect(translated.split("\n\n").length, key).toBe(
          source.split("\n\n").length,
        );
        const linePrefixes = (text: string) =>
          text.split("\n").map((line) => line.match(/^(## |- )/)?.[0] ?? "");
        expect(linePrefixes(translated), key).toEqual(linePrefixes(source));
        expect(translated.match(/\*/g)?.length ?? 0, key).toBe(
          source.match(/\*/g)?.length ?? 0,
        );
        expect(translated, key).not.toMatch(/\{\w+\}|[<>]/);
        expect((translated.match(protectedNames) ?? []).sort(), key).toEqual(
          (source.match(protectedNames) ?? []).sort(),
        );
      }
    });
  }
});
