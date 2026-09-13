import { afterAll, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { SkillsPopover } = await import("./SkillsPopover.tsx");
const { setApiShim } = await import("../api.ts");

function installVisualViewport({
  height,
  offsetTop,
}: {
  height: number;
  offsetTop: number;
}) {
  const listeners = new Map<string, Set<EventListener>>();
  const viewport = {
    height,
    offsetTop,
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set<EventListener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? [])
        listener(new Event(type));
    },
  };
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  return viewport;
}

// Keep usage loading pending: these tests cover menu interaction, and a late
// resolved fetch would schedule setCounts after a standalone test has ended.
setApiShim(() => new Promise(() => {}));
afterAll(() => setApiShim(null));

it("keeps composer focus and picks from the draft-controlled full menu", () => {
  const onPick = mock(() => {});
  const onClose = mock(() => {});
  const view = render(
    <div>
      <textarea autoFocus defaultValue="/" />
      <SkillsPopover
        skills={[
          { name: "verify", origin: "user" },
          { name: "write", origin: "project" },
        ]}
        commands={[{ name: "clear", autoRun: true }]}
        isMobile={false}
        draftFilter=""
        onPick={onPick}
        onClose={onClose}
      />
    </div>,
  );
  expect(view.container.querySelector("input") === null).toBe(true);
  expect(document.activeElement?.tagName).toBe("TEXTAREA");
  expect(view.getByText("Commands") !== null).toBe(true);
  expect(view.getByText("Project") !== null).toBe(true);

  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("verify", undefined);
});

it("closes on Escape and lets Enter send an unmatched slash draft", () => {
  const onPick = mock(() => {});
  const onClose = mock(() => {});
  render(
    <SkillsPopover
      skills={[]}
      commands={[]}
      isMobile={false}
      draftFilter="unknown"
      onPick={onPick}
      onClose={onClose}
    />,
  );
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(onPick).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it("keeps keyboard selection in the Sk button filter path", () => {
  const onPick = mock(() => {});
  const view = render(
    <SkillsPopover
      skills={[{ name: "verify", origin: "user" }]}
      commands={[{ name: "restore", autoRun: true }]}
      isMobile={false}
      onPick={onPick}
      onClose={() => {}}
    />,
  );
  const filter = view.container.querySelector("input")!;
  expect(document.activeElement).toBe(filter);
  fireEvent.change(filter, { target: { value: "verify" } });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("verify", undefined);
});

it("selects an exact name even when it is in a later group", () => {
  const onPick = mock(() => {});
  render(
    <SkillsPopover
      skills={[{ name: "re", origin: "user" }]}
      commands={[{ name: "restore", autoRun: true }]}
      isMobile={false}
      draftFilter="re"
      onPick={onPick}
      onClose={() => {}}
    />,
  );
  fireEvent.keyDown(document.body, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith("re", undefined);
});

it("fits the mobile menu to the visual viewport and contains list scrolling", () => {
  const viewport = installVisualViewport({ height: 360, offsetTop: 40 });
  const view = render(
    <SkillsPopover
      skills={[{ name: "verify", origin: "user" }]}
      commands={[]}
      isMobile={true}
      draftFilter=""
      onPick={() => {}}
      onClose={() => {}}
    />,
  );
  const popover = view.container.firstElementChild as HTMLDivElement;
  popover.getBoundingClientRect = () => ({ bottom: 330 }) as DOMRect;
  act(() => viewport.dispatch("resize"));

  expect(popover.style.maxHeight).toBe("162px");
  const list = view.container.querySelector(
    "[data-skills-scroll]",
  ) as HTMLDivElement;
  expect(list.style.overscrollBehavior).toBe("contain");
});
