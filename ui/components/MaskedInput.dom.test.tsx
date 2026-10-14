// The credential field: masked by CSS where the browser can, type=password
// where it cannot, and never a password field to a password manager.

import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { expectMasked } from "../test-support/masked.ts";

setUpDomTestFile();

const { fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { MaskedInput } = await import("./MaskedInput.tsx");

// A spy on happy-dom's CSS.supports does not reach the component, so each
// test puts its own CSS object in place.
const realCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
afterEach(() => {
  if (realCss) Object.defineProperty(globalThis, "CSS", realCss);
});

function field(cssMask: boolean) {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: {
      supports: (property: string) =>
        cssMask && property === "-webkit-text-security",
    },
  });
  const view = render(
    createElement(MaskedInput, {
      value: "sk-123",
      onChange: () => {},
      style: { width: 100 },
    }),
  );
  return view.container.querySelector("input")!;
}

it("is a text field masked by CSS where the browser has the mask", () => {
  const input = field(true);
  expectMasked(input);
  expect(input.type).toBe("text");
  expect(input.style.width).toBe("100px");
});

it("falls back to a password field where it has not", () => {
  const input = field(false);
  expectMasked(input);
  expect(input.type).toBe("password");
});

it("blocks copy and cut, as a password field does", () => {
  const input = field(true);
  expect(fireEvent.copy(input)).toBe(false);
  expect(fireEvent.cut(input)).toBe(false);
});
