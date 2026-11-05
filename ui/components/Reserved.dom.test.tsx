// Reserved holds the space of content that is still loading. By default the
// held content does not paint; with `dim` it paints grayed out, so the member
// sees the real layout waiting (task a10fd923, Nil at the sign-off of
// eeec205a). Either way it takes no focus and is not read out.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { Reserved } = await import("./Reserved.tsx");

function held(dim: boolean): HTMLElement {
  const view = render(
    // The other callers leave the prop out.
    <Reserved dim={dim || undefined}>
      <button>held</button>
    </Reserved>,
  );
  const block = view.container.querySelector<HTMLElement>("[data-reserved]");
  if (!block) throw new Error("no held block");
  expect(block.getAttribute("aria-hidden")).toBe("true");
  expect(block.hasAttribute("inert")).toBe(true);
  expect(block.querySelector("button")).not.toBeNull();
  return block;
}

it("without dim, the held content does not paint", () => {
  const block = held(false);
  expect(block.style.visibility).toBe("hidden");
  expect(block.style.opacity).toBe("");
});

it("with dim, the held content paints at reduced opacity", () => {
  const block = held(true);
  expect(block.style.visibility).not.toBe("hidden");
  const opacity = Number(block.style.opacity);
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
});
