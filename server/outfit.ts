import type { AgentOutfit } from "../shared/types.ts";

// Simple string hash
function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const SHIRT_COLORS = [
  "#4A90D9", "#E85D75", "#50B86C", "#D4A843",
  "#9B6DFF", "#FF8C42", "#45B7D1", "#FF6B9D",
];

const HAIR_COLORS = [
  "#3a2a1a", "#8B4513", "#1a1a2e", "#C4A265",
  "#2a1a1a", "#5a3a1a", "#222", "#8a5a3a",
];

const HATS: AgentOutfit["hat"][] = ["none", "none", "cap", "beanie"];
const ACCESSORIES: AgentOutfit["accessory"][] = [null, "glasses", "headphones", null];

export function generateOutfit(name: string): AgentOutfit {
  const h = hashName(name);
  return {
    hat: HATS[h % HATS.length],
    color: SHIRT_COLORS[h % SHIRT_COLORS.length],
    hair: HAIR_COLORS[(h >> 4) % HAIR_COLORS.length],
    accessory: ACCESSORIES[(h >> 8) % ACCESSORIES.length],
  };
}
