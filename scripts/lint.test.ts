import { expect, it } from "bun:test";
import { eslintCommand, eslintNodeOptions } from "./lint";

it("checks the entire tree in one process and supports fixes", () => {
  expect(eslintCommand(false)).toEqual([
    "bun",
    "x",
    "eslint",
    ".",
    "--concurrency=off",
  ]);
  expect(eslintCommand(true)).toEqual([
    "bun",
    "x",
    "eslint",
    ".",
    "--concurrency=off",
    "--fix",
  ]);
});

it("preserves other Node options and supplies the lint heap limit", () => {
  expect(eslintNodeOptions("--trace-warnings")).toBe(
    "--trace-warnings --max-old-space-size=4096",
  );
});
