// The back room screen (task 5b503e32): one seated figure per back agent at
// its stored seat, the room's n x n size, one click to a log, the attention
// bubbles, the bar's buttons, the ladder up to the front, the board's fit
// on the wall (task f0af4677), and the bulbs' place (task 79c967a8).
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentInfo } from "../../../shared/types.ts";
import { setUpDomTestFile } from "../../test-support/dom.ts";

setUpDomTestFile();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { BackRoomScreen } = await import("./BackRoomScreen.tsx");
const { onLanguage } = await import("../../test-support/language-fixture.tsx");
const { firstFreeBackSeat, deskOfBackSeat, backRoomSide } =
  await import("../../../shared/desks.ts");
const { backRoomLayout, MIN_SCALE } = await import("./geometry.ts");
const { computeRestView } = await import("../useViewport.ts");
const { getDraggedDesk, setDraggedDesk } = await import("../drag-state.ts");

afterEach(cleanup);

const OUTFIT = {
  color: "#4A90D9",
  hair: "#222",
  hairStyle: "short",
  skin: "#FFD5B8",
  beard: "none",
  accessory: null,
  hat: "none",
};

function backAgents(n: number) {
  const taken: number[] = [];
  return Array.from({ length: n }, (_, i) => {
    const desk = firstFreeBackSeat(taken)!;
    taken.push(desk);
    return {
      id: `w${i}`,
      name: `W${i}`,
      desk,
      roomId: "r1",
      state: "idle",
      outfit: OUTFIT,
      pendingPrompt: null,
    } as unknown as AgentInfo;
  });
}

function show(
  agents: ReturnType<typeof backAgents>,
  unread = new Set<string>(),
  frontFull = false,
) {
  const calls: string[] = [];
  const view = render(
    onLanguage(
      "en",
      <BackRoomScreen
        roomName="Studio"
        agents={agents}
        needsAttention={unread}
        isMobile={false}
        onBack={() => calls.push("back")}
        onSpawn={() => calls.push("spawn")}
        onOpenAgent={(id) => calls.push(`open:${id}`)}
        onContextMenu={(_x, _y, a) => calls.push(`menu:${a.id}`)}
        frontFull={frontFull}
        onDropToFront={(a) => calls.push(`front:${a.id}`)}
      />,
    ),
  );
  return { view, calls };
}

const figures = (el: HTMLElement) => [
  ...el.querySelectorAll("[data-back-figure]"),
];

