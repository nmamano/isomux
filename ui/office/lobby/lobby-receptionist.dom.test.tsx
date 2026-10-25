// The receptionist's keyboard button. The props layer that draws the figure
// stays hidden from screen readers, so the button lives outside it.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../../test-support/dom.ts";
setUpDomTestFile();
const { fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LobbyScene } = await import("./LobbyScene.tsx");

const figure = () => createElement("circle", { "data-figure": "1", r: 1 });

const scene = (receptionist?: {
  node: ReturnType<typeof figure>;
  button?: { name: string; onOpen: () => void };
}) =>
  createElement(LobbyScene, {
    rooms: [],
    officeName: null,
    mode: "dark",
    layout: "nilo",
    receptionist,
  });

const controls = (c: HTMLElement) =>
  c.querySelectorAll('[data-lobby-control="receptionist"]');

describe("receptionist button in the lobby", () => {
  it("opens the chat on Enter and Space, outside the hidden props layer", () => {
    let opened = 0;
    const view = render(
      scene({
        node: figure(),
        button: { name: "Ada", onOpen: () => opened++ },
      }),
    );
    // The figure is still drawn in the props layer, which stays hidden.
    const drawn = view.container.querySelector("[data-figure]")!;
    expect(drawn.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(controls(view.container).length).toBe(1);
    const button = controls(view.container)[0];
    expect(button.getAttribute("role")).toBe("button");
    expect(button.getAttribute("tabindex")).toBe("0");
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
    expect(button.getAttribute("aria-label")).toContain("Ada");
    // Another key does nothing.
    fireEvent.keyDown(button, { key: "a" });
    expect(opened).toBe(0);
    // fireEvent returns false when the handler prevented the default, so
    // Space does not also scroll the page.
    expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(false);
    expect(opened).toBe(1);
    expect(fireEvent.keyDown(button, { key: " " })).toBe(false);
    expect(opened).toBe(2);
    view.unmount();
  });

  it("has no button without a chat to open", () => {
    // The editor draws the figure with no button; the preview draws neither.
    const editor = render(scene({ node: figure() }));
    expect(editor.container.querySelector("[data-figure]")).not.toBeNull();
    expect(controls(editor.container).length).toBe(0);
    editor.unmount();
    const preview = render(scene());
    expect(preview.container.querySelector("svg")).not.toBeNull();
    expect(controls(preview.container).length).toBe(0);
    preview.unmount();
  });
});
