// Tab-title faces (task 4a8eff79). The mapping is user-facing copy Nil signed
// off on, so it's frozen here verbatim - a change to any face should be a
// deliberate edit to this file, not a silent drift.
import { describe, expect, it } from "bun:test";
import { agentTabLabel, faceForState } from "./agent-face.ts";
import type { AgentState } from "../shared/types.ts";

const ALL_STATES: AgentState[] = [
  "idle",
  "thinking",
  "tool_executing",
  "waiting_for_response",
  "error",
  "stopped",
];

describe("faceForState", () => {
  it("maps every state to its signed-off face", () => {
    expect(faceForState("idle")).toBe("(-_-)zz");
    expect(faceForState("thinking")).toBe("~(o_o)~");
    expect(faceForState("tool_executing")).toBe("~(o_o)~");
    expect(faceForState("waiting_for_response")).toBe("(^_^)ﾉ");
    expect(faceForState("error")).toBe("(｡>﹏<｡)");
    expect(faceForState("stopped")).toBe("(-_-)zz");
  });

  it("matches the avatar poses one to one (Nil's rule)", () => {
    // Same grouping as visualState() in ui/office/Character.tsx.
    expect(faceForState("thinking")).toBe(faceForState("tool_executing"));
    expect(faceForState("stopped")).toBe(faceForState("idle"));
  });

  it("covers the whole AgentState union", () => {
    for (const state of ALL_STATES) {
      expect(faceForState(state)).not.toBe("");
    }
  });

  it("has no glyph iOS could emoji-render, and no variation selectors", () => {
    // Every non-ASCII char must be outside the Unicode Emoji property (which
    // is what iOS force-renders), and FE0E/FE0F must not appear at all.
    for (const state of ALL_STATES) {
      const face = faceForState(state);
      expect(face).not.toMatch(/[\uFE0E\uFE0F]/);
      for (const ch of face) {
        if ((ch.codePointAt(0) ?? 0) < 128) continue;
        expect(ch).not.toMatch(/\p{Emoji}/u);
      }
    }
  });

  it("has no combining marks - they clip unpredictably in tab strips", () => {
    for (const state of ALL_STATES) {
      expect(faceForState(state)).not.toMatch(/\p{M}/u);
    }
  });

  it("stays narrow enough for a tab strip", () => {
    for (const state of ALL_STATES) {
      expect(faceForState(state).length).toBeLessThanOrEqual(7);
    }
  });

  it("degrades to no face for a state added server-side", () => {
    expect(faceForState("teleporting" as AgentState)).toBe("");
  });
});

describe("agentTabLabel", () => {
  it("leads with the face so a truncated tab still shows state", () => {
    expect(agentTabLabel("Isomuxer5", "idle")).toBe("(-_-)zz Isomuxer5");
    expect(agentTabLabel("Isomuxer5", "waiting_for_response")).toBe(
      "(^_^)ﾉ Isomuxer5",
    );
  });

  it("falls back to the bare name when there's no face", () => {
    expect(agentTabLabel("Isomuxer5", "teleporting" as AgentState)).toBe(
      "Isomuxer5",
    );
  });
});
