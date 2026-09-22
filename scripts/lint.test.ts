import { expect, it } from "bun:test";
import {
  eslintCommand,
  eslintNodeOptions,
  lintBatches,
  runLintBatches,
} from "./lint";

it("partitions the tree into non-overlapping remainder, UI, and server batches", () => {
  expect(lintBatches).toEqual([
    [".", "--ignore-pattern", "server/**", "--ignore-pattern", "ui/**"],
    ["ui"],
    ["server"],
  ]);
});

it("runs every lint batch serially and preserves the first failure", async () => {
  const calls: string[][] = [];
  const exits = [0, 2, 1];
  let active = 0;
  let concurrent = false;
  const exitCode = await runLintBatches(async (args) => {
    active += 1;
    if (active > 1) concurrent = true;
    calls.push([...args]);
    await Bun.sleep(1);
    active -= 1;
    return exits[calls.length - 1]!;
  });

  expect(calls).toEqual(lintBatches);
  expect(concurrent).toBe(false);
  expect(exitCode).toBe(2);
});

it("disables ESLint workers and applies the bounded heap to check and fix", () => {
  expect(eslintCommand(["ui"], false)).toEqual([
    "bun",
    "x",
    "eslint",
    "ui",
    "--concurrency=off",
  ]);
  expect(eslintCommand(["server"], true)).toEqual([
    "bun",
    "x",
    "eslint",
    "server",
    "--concurrency=off",
    "--fix",
  ]);
  expect(eslintNodeOptions("--trace-warnings")).toBe(
    "--trace-warnings --max-old-space-size=1600",
  );
});
