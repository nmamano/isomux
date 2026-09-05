// Model -> visual style mapping (design in
// internal-docs/model-style-mapping-design.md).
//
// Single source for everything a model controls visually: the nametag badge
// tint in the office view, the avatar frame tint in LogView, and the optional
// desk decoration on the desk sprite. Render sites call styleForModel()
// instead of keying on exact family strings, so adding a model means adding
// one entry here (or nothing at all: unknown models get a deterministic
// fallback color instead of flat gray).
//
// Lives in ui/ (not shared/) on purpose: this is pure presentation data (CSS
// colors, sprite prop names) with no server consumer.

import { familyDisplayLabel } from "../shared/types.ts";

// Desk decorations a model can carry. "book" is the whole current opus
// rendering, including the per-desk cover-color and clock variation - that
// variation stays inside DeskSprite's renderer, keyed on deskIndex.
export type DeskProp = "crayons" | "book";

export interface ModelStyle {
  border: string; // CSS color
  bg: string; // CSS color
  deskProp?: DeskProp;
}

// Explicit entries for every known model. Colors are seeded verbatim from the
// former MODEL_TINT tables (previously duplicated in DeskUnit.tsx and
// LogView.tsx) so known models keep their exact tints.
//
// Desk props encode capability TIER, not identity: frontier
// models get the book (opus, fable, gpt-5.6-sol), small/fast models get the
// crayons (haiku, gpt-5.4-mini, gpt-5.6-luna), mid models get a bare desk.
// At-a-glance encoding: color hue ~ provider/family, desk prop ~ tier.
export const MODEL_STYLES: Record<string, ModelStyle> = {
  opus: {
    border: "rgba(100,160,255,0.85)",
    bg: "rgba(100,160,255,0.35)",
    deskProp: "book",
  },
  fable: {
    border: "rgba(170,130,255,0.85)",
    bg: "rgba(170,130,255,0.35)",
    deskProp: "book",
  },
  sonnet: { border: "rgba(218,165,32,0.80)", bg: "rgba(218,165,32,0.32)" },
  haiku: {
    border: "rgba(230,130,180,0.80)",
    bg: "rgba(230,130,180,0.32)",
    deskProp: "crayons",
  },
  "gpt-5.5": { border: "rgba(120,220,160,0.90)", bg: "rgba(120,220,160,0.36)" },
  "gpt-5.4": { border: "rgba(120,220,160,0.78)", bg: "rgba(120,220,160,0.28)" },
  "gpt-5.4-mini": {
    border: "rgba(120,220,160,0.62)",
    bg: "rgba(120,220,160,0.20)",
    deskProp: "crayons",
  },
  "gpt-5.6-sol": {
    border: "rgba(80,220,150,0.95)",
    bg: "rgba(80,220,150,0.40)",
    deskProp: "book",
  },
  "gpt-5.6-terra": {
    border: "rgba(80,200,140,0.80)",
    bg: "rgba(80,200,140,0.30)",
  },
  "gpt-5.6-luna": {
    border: "rgba(80,200,140,0.60)",
    bg: "rgba(80,200,140,0.20)",
    deskProp: "crayons",
  },
};

// Missing/empty model identity (e.g. DeskSprite's optional prop): the same
// neutral gray the old ?? fallbacks produced. Never hashed - absence of
// identity should not look like a model.
export const NEUTRAL_STYLE: ModelStyle = {
  border: "var(--border-medium)",
  bg: "var(--bg-tag)",
};

// Fallback tints for model strings with no MODEL_STYLES entry. Hues chosen
// away from the known-family hues where the wheel allows (opus blue, fable
// purple, sonnet gold, haiku pink, gpt green), with alphas matching the
// established border ~0.8 / bg ~0.3 weight so they hold up over both light
// and dark themes, as a 1-2px border and as a translucent chip background.
// Eight entries gives deterministic VARIETY, not uniqueness - collisions are
// expected and fine; the goal is that new models stop all looking gray.
export const FALLBACK_PALETTE: readonly ModelStyle[] = [
  { border: "rgba(235,110,100,0.80)", bg: "rgba(235,110,100,0.30)" }, // coral
  { border: "rgba(240,160,70,0.80)", bg: "rgba(240,160,70,0.30)" }, // orange
  { border: "rgba(170,210,90,0.80)", bg: "rgba(170,210,90,0.30)" }, // lime
  { border: "rgba(70,200,210,0.80)", bg: "rgba(70,200,210,0.30)" }, // cyan
  { border: "rgba(110,150,220,0.80)", bg: "rgba(110,150,220,0.30)" }, // slate blue
  { border: "rgba(220,110,220,0.80)", bg: "rgba(220,110,220,0.30)" }, // magenta
  { border: "rgba(200,175,140,0.80)", bg: "rgba(200,175,140,0.30)" }, // tan
  { border: "rgba(150,220,190,0.80)", bg: "rgba(150,220,190,0.30)" }, // mint
];

// djb2-style string hash, forced unsigned with >>> 0 before the modulo so
// the palette index can never go negative. Exported because DeskSprite picks
// the drink in an agent's cup the same way, keyed on the agent id; one
// implementation keeps the two sites from drifting.
export function hashIndex(s: string, buckets: number): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s.charCodeAt(i)) >>> 0;
  }
  return h % buckets;
}

// The single lookup all render sites use.
// - Known model: its explicit entry.
// - Missing/empty: NEUTRAL_STYLE (no deskProp).
// - Unknown non-empty string: a stable FALLBACK_PALETTE entry (no deskProp).
export function styleForModel(modelFamily: string | undefined): ModelStyle {
  if (!modelFamily) return NEUTRAL_STYLE;
  // Own-property check: model IDs are arbitrary runtime strings, so a plain
  // truthy index would leak Object.prototype members ("constructor",
  // "toString", "__proto__") as bogus styles.
  if (Object.hasOwn(MODEL_STYLES, modelFamily)) {
    return MODEL_STYLES[modelFamily];
  }
  return FALLBACK_PALETTE[hashIndex(modelFamily, FALLBACK_PALETTE.length)];
}

// The label on the side of a desk. Deliberately shorter than the model's full
// display label: it is a visual cue, not a classification, and it has to fit a
// face 50 sprite units wide. Two cuts:
//   - a Codex codename already implies its family, so "GPT-5.6 Sol" becomes
//     "5.6 SOL". A bare version keeps its prefix, because "5.5" alone says
//     nothing.
//   - a trailing tier word is marketing rather than identity, so
//     "Muse Spark 1.2 Free" becomes "MUSE SPARK 1.2".
// Everything else is the display label, upper-cased. An agent with no model
// identity gets no label at all - absence should not look like a model.
export function deskModelLabel(modelFamily: string | undefined): string | null {
  if (!modelFamily) return null;
  const full = familyDisplayLabel(modelFamily);
  // Guarded so a model literally called "Free" does not strip to nothing.
  const base = full.replace(/ Free$/, "") || full;
  const codename = base.match(/^GPT-([\d.]+ .+)$/);
  return (codename ? codename[1] : base).toUpperCase();
}
