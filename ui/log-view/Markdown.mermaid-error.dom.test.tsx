// A mermaid diagram that fails to render shows only the in-chat error card
// (task 27902a10). mermaid.render() draws into a temporary element it
// appends to document.body; on a failed render it used to draw its own error
// graphic there and leave it, so the graphic sat below the chat input.
//
// Pins: after a failed render nothing is left on the page outside the
// rendered message, and mermaid's error graphic is never added to the page,
// not even for a moment (a browser can paint it before the render settles).

import { afterEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, waitFor } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");
// The same module instance Markdown loads lazily, so a spy on it is seen
// by the renderer.
const mermaid = (await import("mermaid")).default;

let renderSpy: ReturnType<typeof spyOn<typeof mermaid, "render">> | null = null;
afterEach(() => {
  renderSpy?.mockRestore();
  renderSpy = null;
});

// Renders one message with a mermaid block and waits until the renderer
// marks the diagram as failed.
async function mountFailed(source: string) {
  const before = new Set(Array.from(document.body.children));
  const view = render(<Markdown content={"```mermaid\n" + source + "\n```"} />);
  const wrapper = view.container.querySelector<HTMLElement>(".mermaid-wrapper");
  if (!wrapper) throw new Error("no mermaid wrapper");
  await waitFor(
    () => expect(wrapper.getAttribute("data-mermaid-error")).toBe("true"),
    { timeout: 2000, interval: 10 },
  );
  // The error card keeps the diagram source for the reader.
  expect(wrapper.textContent).toContain(source);
  // Elements added directly to body by this render, other than the test's
  // own container, as ids or tag names so a failure prints a short list.
  const strays = () =>
    Array.from(document.body.children)
      .filter((c) => c !== view.container && !before.has(c))
      .map((c) => c.id || c.tagName.toLowerCase());
  return { strays };
}

function hasErrorGraphic(node: Node): boolean {
  return (
    node instanceof Element &&
    (node.matches(".error-icon") || node.querySelector(".error-icon") !== null)
  );
}

it("a diagram that does not parse leaves nothing on the page and never draws mermaid's error graphic", async () => {
  const tempDivsAdded: string[] = [];
  let errorGraphicsAdded = 0;
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (/^dmmd-\d+$/.test(node.id)) tempDivsAdded.push(node.id);
        if (hasErrorGraphic(node)) errorGraphicsAdded++;
      }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    const { strays } = await mountFailed("graph TD; A-->");
    // Flush the observer's last records before reading them.
    for (const record of observer.takeRecords())
      for (const node of record.addedNodes)
        if (hasErrorGraphic(node)) errorGraphicsAdded++;
    // Enabling condition: the real mermaid ran and used a temporary element
    // on body, which the observer saw.
    expect(tempDivsAdded).toHaveLength(1);
    expect(errorGraphicsAdded).toBe(0);
    expect(strays()).toEqual([]);
  } finally {
    observer.disconnect();
  }
});

it("a render that throws after adding its temporary element leaves nothing on the page", async () => {
  // mermaid has failure paths that throw without removing its temporary
  // element (for example a throw after the diagram is drawn). This stands
  // in for one of them.
  renderSpy = spyOn(mermaid, "render").mockImplementation(async (id) => {
    const div = document.createElement("div");
    div.id = `d${id}`;
    div.innerHTML = `<svg id="${id}"></svg>`;
    document.body.appendChild(div);
    throw new Error("render failed after drawing");
  });
  const { strays } = await mountFailed("graph TD; A-->B");
  expect(renderSpy).toHaveBeenCalledTimes(1);
  expect(strays()).toEqual([]);
});
