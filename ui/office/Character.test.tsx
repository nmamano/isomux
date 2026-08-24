import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
