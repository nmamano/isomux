import { describe, expect, it } from "bun:test";
import { injectedMemorySize } from "./memory-size.ts";

describe("injected memory size", () => {
  it("matches prompt injection: blank lines drop, newlines join, UTF-16 counts", () => {
    expect(injectedMemorySize("one\n   \n😀\n")).toBe("one\n😀".length);
    expect(injectedMemorySize("one\n   \n😀\n")).toBe(6);
  });
});
