import type { AgentOutfit } from "./types.ts";

export const COSTUMES = [
  "none",
  "doctor",
  "police",
  "firefighter",
  "chef",
  "construction",
  "astronaut",
] as const;

// Old records omit the field; permissive API clients can also send unknown ids.
export function costumeOf(value: unknown): NonNullable<AgentOutfit["costume"]> {
  return COSTUMES.includes(value as (typeof COSTUMES)[number])
    ? (value as (typeof COSTUMES)[number])
    : "none";
}

export const SHIRT_COLORS = [
  "#4A90D9",
  "#E85D75",
  "#50B86C",
  "#D4A843",
  "#9B6DFF",
  "#FF8C42",
  "#45B7D1",
  "#FF6B9D",
];

export const HAIR_COLORS = [
  "#3a2a1a",
  "#8B4513",
  "#1a1a2e",
  "#C4A265",
  "#222",
  "#8a5a3a",
  "#E84393",
  "#6C5CE7",
];

export const SKIN_COLORS = ["#FDEBD0", "#FFD5B8", "#C68642", "#5C3A28"];

export const HAIR_STYLES: AgentOutfit["hairStyle"][] = [
  "short",
  "long",
  "ponytail",
  "bun",
  "pigtails",
  "curly",
  "bald",
];

export const BEARDS: AgentOutfit["beard"][] = [
  "none",
  "stubble",
  "full",
  "goatee",
  "mustache",
];

export const HATS: AgentOutfit["hat"][] = [
  "none",
  "cap",
  "beanie",
  "bow",
  "headband",
];
export const ACCESSORIES: AgentOutfit["accessory"][] = [
  null,
  "glasses",
  "headphones",
  "bow_tie",
  "tie",
  "earrings",
];

// Combinations a random outfit never gets. Only random picks are checked: a
// member's choice in the outfit picker is never blocked.
export function isUnusualOutfit(
  outfit: Pick<AgentOutfit, "hat" | "beard" | "hairStyle">,
): boolean {
  const bearded = outfit.beard !== "none";
  return (
    (outfit.hat === "bow" && (bearded || outfit.hairStyle === "bald")) ||
    (bearded && outfit.hairStyle === "pigtails")
  );
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Picks each part at random and picks again when the result is unusual. The
// result has no costume key, so the costume is None.
export function randomOutfit(): AgentOutfit {
  for (;;) {
    const outfit: AgentOutfit = {
      hat: pick(HATS),
      color: pick(SHIRT_COLORS),
      hair: pick(HAIR_COLORS),
      hairStyle: pick(HAIR_STYLES),
      skin: pick(SKIN_COLORS),
      beard: pick(BEARDS),
      accessory: pick(ACCESSORIES),
    };
    if (!isUnusualOutfit(outfit)) return outfit;
  }
}
