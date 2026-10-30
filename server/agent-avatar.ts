// An agent's face as a standalone SVG (GET /api/agents/:id/avatar.svg): the
// portrait the chat shows beside a sender, rendered from the same React
// component (ui/office/Character.tsx), so the two cannot drift.
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Character } from "../ui/office/Character.tsx";
import type { AgentOutfit } from "../shared/types.ts";

// Intrinsic size of the image; the view box lets an <img> scale it.
export const AGENT_AVATAR_SIZE = 64;

export function agentAvatarSvg(outfit: AgentOutfit): string {
  return renderToStaticMarkup(
    createElement(Character, {
      state: "idle",
      outfit,
      portrait: true,
      headCrop: AGENT_AVATAR_SIZE,
    }),
  );
}

// A weak ETag from the rendered bytes, so a change to the drawing code
// changes it too, not only a change to the outfit.
export function agentAvatarEtag(svg: string): string {
  const hash = createHash("sha256").update(svg).digest("base64url");
  return `W/"${hash.slice(0, 22)}"`;
}
