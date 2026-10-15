// The back room screen (task 5b503e32): one seated figure per back agent at
// its stored seat, the room's n x n size, one click to a log, the attention
// bubbles, and the bar's buttons.
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentInfo } from "../../../shared/types.ts";
import { setUpDomTestFile } from "../../test-support/dom.ts";

setUpDomTestFile();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { BackRoomScreen } = await import("./BackRoomScreen.tsx");
const { onLanguage } = await import("../../test-support/language-fixture.tsx");
const { firstFreeBackSeat, deskOfBackSeat } =
  await import("../../../shared/desks.ts");
const { backRoomLayout, fitScale, MIN_SCALE } = await import("./geometry.ts");

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

  it("opens the menu on right-click; the bar goes back and spawns", () => {
    const { view, calls } = show(backAgents(1));
    fireEvent.contextMenu(figures(view.container)[0]);
    const buttons = [...view.container.querySelectorAll("button")];
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[buttons.length - 1]);
    expect(calls).toEqual(["menu:w0", "back", "spawn"]);
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
  it("fits the room in the box but never below the smallest readable scale", () => {
    const layout = backRoomLayout(10);
    expect(fitScale(layout, { width: 5000, height: 5000 })).toBe(1);
    expect(fitScale(layout, { width: 300, height: 300 })).toBe(MIN_SCALE);
    const mid = fitScale(layout, {
      width: layout.width * 0.9,
      height: layout.height,
    });
    expect(mid).toBeCloseTo(0.9, 5);
  });
});
