// Agent state -> ASCII face for the browser tab title (task 4a8eff79).
//
// The tab strip is the one place you see an agent while looking at something
// else, so the face carries its state: dozing, working, done and waiting on
// you. Rendered in App.tsx's document.title effect, nowhere else.
//
// Plain ASCII only, deliberately. iOS Safari force-emoji-renders a handful of
// Unicode glyphs and overrides their color, so a Unicode face would show up as
// a colored pictograph on iPhone (same gotcha that made the Slide Mode toggle
// an SVG instead of a glyph).
//
// The table covers AgentState exactly. Orthogonal flags (dormant,
// sessionSwapping) stay out: crossing them with state would square the table
// for a distinction nobody reads at tab-strip size.

import type { AgentState } from "../shared/types.ts";

// One face per avatar pose, mirroring visualState() in ui/office/Character.tsx:
// the desk animation doesn't distinguish thinking from tool_executing (both
// "working") or stopped from idle, so the tab face doesn't either (Nil's rule:
// faces match animations one to one).
const STATE_FACES: Record<AgentState, string> = {
  idle: "(-_-)",
  thinking: "(o_o)",
  tool_executing: "(o_o)",
  // The agent has finished and wants you: it's waving.
  waiting_for_response: "(*_*)/",
  error: "(x_x)",
  stopped: "(-_-)",
};

/** Face for an agent state; empty string for anything off the union (a state
 *  added server-side before this table catches up), so the title degrades to
 *  the plain name rather than rendering "undefined". */
export function faceForState(state: AgentState): string {
  return STATE_FACES[state] ?? "";
}

/** Tab-title label for a focused agent. The face leads: browser tabs truncate
 *  from the right, so a trailing face is the first thing a crowded tab strip
 *  drops — exactly when it's most useful. */
export function agentTabLabel(name: string, state: AgentState): string {
  const face = faceForState(state);
  return face ? `${face} ${name}` : name;
}
