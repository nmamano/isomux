// A credential field that password managers leave alone and that never shows
// its value (ui/components/MaskedInput.tsx).

import { expect } from "bun:test";

export function expectMasked(input: HTMLInputElement | null) {
  expect(input).not.toBeNull();
  const field = input!;
  expect(field.hasAttribute("data-masked-credential")).toBe(true);
  expect(field.autocomplete).toBe("off");
  for (const ignore of [
    "data-1p-ignore",
    "data-lpignore",
    "data-bwignore",
    "data-form-type",
  ])
    expect(field.hasAttribute(ignore)).toBe(true);
  // Masked by CSS on a text field, or a password field where CSS cannot.
  const how = field.getAttribute("data-masked-credential");
  expect(
    (how === "password" && field.type === "password") ||
      (how === "css" && field.type === "text"),
  ).toBe(true);
}
