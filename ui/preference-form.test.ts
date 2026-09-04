// The Preferences pane's decisions (ui/preference-form.ts). These stand in for
// component tests - this repo has no DOM/React test harness - so the pane is
// deliberately a thin shell over these functions.
//
// The behavior under the most scrutiny: a browser-detected language is only
// PRESELECTED. It never becomes the stored preference on its own, which is why
// `request` is produced solely on demand and why `record.language` stays null
// until a Save.

import { describe, it, expect } from "bun:test";
import {
  NO_EDITS,
  displayLanguage,
  resolvePreferenceForm,
  languageSeed,
} from "./preference-form.ts";

const record = (over: { language?: "en" | "es" | null }) => ({
  language: over.language ?? null,
});

describe("displayLanguage", () => {
  it("prefers the stored choice over the browser", () => {
    expect(displayLanguage(record({ language: "en" }), "es-ES")).toBe("en");
    expect(displayLanguage(record({ language: "es" }), "en-US")).toBe("es");
  });

  it("falls back to the browser, then to English", () => {
    expect(displayLanguage(record({}), "es-MX")).toBe("es");
    expect(displayLanguage(record({}), "fr-FR")).toBe("en");
    expect(displayLanguage(record({}), null)).toBe("en");
    expect(displayLanguage(null, "es-ES")).toBe("es");
  });
});

describe("resolvePreferenceForm - untouched form", () => {
  it("shows the browser language for a user who has never chosen, WITHOUT that being a stored value", () => {
    const rec = record({});
    const form = resolvePreferenceForm(rec, "es-ES", NO_EDITS);
    expect(form.language).toBe("es");
    // The record is untouched: nothing here writes, and the server still sees
    // "no preference", so agents keep their existing behavior.
    expect(rec.language).toBe(null);
  });

  it("keeps Save available for a never-chosen user so the shown value can be committed", () => {
    // The bug this guards: shown == derived == "not dirty" would grey Save out
    // and leave a Spanish-browser user unable to make it real.
    expect(resolvePreferenceForm(record({}), "es-ES", NO_EDITS).canSave).toBe(
      true,
    );
    expect(resolvePreferenceForm(record({}), "en-US", NO_EDITS).canSave).toBe(
      true,
    );
  });

  it("greys Save out once a choice exists and nothing has been touched", () => {
    expect(
      resolvePreferenceForm(record({ language: "es" }), "es-ES", NO_EDITS)
        .canSave,
    ).toBe(false);
    expect(
      resolvePreferenceForm(record({ language: "en" }), "es-ES", NO_EDITS)
        .canSave,
    ).toBe(false);
  });

  it("shows nothing enabled before the record arrives", () => {
    const form = resolvePreferenceForm(null, "es-ES", NO_EDITS);
    expect(form.canSave).toBe(false);
  });
});

describe("resolvePreferenceForm - edited form", () => {
  it("an edit wins over the record and enables Save", () => {
    const form = resolvePreferenceForm(record({ language: "en" }), "en-US", {
      language: "es",
    });
    expect(form.language).toBe("es");
    expect(form.canSave).toBe(true);
    expect(form.request).toEqual({ language: "es" });
  });

  it("editing back to the stored value disables Save again", () => {
    expect(
      resolvePreferenceForm(record({ language: "es" }), "en-US", {
        language: "es",
      }).canSave,
    ).toBe(false);
  });

  it("a record landing late repaints an untouched form", () => {
    // Same edits, different record -> the shown values follow the record. This
    // is what makes a change saved on another device show up here.
    const before = resolvePreferenceForm(null, "en-US", NO_EDITS);
    const after = resolvePreferenceForm(
      record({ language: "es" }),
      "en-US",
      NO_EDITS,
    );
    expect(before.language).toBe("en");
    expect(after.language).toBe("es");
  });
});

describe("languageSeed (Nil 2026-08-01: browser locale takes effect without a Save)", () => {
  it("seeds the detected non-English language for a never-chosen record", () => {
    expect(languageSeed(record({ language: null }), "es-MX")).toBe("es");
  });

  it("never seeds English - a null record already behaves as English", () => {
    expect(languageSeed(record({ language: null }), "en-US")).toBeNull();
  });

  it("never overrides an explicit choice, even the default", () => {
    expect(languageSeed(record({ language: "en" }), "es-ES")).toBeNull();
    expect(languageSeed(record({ language: "es" }), "es-ES")).toBeNull();
  });

  it("does nothing before the record loads or for unsupported locales", () => {
    expect(languageSeed(null, "es-ES")).toBeNull();
    expect(languageSeed(record({ language: null }), "fr-FR")).toBeNull();
    expect(languageSeed(record({ language: null }), null)).toBeNull();
  });
});
