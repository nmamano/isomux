import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentOutfit, AgentState } from "../../shared/types.ts";
import { Character } from "./Character.tsx";

const OUTFIT = {
  color: "#4A90D9",
  hair: "#222",
  hairStyle: "short" as const,
  skin: "#FFD5B8",
  beard: "none" as const,
  accessory: "headphones" as const,
  hat: "beanie" as const,
};

describe("Character portrait", () => {
  it("renders a correctly sized non-status portrait without glyphs or animation", () => {
    const markup = renderToStaticMarkup(
      <Character state="idle" outfit={OUTFIT} portrait height={44} />,
    );

    expect(markup).toContain('height="44"');
    expect(markup).toContain('width="34"');
    expect(markup).not.toContain("<animate");
    expect(markup).not.toContain("<text");
  });
});

describe("Character costumes", () => {
  const states: AgentState[] = [
    "idle",
    "thinking",
    "waiting_for_response",
    "error",
  ];
  it("keeps missing and unknown costumes identical to none in every pose", () => {
    for (const state of states) {
      const draw = (outfit: AgentOutfit) =>
        renderToStaticMarkup(<Character state={state} outfit={outfit} />);
      expect(draw({ ...OUTFIT, costume: "none" })).toBe(draw(OUTFIT));
      expect(draw({ ...OUTFIT, costume: "none" })).not.toContain(
        "data-costume-head",
      );
      expect(
        draw({ ...OUTFIT, costume: "banana" as AgentOutfit["costume"] }),
      ).toBe(draw(OUTFIT));
    }
  });
  it("keeps the uniform visible in all poses and in the 40px plaque portrait", () => {
    const costumes = [
      "doctor",
      "police",
      "firefighter",
      "chef",
      "construction",
      "astronaut",
    ] as const;
    for (const costume of costumes) {
      for (const state of states) {
        const markup = renderToStaticMarkup(
          <Character state={state} outfit={{ ...OUTFIT, costume }} />,
        );
        expect(markup).toContain(`data-costume-body="${costume}"`);
        if (costume === "doctor")
          expect(markup).not.toContain("data-costume-head");
        else expect(markup).toContain(`data-costume-head="${costume}"`);
      }
      const portrait = renderToStaticMarkup(
        <Character
          state="idle"
          outfit={{ ...OUTFIT, costume }}
          portrait
          height={40}
        />,
      );
      expect(portrait).toContain(`data-costume-body="${costume}"`);
      expect(portrait).not.toContain("<animate");
      if (costume === "doctor")
        expect(portrait).not.toContain("data-costume-head");
      else expect(portrait).toContain(`data-costume-head="${costume}"`);
    }
  });
});
