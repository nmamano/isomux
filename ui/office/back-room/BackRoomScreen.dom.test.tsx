// The back room screen (task 5b503e32): one seated figure per back agent at
// its stored seat, the room's n x n size, one click to a log, the attention
// bubbles, the bar's buttons and the ladder up to the front. The walls are
// in BackRoomScreen.walls.dom.test.tsx, the board's lines in
// BackRoomScreen.board.dom.test.tsx.
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentInfo } from "../../../shared/types.ts";
import { setUpDomTestFile } from "../../test-support/dom.ts";

setUpDomTestFile();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { BackRoomScreen } = await import("./BackRoomScreen.tsx");
const { onLanguage } = await import("../../test-support/language-fixture.tsx");
const { deskOfBackSeat } = await import("../../../shared/desks.ts");
const { getDraggedDesk, setDraggedDesk } = await import("../drag-state.ts");
const { backAgents, screenFor, show, figures } =
  await import("../../test-support/back-room-fixture.tsx");

afterEach(() => {
  cleanup();
  setDraggedDesk(null);
});

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

  it("puts the count of open asks on that agent's nameplate only", () => {
    const { view } = show(
      backAgents(3),
      new Set(),
      false,
      new Map([["w1", 2]]),
    );
    const dots = [
      ...view.container.querySelectorAll("[data-back-nameplate]"),
    ].map((p) => p.querySelector("[data-ask-dot]")?.textContent ?? null);
    expect(dots).toEqual([null, "2", null]);
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
      // The figure's seat replaces it, so the room tabs move this agent
      // (task 335384f8).
      expect(getDraggedDesk()).toBe(backAgents(2)[1].desk);
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

  // A figure drag is a desk drag (task 335384f8): it ends at the figure's
  // dragend, or when the figure unmounts first because its agent moved away
  // and its dragend never fires (as a desk does, task 39a70575).
  it("holds the figure's seat as the dragged desk until its dragend or unmount", () => {
    const agents = backAgents(3);
    const start = (el: HTMLElement, i: number) =>
      fireEvent.dragStart(figures(el)[i], {
        dataTransfer: { setData: () => {} },
      });
    const { view } = show(agents);
    start(view.container, 1);
    expect(getDraggedDesk()).toBe(agents[1].desk);
    fireEvent.dragEnd(figures(view.container)[1]);
    expect(getDraggedDesk()).toBeNull();
    // Another figure leaving keeps the drag; the dragged one ends it.
    start(view.container, 1);
    view.rerender(screenFor([agents[1], agents[2]]));
    expect(getDraggedDesk()).toBe(agents[1].desk);
    view.rerender(screenFor([agents[2]]));
    expect(getDraggedDesk()).toBeNull();
    // A figure that ended its own drag leaves a later drag alone.
    start(view.container, 0);
    fireEvent.dragEnd(figures(view.container)[0]);
    setDraggedDesk(3);
    view.rerender(screenFor([]));
    expect(getDraggedDesk()).toBe(3);
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

  // The bubbles are glyphs, not copy: "•••" for unread, "?" for an open
  // permission prompt, which wins when the agent is both. Each case renders
  // one agent, and the bubble is the svg text it adds to a quiet agent's.
  it("marks an unread agent and an asking agent with different bubbles", () => {
    const [agent] = backAgents(1);
    const texts = (pendingPrompt: string | null, unread: boolean) => {
      const { view } = show(
        [{ ...agent, pendingPrompt } as unknown as AgentInfo],
        new Set(unread ? [agent.id] : []),
      );
      const out = [...view.container.querySelectorAll("svg text")].map(
        (t) => t.textContent ?? "",
      );
      cleanup();
      return out;
    };
    const quiet = texts(null, false);
    const bubble = (pendingPrompt: string | null, unread: boolean) => {
      const added = texts(pendingPrompt, unread);
      for (const t of quiet) {
        const i = added.indexOf(t);
        expect([t, i >= 0]).toEqual([t, true]);
        added.splice(i, 1);
      }
      return added;
    };
    expect(bubble(null, true)).toEqual(["•••"]);
    expect(bubble("permission", false)).toEqual(["?"]);
    expect(bubble("permission", true)).toEqual(["?"]);
  });
});
