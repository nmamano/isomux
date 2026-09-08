import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LobbyScene } from "./LobbyScene.tsx";

const ROOMS = [{ id: "r1", name: "Isomux" }];

// Ids the lobby draws through the office's own components (Floor.tsx's sun
// rays and doors). Everything the lobby itself defines stays `lobby-` prefixed
// so the two scenes never collide when both are in one document.
const SHARED_IDS = new Set(["sunray-wide", "sunray-narrow", "door-knob", "door-opening"]);

describe("LobbyScene", () => {
  {
    for (const mode of ["dark", "light"] as const) {
      it(`renders ${mode} without broken values or unprefixed ids`, () => {
        const markup = renderToStaticMarkup(
          <LobbyScene
            rooms={ROOMS}
            officeName="Isomux"
            mode={mode}
          />,
        );
        expect(markup).toContain("<svg");
        expect(markup).not.toContain("NaN");
        expect(markup).not.toContain("undefined");
        const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(id.startsWith("lobby-") || SHARED_IDS.has(id)).toBe(true);
      });
    }
  }

  it("keeps its own warm colours whatever the theme is", () => {
    const markup = renderToStaticMarkup(
      <LobbyScene rooms={ROOMS} officeName="x" mode="dark" />,
    );
    // The lobby never borrows the office's theme variables: it is warm wood in
    // every theme, and only dark/light changes (Nil, 2026-09-05).
    expect(markup).not.toContain("var(--wall-left)");
    expect(markup).not.toContain("var(--floor-light)");
  });

  it("draws the door to the first room only when one is given", () => {
    const without = renderToStaticMarkup(
      <LobbyScene rooms={ROOMS} officeName="x" mode="dark" />,
    );
    const with_ = renderToStaticMarkup(
      <LobbyScene rooms={ROOMS} officeName="x" mode="dark" rightDoor={{ label: "Isomux", onClick: () => {} }} />,
    );
    expect(without).not.toContain("door-knob");
    expect(with_).toContain("door-knob");
    expect(with_).toContain("Isomux");
  });
});