describe("BackRoomScreen", () => {
  it("draws one figure per back agent, and a click opens that agent", () => {
    const { view, calls } = show(backAgents(3));
    expect(figures(view.container)).toHaveLength(3);
    fireEvent.click(figures(view.container)[1]);
    expect(calls).toEqual(["open:w1"]);
  });

  it("puts each agent's name on a nameplate over its figure", () => {
    const { view } = show(backAgents(3));
    const plates = [
      ...view.container.querySelectorAll("[data-back-nameplate]"),
    ];
    expect(plates.map((p) => p.textContent)).toEqual(["W0", "W1", "W2"]);
  });

  it("opens the menu on right-click; the bar goes back and spawns", () => {
    const { view, calls } = show(backAgents(1));
    fireEvent.contextMenu(figures(view.container)[0]);
    // The bar is the screen's first row; the zoom buttons sit in the room.
    const buttons = [
      ...view.container.querySelectorAll(
        "[data-back-room] > div:first-child button",
      ),
    ];
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[buttons.length - 1]);
    expect(calls).toEqual(["menu:w0", "back", "spawn"]);
  });

  it("goes back to the front on a click on the ladder", () => {
    const { view, calls } = show(backAgents(1));
    fireEvent.click(view.container.querySelector("[data-back-ladder]")!);
    expect(calls).toEqual(["back"]);
  });

  it("takes a figure dropped on the ladder to the front, unless the front is full", () => {
    const drag = (el: HTMLElement) => {
      const ladder = el.querySelector("[data-back-ladder]")!;
      // A desk left over from a desk that moved away mid-drag.
      setDraggedDesk(3);
      fireEvent.dragStart(figures(el)[1], {
        dataTransfer: { setData: () => {} },
      });
      // A figure is not a desk: the room tabs must not take it.
      expect(getDraggedDesk()).toBeNull();
      fireEvent.dragOver(ladder, { dataTransfer: { dropEffect: "" } });
      const target = el
        .querySelector("[data-back-ladder-target]")
        ?.getAttribute("data-back-ladder-target");
      fireEvent.drop(ladder, { dataTransfer: { getData: () => "w1" } });
      return target;
    };
    const open = show(backAgents(2));
    // No drag, no drop target.
    expect(
      open.view.container.querySelector("[data-back-ladder-target]"),
    ).toBeNull();
    expect(drag(open.view.container)).toBe("open");
    expect(open.calls).toEqual(["front:w1"]);
    // The drop clears the target.
    expect(
      open.view.container.querySelector("[data-back-ladder-target]"),
    ).toBeNull();
    cleanup();
    const full = show(backAgents(2), new Set(), true);
    expect(drag(full.view.container)).toBe("full");
    expect(full.calls).toEqual([]);
  });

  it("darkens its edges more than the front", () => {
    const { view } = show(backAgents(1));
    expect(
      view.container
        .querySelector("[data-vignette]")
        ?.getAttribute("data-vignette"),
    ).toBe("strong");
  });

  it("stands the ladder at the right wall's end and keeps the board clear of it", () => {
    // From 3x3 to 10x10: the ladder's right edge stays inside the wall, past
    // its middle; the board stays between the back corner and the ladder.
    for (const n of [1, 24, 100]) {
      const agents = backAgents(n);
      const { view } = show(agents);
      const layout = backRoomLayout(backRoomSide(agents.map((a) => a.desk)));
      const backCorner = layout.at(0, 0).x;
      const wallEnd = layout.at(layout.nc, 0).x;
      const ladderXs = [
        ...view.container
          .querySelector("[data-back-ladder]")!
          .getAttribute("d")!
          .matchAll(/[ML](-?[\d.]+) /g),
      ].map((m) => Number(m[1]));
      expect(Math.max(...ladderXs)).toBeLessThanOrEqual(wallEnd);
      expect(Math.min(...ladderXs)).toBeGreaterThan((backCorner + wallEnd) / 2);
      const g = view.container.querySelector("[data-back-board]")!;
      const m = /matrix\(([^)]+)\)/.exec(g.getAttribute("transform")!)!;
      const [k, , , , x] = m[1].split(" ").map(Number);
      const w = Number(g.querySelector("rect")!.getAttribute("width"));
      expect(x).toBeGreaterThanOrEqual(backCorner);
      expect(x + k * w).toBeLessThanOrEqual(Math.min(...ladderXs));
      cleanup();
    }
  });

  it("hangs every bulb above the wall title and the board, none in line with another", () => {
    for (const n of [1, 24, 100]) {
      const { view } = show(backAgents(n));
      const sign = view.container.querySelector("[data-back-sign]")!;
      const [, , , , , sy] = /matrix\(([^)]+)\)/
        .exec(sign.getAttribute("transform")!)![1]
        .split(" ")
        .map(Number);
      const text = sign.querySelector("text")!;
      const font = Number(text.getAttribute("font-size"));
      const len = [...text.textContent].length;
      const signW =
        len * (0.6 * font + Number(text.getAttribute("letter-spacing")));
      // The title slants up to its right end, by half its width.
      const signTop = sy - signW / 4 - font;
      const board = view.container.querySelector("[data-back-board]")!;
      const boardTop = Number(
        /matrix\(([^)]+)\)/
          .exec(board.getAttribute("transform")!)![1]
          .split(" ")[5],
      );
      const bulbs = [...view.container.querySelectorAll("[data-back-bulb]")];
      expect(bulbs.length).toBeGreaterThanOrEqual(4);
      const xs: number[] = [];
      let glowR = 0;
      for (const b of bulbs) {
        const cord = /^M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)$/.exec(
          b.querySelector("path")!.getAttribute("d")!,
        )!;
        const [, x0, y0] = cord.map(Number);
        // The cord runs up past the top of the screen.
        expect(y0).toBeLessThan(-1000);
        // The glow comes first, the bulb last.
        const [glow, disc] = [...b.querySelectorAll("circle")];
        glowR = Number(glow.getAttribute("r"));
        const discBottom =
          Number(disc.getAttribute("cy")) + Number(disc.getAttribute("r"));
        expect(discBottom).toBeLessThan(Math.min(signTop, boardTop));
        xs.push(x0);
      }
      // No two glows overlap, so no bulb or cord hides behind another.
      xs.sort((a, b) => a - b);
      for (let k = 1; k < xs.length; k++)
        expect(xs[k] - xs[k - 1]).toBeGreaterThan(2 * glowR);
      cleanup();
    }
  });

  it("gives the 0, + and - keys its own view, which zooms out past the front's limit", () => {
    const ref: { current: { zoomOut: () => void } | null } = { current: null };
    const view = render(
      onLanguage(
        "en",
        <BackRoomScreen
          roomName="Studio"
          agents={backAgents(1)}
          needsAttention={new Set()}
          isMobile={false}
          onBack={() => {}}
          onSpawn={() => {}}
          onOpenAgent={() => {}}
          onContextMenu={() => {}}
          frontFull={false}
          onDropToFront={() => {}}
          viewportControlsRef={ref as never}
        />,
      ),
    );
    expect(ref.current).not.toBeNull();
    for (let i = 0; i < 12; i++) ref.current!.zoomOut();
    const scene = view.container.querySelector(
      "[data-back-room] > div:nth-child(2) > div",
    ) as HTMLElement;
    // The front stops at 0.5; the back room goes to 0.25.
    expect(scene.style.transform).toContain("scale(0.25)");
    view.unmount();
    expect(ref.current).toBeNull();
  });

  it("is 3x3 at first and grows to 4x4 when the ninth seat fills", () => {
    // Seats in the room: figures plus empty stools.
    const tables = (n: number) => {
      const { view } = show(backAgents(n));
      const stools =
        view.container.querySelectorAll("[data-back-stool]").length;
      cleanup();
      return stools + n;
    };
    expect(tables(1)).toBe(9);
    expect(tables(8)).toBe(9);
    expect(tables(9)).toBe(16);
  });

  it("puts a figure at its stored seat, whatever the order of the list", () => {
    const seatA = deskOfBackSeat({ table: 2, stool: 1 });
    const seatB = deskOfBackSeat({ table: 0, stool: 0 });
    const a = { ...backAgents(1)[0], id: "a", desk: seatA };
    const b = { ...backAgents(1)[0], id: "b", desk: seatB };
    const pos = (list: AgentInfo[]) => {
      const { view } = show(list);
      const out = Object.fromEntries(
        figures(view.container).map((f) => [
          f.getAttribute("data-back-figure"),
          (f as HTMLElement).style.left + "," + (f as HTMLElement).style.top,
        ]),
      );
      cleanup();
      return out;
    };
    expect(pos([a, b])).toEqual(pos([b, a]));
  });

  it("lays tables out across the room and stools along a table", () => {
    // A table further back is up-right; the next stool on a table is down-right.
    const a = {
      ...backAgents(1)[0],
      id: "nextTable",
      desk: deskOfBackSeat({ table: 1, stool: 0 }),
    };
    const b = {
      ...backAgents(1)[0],
      id: "nextStool",
      desk: deskOfBackSeat({ table: 0, stool: 1 }),
    };
    const { view } = show([a, b]);
    const at = (id: string) => {
      const f = view.container.querySelector(
        `[data-back-figure="${id}"]`,
      ) as HTMLElement;
      return { x: parseFloat(f.style.left), y: parseFloat(f.style.top) };
    };
    expect(at("nextTable").x).toBeLessThan(at("nextStool").x);
    expect(at("nextTable").y).toBeGreaterThan(at("nextStool").y);
  });

  it("marks an unread agent and an asking agent with different bubbles", () => {
    const agents = backAgents(2);
    agents[1] = { ...agents[1], pendingPrompt: "permission" };
    const { view } = show(agents, new Set(["w0"]));
    const text = view.container.textContent ?? "";
    expect(text).toContain("•••");
    expect(text).toContain("?");
  });
});

describe("back room fit", () => {
  // The back room's rest view, as BackRoomScreen asks the viewport for it: the
  // room box, centred in the screen, width and height both count.
  const rest = (side: number, cw: number, ch: number) => {
    const { width, height } = backRoomLayout(side);
    const box = {
      left: (cw - width) / 2,
      right: (cw + width) / 2,
      top: (ch - height) / 2,
      bottom: (ch + height) / 2,
    };
    return computeRestView(cw, ch, box, true, MIN_SCALE).scale;
  };

  it("fits the room in the screen but never below the smallest readable scale", () => {
    expect(rest(10, 5000, 5000)).toBe(1);
    expect(rest(10, 390, 700)).toBe(MIN_SCALE);
    const { width } = backRoomLayout(10);
    const mid = rest(10, width * 0.95, 5000);
    expect(mid).toBeGreaterThan(MIN_SCALE);
    expect(mid).toBeLessThan(1);
  });
});
