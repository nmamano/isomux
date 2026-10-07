import { expect, it } from "bun:test";
import {
  LINT_RESERVE_BYTES,
  LINT_THREAD_BYTES,
  MAX_LINT_THREADS,
  availableMemory,
  eslintCommand,
  eslintNodeOptions,
  lintConcurrency,
} from "./lint";

it("checks the entire tree in one process and supports fixes", () => {
  expect(eslintCommand(false)).toEqual([
    "bun",
    "x",
    "eslint",
    ".",
    "--concurrency=off",
  ]);
  expect(eslintCommand(true, "3")).toEqual([
    "bun",
    "x",
    "eslint",
    ".",
    "--concurrency=3",
    "--fix",
  ]);
});

it("preserves other Node options and supplies the lint heap limit", () => {
  expect(eslintNodeOptions("--trace-warnings")).toBe(
    "--trace-warnings --max-old-space-size=4096",
  );
});

it("reads MemAvailable, not MemFree", () => {
  expect(
    availableMemory(
      "MemTotal:       24608572 kB\nMemFree:        11821372 kB\nMemAvailable:   18143036 kB\n",
    ),
  ).toBe(18143036 * 1024);
  expect(availableMemory("MemTotal: 1 kB\nMemFree: 1 kB\n")).toBeUndefined();
});

it("adds a lint thread per budget above the reserve, from two to the cap", () => {
  const above = (threads: number) =>
    LINT_RESERVE_BYTES + threads * LINT_THREAD_BYTES;
  expect(lintConcurrency(undefined)).toBe("off");
  expect(lintConcurrency(0)).toBe("off");
  expect(lintConcurrency(above(2) - 1)).toBe("off");
  expect(lintConcurrency(above(2))).toBe("2");
  expect(lintConcurrency(above(3))).toBe("3");
  expect(lintConcurrency(above(MAX_LINT_THREADS + 10))).toBe(
    String(MAX_LINT_THREADS),
  );
});
