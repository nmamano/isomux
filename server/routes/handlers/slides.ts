// Slide Mode handlers (design: internal-docs/slide-mode-design.md).
//
//   GET  /api/agents/:id/slides            → the conversation's slide map
//   POST /api/agents/:id/slides/:entryId   → "ensure slide" (cached | pending)
//
// Boss-session read surface (office:read + room access, gated in the route
// table): anyone who can see the chat can read its slides and drive on-demand
// generation. Generation is fire-and-forget in the manager; the finished slide
// arrives on the `slide_ready` WS push, so these handlers never block on the LLM
// and never emit directly. Unavailability (no live session, or the turn is gone)
// is a 200 payload the client branches on - the contextUsage precedent - not an
// error.

import { ok, type RouteHandler } from "../executor.ts";
import type {
  SlideDeckRes,
  EnsureSlideReq,
  EnsureSlideRes,
} from "../../../shared/contract-shapes.ts";

export interface SlideDeps {
  getSlideDeck: (agentId: string) => SlideDeckRes | null;
  ensureSlide: (
    agentId: string,
    entryId: string,
    opts?: { force?: boolean; feedback?: string | null },
  ) => EnsureSlideRes;
}

export function slidesHandlers(deps: SlideDeps): Record<string, RouteHandler> {
  return {
    "agents.getSlides": (ctx) => {
      const deck = deps.getSlideDeck(ctx.params.id);
      // No live session yet → an empty deck rather than an error.
      return ok(
        deck ?? ({ sessionId: null, slides: {} } satisfies SlideDeckRes),
      );
    },

    "agents.ensureSlide": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<EnsureSlideReq>;
      const force = body.force === true;
      const feedback =
        typeof body.feedback === "string" ? body.feedback : undefined;
      return ok(
        deps.ensureSlide(ctx.params.id, ctx.params.entryId, {
          force,
          feedback,
        }),
      );
    },
  };
}
