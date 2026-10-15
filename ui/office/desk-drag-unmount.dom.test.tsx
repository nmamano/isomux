// A desk that unmounts mid-drag (task 39a70575): its agent moved to another
// room, so its dragend never fires. The desk drag must still end, or the next
// drag lights the room tabs as desk targets and a drop can move the wrong
// agent.

import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { DeskUnit } = await import("./DeskUnit.tsx");
const { useDeskDrag } = await import("./useDeskDrag.ts");
const { getDraggedDesk, setDraggedDesk } = await import("./drag-state.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

afterEach(() => {
  cleanup();
  setDraggedDesk(null);
});

const noop = () => {};

function agent(id: string, desk: number) {
  return {
    id,
    name: id,
    desk,
    roomId: "a",
    cwd: "~",
    state: "idle",
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    topic: null,
    topicStale: false,
    customInstructions: null,
    customInstructionsVersion: "0",
    permissionMode: "default",
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: "none",
      hat: "none",
    },
  } as never;
}

function Probe() {
  return <i data-desk-drag={String(useDeskDrag())} />;
}

function scene(desks: number[]) {
  return onLanguage(
    "en",
    <>
      {desks.map((desk) => (
        <DeskUnit
          key={desk}
          agent={agent(`d${desk}`, desk)}
          onClick={noop}
          onContextMenu={noop}
        />
      ))}
      <Probe />
    </>,
  );
}

const deskDrag = (container: HTMLElement) =>
  container.querySelector("[data-desk-drag]")!.getAttribute("data-desk-drag");

function startDrag(container: HTMLElement, index: number) {
  const desk = container.querySelectorAll("[draggable]")[index];
  fireEvent.dragStart(desk, {
    dataTransfer: { setData: noop, effectAllowed: "" },
  });
}

it("ends the desk drag when the dragged desk unmounts before its dragend", () => {
  const view = render(scene([2, 5]));
  startDrag(view.container, 0);
  expect(getDraggedDesk()).toBe(2);
  expect(deskDrag(view.container)).toBe("true");
  view.rerender(scene([5]));
  expect(getDraggedDesk()).toBeNull();
  expect(deskDrag(view.container)).toBe("false");
});

it("keeps the desk drag when another desk unmounts", () => {
  const view = render(scene([2, 5]));
  startDrag(view.container, 1);
  view.rerender(scene([5]));
  expect(getDraggedDesk()).toBe(5);
  expect(deskDrag(view.container)).toBe("true");
});

it("ends the desk drag at the dragged desk's dragend", () => {
  const view = render(scene([2]));
  startDrag(view.container, 0);
  fireEvent.dragEnd(view.container.querySelector("[draggable]")!);
  expect(getDraggedDesk()).toBeNull();
  expect(deskDrag(view.container)).toBe("false");
  // A desk that ended its own drag leaves a later drag alone at unmount.
  setDraggedDesk(2);
  view.rerender(scene([]));
  expect(getDraggedDesk()).toBe(2);
});
