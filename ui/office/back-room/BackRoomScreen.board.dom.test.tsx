// The back room's board (task a442aa4f): a roster of the back agents on the
// left wall, one line per seated agent in seat order with a status dot, the
// name and the topic, the rest counted in its last slot, and a click, Enter
// or Space on a line opening that agent's log.
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentInfo } from "../../../shared/types.ts";
import { setUpDomTestFile } from "../../test-support/dom.ts";

setUpDomTestFile();
const { cleanup, fireEvent } = await import("@testing-library/react");
const { deskOfBackSeat } = await import("../../../shared/desks.ts");
const { backAgents, show } =
  await import("../../test-support/back-room-fixture.tsx");

afterEach(() => {
  cleanup();
});

const boardLines = (el: HTMLElement) => [
  ...el.querySelectorAll("[data-back-board-line]"),
];
const lineIds = (el: HTMLElement) =>
  boardLines(el).map((l) => l.getAttribute("data-back-board-line"));

describe("BackRoomScreen board", () => {
  it("lists each seated back agent on the board in seat order, whatever the order of the list", () => {
    const at = (id: string, table: number, stool: number) => ({
      ...backAgents(1)[0],
      id,
      name: id.toUpperCase(),
      desk: deskOfBackSeat({ table, stool }),
    });
    const list = [
      at("c", 2, 1),
      at("b", 0, 3),
      // A front desk: no figure, so no line.
      { ...backAgents(1)[0], id: "front", desk: 0 },
      at("a", 0, 0),
      at("d", 2, 2),
    ];
    for (const order of [list, [...list].reverse()]) {
      const { view } = show(order);
      expect(lineIds(view.container)).toEqual(["a", "b", "c", "d"]);
      expect(view.container.querySelector("[data-back-board-more]")).toBeNull();
      cleanup();
    }
  });

  it("shows each agent's name and topic on its line, and no placeholder for a missing topic", () => {
    const long = "refactor the scheduler ".repeat(12).trim();
    const agents = backAgents(3).map((a, i) => ({
      ...a,
      name: `Agent ${i}`,
      topic: [`fix the 漢字 login`, null, long][i],
    })) as unknown as AgentInfo[];
    const { view } = show(agents);
    const lines = boardLines(view.container);
    expect(lines).toHaveLength(3);
    const visible = (l: Element) =>
      [...l.querySelectorAll("text")].map((t) => t.textContent).join(" ");
    expect(visible(lines[0])).toContain("Agent 0");
    expect(visible(lines[0])).toContain("fix the 漢字 login");
    expect(visible(lines[1])).toContain("Agent 1");
    expect(visible(lines[1])).not.toMatch(/null|undefined/);
    // A long topic is cut to the column; the title keeps it whole.
    expect(visible(lines[2])).toContain("Agent 2");
    expect(visible(lines[2])).toContain("refactor the");
    expect(visible(lines[2])).not.toContain(long);
    const title = lines[2].querySelector("title")!.textContent;
    expect(title).toContain("Agent 2");
    expect(title).toContain(long);
    // Names and topics are data: a page translator leaves them alone.
    for (const l of lines)
      for (const t of l.querySelectorAll("text"))
        expect([t.textContent, t.closest(".notranslate") !== null]).toEqual([
          t.textContent,
          true,
        ]);
  });

  it("colours each line's status dot by the agent's state", () => {
    const agents = backAgents(3).map((a, i) => ({
      ...a,
      state: ["thinking", "idle", "error"][i],
    })) as unknown as AgentInfo[];
    const { view } = show(agents);
    expect(boardLines(view.container)).toHaveLength(3);
    const fills = boardLines(view.container).map((l) => {
      const dots = l.querySelectorAll("circle");
      expect(dots).toHaveLength(1);
      return dots[0].getAttribute("fill");
    });
    expect(new Set(fills).size).toBe(3);
  });

  it("fills the board's slots in seat order and counts the rest in its last slot", () => {
    const agents = backAgents(100);
    const { view } = show([...agents].reverse());
    const ids = lineIds(view.container);
    const more = view.container.querySelector("[data-back-board-more]");
    expect(more).not.toBeNull();
    const rest = Number(more!.getAttribute("data-back-board-more"));
    expect(ids.length).toBeGreaterThanOrEqual(9);
    expect(rest).toBeGreaterThan(0);
    expect(ids.length + rest).toBe(100);
    // Seat order is desk order (backAgents fills the room ring by ring).
    const bySeat = [...agents].sort((a, b) => a.desk - b.desk);
    expect(bySeat.map((a) => a.id)).not.toEqual(agents.map((a) => a.id));
    expect(ids).toEqual(bySeat.slice(0, ids.length).map((a) => a.id));
    // The count takes the last slot: in the last column, under its last
    // line, inside the frame.
    const lineAt = boardLines(view.container).map((l) => {
      const m = /translate\((-?[\d.]+)[ ,]+(-?[\d.]+)\)/.exec(
        l.getAttribute("transform")!,
      )!;
      return { x: Number(m[1]), y: Number(m[2]) };
    });
    const cols = [...new Set(lineAt.map((p) => p.x))].sort((a, b) => a - b);
    expect(cols.length).toBeGreaterThan(1);
    const lastCol = cols[cols.length - 1];
    const moreX = Number(more!.getAttribute("x"));
    const moreY = Number(more!.getAttribute("y"));
    expect(moreX - lastCol).toBeGreaterThanOrEqual(0);
    expect(moreX - lastCol).toBeLessThan((cols[1] - cols[0]) / 2);
    expect(moreY).toBeGreaterThan(
      Math.max(...lineAt.filter((p) => p.x === lastCol).map((p) => p.y)),
    );
    const frame = view.container.querySelector("[data-back-board] rect")!;
    expect(moreY).toBeLessThan(Number(frame.getAttribute("height")));
    cleanup();
    // A 3x3 room's nine seats all fit.
    const small = show(backAgents(8));
    expect(lineIds(small.view.container)).toHaveLength(8);
    expect(
      small.view.container.querySelector("[data-back-board-more]"),
    ).toBeNull();
  });

  it("opens an agent's log from its line by click, Enter or Space", () => {
    const { view, calls } = show(backAgents(3));
    const lines = boardLines(view.container);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      // A control a screen reader can reach, which a pan does not start on.
      expect(l.closest('[aria-hidden="true"]')).toBeNull();
      expect(l.getAttribute("role")).toBe("button");
      expect(l.getAttribute("tabindex")).toBe("0");
      expect(l.hasAttribute("data-no-pan")).toBe(true);
    }
    fireEvent.click(lines[1]);
    fireEvent.keyDown(lines[2], { key: "Enter" });
    fireEvent.keyDown(lines[0], { key: " " });
    fireEvent.keyDown(lines[0], { key: "a" });
    expect(calls).toEqual(["open:w1", "open:w2", "open:w0"]);
  });
});
