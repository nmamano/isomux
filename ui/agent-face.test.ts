// Tab-title faces (task 4a8eff79). The mapping is user-facing copy Nil signed
// off on, so it's frozen here verbatim — a change to any face should be a
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
    expect(faceForState("idle")).toBe("(-_-)");
    expect(faceForState("thinking")).toBe("(o_o)");
    expect(faceForState("tool_executing")).toBe("(o_o)");
    expect(faceForState("waiting_for_response")).toBe("(*_*)/");
    expect(faceForState("error")).toBe("(x_x)");
    expect(faceForState("stopped")).toBe("(-_-)");
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

  it("is plain ASCII — no glyph iOS could emoji-render", () => {
    for (const state of ALL_STATES) {
      expect(faceForState(state)).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("degrades to no face for a state added server-side", () => {
    expect(faceForState("teleporting" as AgentState)).toBe("");
  });
});

describe("agentTabLabel", () => {
  it("leads with the face so a truncated tab still shows state", () => {
    expect(agentTabLabel("Isomuxer5", "idle")).toBe("(-_-) Isomuxer5");
    expect(agentTabLabel("Isomuxer5", "waiting_for_response")).toBe(
      "(*_*)/ Isomuxer5",
    );
  });

  it("falls back to the bare name when there's no face", () => {
    expect(agentTabLabel("Isomuxer5", "teleporting" as AgentState)).toBe(
      "Isomuxer5",
    );
  });
});
