import { describe, expect, it } from "bun:test";
import { CSS } from "./styles.ts";

describe("editable control ligatures", () => {
  it("keeps the shared editable-control rule free of contextual ligatures", () => {
    expect(CSS).toContain(
      "input, select, textarea, button { font-family: inherit; font-variant-ligatures: none; }",
    );
  });
});