describe("lobby prop registry", () => {
  const ctx = {
    rooms: [
      { id: "a", name: "Isomux" },
      { id: "b", name: "Assistants" },
    ],
    officeName: "Isomux",
    wall: "left" as const,
    star: null,
    back: "far" as const,
  };
  for (const family of LOBBY_PROPS) {
    for (const v of family.variants) {
      it(`${family.id}/${v.id} renders cleanly`, () => {
        const C = v.Component;
        const markup = renderToStaticMarkup(
          <svg>
            <C {...ctx} />
          </svg>,
        );
        expect(markup).not.toContain("NaN");
        expect(markup).not.toContain("undefined");
        const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
        for (const id of ids) expect(id.startsWith("lobby-") || SHARED_IDS.has(id)).toBe(true);
        expect(v.height).toBeGreaterThan(0);
        if (!v.wall && family.id !== "rug") expect(v.shadow).toBeDefined();
      });
    }
  }

  it("has unique variant ids per family", () => {
    for (const f of LOBBY_PROPS) {
      const ids = f.variants.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

import { LOBBY_LAYOUTS, LOBBY_LAYOUT_IDS, type Placement } from "./layouts.ts";
import { findVariant, LOBBY_PROPS, variantFacings } from "./props.tsx";

const NILO_MIN_COORDINATE = -2;
const NILO_MAX_COORDINATE = 11;

describe("lobby layouts", () => {
  for (const id of LOBBY_LAYOUT_IDS) {
    const spec = LOBBY_LAYOUTS[id];
    it(`${id} places registered variants at valid coordinates`, () => {
      for (const p of spec.placements) {
        expect(findVariant(p.family, p.variant)).toBeDefined();
        expect(Number.isFinite(p.a)).toBe(true);
        expect(Number.isFinite(p.b)).toBe(true);
        // Nil's saved nilo places the cat and a plant above furniture with
        // negative floor coordinates. Preserve that profile without clipping.
        const min = id === "nilo" ? NILO_MIN_COORDINATE : 0;
        const max = id === "nilo" ? NILO_MAX_COORDINATE : 10;
        expect(p.a).toBeGreaterThanOrEqual(min);
        expect(p.a).toBeLessThanOrEqual(max);
        expect(p.b).toBeGreaterThanOrEqual(min);
        expect(p.b).toBeLessThanOrEqual(max);
        if (p.wall) expect(p.h).toBeGreaterThan(0);
      }
    });
    {
      it(`${id} renders cleanly`, () => {
        const markup = renderToStaticMarkup(
          <LobbyScene
            rooms={[{ id: "r1", name: "Isomux" }]}
            officeName="Isomux"
            mode="dark"
            layout={id}
          />,
        );
        expect(markup).not.toContain("NaN");
        expect(markup).not.toContain("undefined");
        const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
        for (const x of ids) expect(x.startsWith("lobby-") || SHARED_IDS.has(x)).toBe(true);
        // Every placement produced a prop group.
        const groups = markup.match(/<g transform="translate\(/g) ?? [];
        expect(groups.length).toBeGreaterThanOrEqual(spec.placements.length);
      });
    }
  }

  for (const id of LOBBY_LAYOUT_IDS) {
    it(`${id} has a receptionist slot inside the floor`, () => {
      const slot = LOBBY_LAYOUTS[id].receptionist;
      expect(slot.a).toBeGreaterThanOrEqual(0);
      expect(slot.a).toBeLessThanOrEqual(10);
      expect(slot.b).toBeGreaterThanOrEqual(0);
      expect(slot.b).toBeLessThanOrEqual(10);
    });
  }

  it("draws the receptionist node at the slot, with a shadow, only when given one", () => {
    const without = renderToStaticMarkup(
      <LobbyScene rooms={[]} officeName="x" mode="dark" layout="lounge" />,
    );
    const withOne = renderToStaticMarkup(
      <LobbyScene
        rooms={[]}
        officeName="x"
        mode="dark"
        layout="lounge"
        receptionist={<circle data-receptionist-node="1" r="1" />}
      />,
    );
    expect(without).not.toContain("data-receptionist-node");
    expect(withOne).toContain('data-receptionist-node="1"');
    // Behind the counter: the figure's group precedes the counter's in the markup.
    const figureAt = withOne.indexOf("data-receptionist-node");
    const counterAt = withOne.indexOf("lobby-counter", 0);
    if (counterAt !== -1) expect(figureAt).toBeLessThan(counterAt);
  });

  it("honours a variant override", () => {
    const a = renderToStaticMarkup(
      <LobbyScene rooms={[]} officeName="x" mode="dark" layout="fireside" />,
    );
    const b = renderToStaticMarkup(
      <LobbyScene rooms={[]} officeName="x" mode="dark" layout="fireside" variants={{ sofa: "loveseat" }} />,
    );
    expect(a).not.toBe(b);
    expect(b).toContain("#5c6f8a"); // the loveseat's pillow
  });
});

describe("lobby lighting", () => {
  it("fireside carries a dark-only fire glow and a lamp pool", () => {
    const markup = renderToStaticMarkup(
      <LobbyScene rooms={[]} officeName="x" mode="dark" layout="fireside" />,
    );
    expect(markup).toContain('class="lobby-dark-only"');
    expect(markup).toContain('class="lamp-glow"');
    expect(markup).toContain("<animate");
  });
});

describe("ghost spots", () => {
  it("every layout offers spots inside the floor, spread apart", () => {
    for (const id of LOBBY_LAYOUT_IDS) {
      const spots = LOBBY_LAYOUTS[id].ghostSpots;
      expect(spots.length).toBeGreaterThanOrEqual(4);
      for (const s of spots) {
        expect(s.a).toBeGreaterThan(0);
        expect(s.a).toBeLessThan(10);
        expect(s.b).toBeGreaterThan(0);
        expect(s.b).toBeLessThan(10);
      }
      // No two spots close enough to read as one place.
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          const d = Math.hypot(spots[i].a - spots[j].a, spots[i].b - spots[j].b);
          expect(d).toBeGreaterThan(1);
        }
      }
    }
  });
});

describe("draw order", () => {
  // Two props at the same spot: the one with the higher z is drawn later, so
  // it paints over the other. Reading the markup order is the whole assertion.
  const at = (family: string, variant: string, z?: number) => ({ family, variant, a: 5, b: 5, z });
  const order = (placements: Placement[]) => {
    const markup = renderToStaticMarkup(
      <LobbyScene rooms={ROOMS} officeName="x" mode="dark" layout="fireside" placements={placements} />,
    );
    return [markup.indexOf("#5c6f8a"), markup.indexOf("lobby-tr-foot")];
  };

  it("puts a raised prop after its neighbour", () => {
    const [sofa, table] = order([at("sofa", "loveseat"), at("table", "round", 1)]);
    expect(sofa).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(sofa);
    const [sofa2, table2] = order([at("sofa", "loveseat", 1), at("table", "round")]);
    expect(table2).toBeLessThan(sofa2);
  });
});

describe("facing", () => {
  const seat = (facing: Placement["facing"]) => ({
    family: "armchair",
    variant: "club",
    a: 5,
    b: 5,
    facing,
  });
  const render = (p: Placement) =>
    renderToStaticMarkup(
      <LobbyScene rooms={ROOMS} officeName="x" mode="dark" layout="fireside" placements={[p]} />,
    );

  it("mirrors for the west facings and not for the east ones", () => {
    expect(render(seat("SE"))).not.toContain("scale(-");
    expect(render(seat("NE"))).not.toContain("scale(-");
    expect(render(seat("SW"))).toContain("scale(-");
    expect(render(seat("NW"))).toContain("scale(-");
  });

  it("puts the backrest in front of the seat when seen from behind", () => {
    // Painter's order is the whole point: facing away, the seat is drawn first
    // and the backrest covers it; facing the viewer, the backrest comes first.
    const at = (markup: string, part: string) => markup.indexOf(`data-part="${part}"`);
    const front = render(seat("SE"));
    const behind = render(seat("NE"));
    expect(at(front, "back")).toBeLessThan(at(front, "seat"));
    expect(at(behind, "back")).toBeGreaterThan(at(behind, "seat"));
  });

  it("still honours a plain flip for props with no back", () => {
    expect(
      render({ family: "shelf", variant: "tall", a: 5, b: 5, flip: true }),
    ).toContain("scale(-");
  });
});

describe("how many ways a prop faces", () => {
  it("only turns around the props that have a drawn back", () => {
    for (const fam of LOBBY_PROPS) {
      for (const v of fam.variants) {
        if (v.wall) continue;
        const n = variantFacings(v);
        const render = (facing: Placement["facing"]) =>
          renderToStaticMarkup(
            <LobbyScene
              rooms={ROOMS}
              officeName="x"
              mode="dark"
              layout="fireside"
              placements={[{ family: fam.id, variant: v.id, a: 5, b: 5, facing }]}
            />,
          );
        const se = render("SE");
        // A prop with fewer than four facings ignores the back-facing ones
        // rather than drawing something that never turned around.
        if (n < 4) expect(render("NE")).toBe(se);
        else expect(render("NE")).not.toBe(se);
        if (n === 1) expect(render("SW")).toBe(se);
        else expect(render("SW")).not.toBe(se);
      }
    }
  });
});
