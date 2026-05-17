// Shared avatar (ghost) constants and helpers. Used by:
// - server: validating avatarColor / avatarVariant in update_user;
//   filling defaults at user-record read time.
// - ui:     rendering the variant gallery in the user-edit form and
//   the ghost on the office scene.
//
// Keeping the variant list and color palette in shared/ means the
// validation, persistence, and rendering paths all agree on the
// supported values. Adding a new variant or color is a single-file
// change here plus the visual asset in ui/office/ghostVariants.tsx.

export const GHOST_VARIANTS = [
  "classic",
  "big-eyes",
  "sleepy",
  "tongue-out",
  "stubby-arms",
  "wisp-tail",
  "nightcap",
  "glow-halo",
] as const;

export type GhostVariant = (typeof GHOST_VARIANTS)[number];

export function isGhostVariant(value: unknown): value is GhostVariant {
  return (
    typeof value === "string" &&
    (GHOST_VARIANTS as readonly string[]).includes(value)
  );
}

// Curated pastel palette. Hand-picked rather than HSL-from-hash so the
// default color for every existing user is guaranteed legible against
// every supported theme floor and doesn't collide with model-tint
// affordances. Users pick a different color (from this palette or a
// custom hex) via the user-edit form.
export const GHOST_COLOR_PALETTE = [
  "#88d1f0", // cyan
  "#94c2e8", // steel-blue
  "#a8b8e8", // periwinkle
  "#b6a8e0", // violet
  "#c9b6e4", // lavender
  "#e0b0d8", // orchid
  "#f5b7c4", // pink
  "#ffab91", // coral
  "#ffc89c", // peach
  "#ffd180", // yellow
  "#d6e090", // chartreuse
  "#b5e8d5", // mint
] as const;

// Lowercase hex, with or without leading #, validated to a 3- or 6-digit
// RGB component. The user-edit form normalizes to "#rrggbb" form before
// persisting, but accept the looser shape on the wire to keep the saved
// record stable across UI changes.
const HEX_RE = /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

export function normalizeHexColor(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const body = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  return `#${body}`;
}

// Deterministic default color for a user id. Used as the avatarColor
// default both at create-time (claimUser) and at read-time (load()).
// Hash → palette index keeps the choice stable across processes; the
// FNV-like rolling hash is plenty for the size of the palette (12).
export function defaultGhostColorForUserId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return GHOST_COLOR_PALETTE[hash % GHOST_COLOR_PALETTE.length];
}
