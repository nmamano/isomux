import { describe, expect, it } from "bun:test";

// This is a structural contract pin. It guards the declarations that make
// transparent SVG padding fall through, but it cannot prove browser hit
// testing. The browser-level elementFromPoint check remains required.
describe("ghost hit boundary declarations", () => {
  it("keeps the wrapper transparent and painted SVG content interactive", async () => {
    const source = await Bun.file(
      new URL("./Ghost.tsx", import.meta.url),
    ).text();

    expect(source).toContain('motionStyle(dimmed, onClick, "none")');
    expect(source).toContain("hitTestPainted");

    const graphicSource = await Bun.file(
      new URL("./ghostVariants.tsx", import.meta.url),
    ).text();
    expect(graphicSource).toContain('pointerEvents: "visiblePainted"');
  });

  it("excludes decorative glow ellipses from the painted hit area", async () => {
    const source = await Bun.file(
      new URL("./ghostVariants.tsx", import.meta.url),
    ).text();

    expect(
      source.match(/pointerEvents="none"/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });
});
