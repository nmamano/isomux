// The lobby elevator as a control (task 5a1891f9): only the live lobby passes
// onOpenElevator, and only then is the drawn elevator clickable and does a
// keyboard button sit over it. The editor and the preview pass nothing.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../../test-support/dom.ts";
setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LobbyScene } = await import("./LobbyScene.tsx");
const { SceneDecorationContext } = await import("../scene-decoration.tsx");

// The scene's props layer: the svg that holds the lobby's own gradients.
const propsLayer = (container: HTMLElement) =>
  container.querySelector("#lobby-fire-glow")!.closest("svg")!;
// Clickable props in the props layer (the record player is off here).
const clickable = (container: HTMLElement) =>
  propsLayer(container).querySelectorAll("[data-no-pan]");
const keyControls = (container: HTMLElement) =>
  container.querySelectorAll('[data-lobby-control="elevator"]');

const scene = (
  onOpenElevator?: () => void,
  layout: "nilo" | "fireside" = "nilo",
) =>
  createElement(LobbyScene, {
    rooms: [],
    officeName: null,
    mode: "dark",
    layout,
    ...(onOpenElevator ? { onOpenElevator } : {}),
  });

describe("elevator in the lobby", () => {
  it("is a control only when the live lobby passes onOpenElevator", () => {
    const off = render(scene());
    expect(clickable(off.container).length).toBe(0);
    expect(keyControls(off.container).length).toBe(0);
    off.unmount();

    let opened = 0;
    const on = render(scene(() => opened++));
    expect(clickable(on.container).length).toBe(1);
    expect(keyControls(on.container).length).toBe(1);
    act(() => {
      clickable(on.container)[0].dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(opened).toBe(1);
    on.unmount();
  });

  it("opens from its keyboard button on Enter and on Space", () => {
    let opened = 0;
    const view = render(scene(() => opened++));
    expect(keyControls(view.container).length).toBe(1);
    const button = keyControls(view.container)[0];
    expect(button.getAttribute("role")).toBe("button");
    expect(button.getAttribute("tabindex")).toBe("0");
    expect((button.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
    for (const key of ["Enter", " "]) {
      let notPrevented = true;
      act(() => {
        notPrevented = fireEvent.keyDown(button, { key });
      });
      expect(notPrevented).toBe(false);
    }
    expect(opened).toBe(2);
    view.unmount();
  });

  it("has no control where no elevator is drawn", () => {
    // The enabling condition: the same props draw one on the nilo layout.
    const nilo = render(scene(() => {}));
    expect(keyControls(nilo.container).length).toBe(1);
    nilo.unmount();
    // A layout without an elevator.
    const other = render(scene(() => {}, "fireside"));
    expect(keyControls(other.container).length).toBe(0);
    other.unmount();
    // The scenery is off, so the elevator is not drawn.
    const bare = render(
      createElement(SceneDecorationContext.Provider, { value: false }, [
        createElement(LobbyScene, {
          key: "scene",
          rooms: [],
          officeName: null,
          mode: "dark",
          layout: "nilo",
          onOpenElevator: () => {},
          receptionist: { node: createElement("circle", { r: 1 }) },
        }),
      ]),
    );
    expect(keyControls(bare.container).length).toBe(0);
    bare.unmount();
  });
});
