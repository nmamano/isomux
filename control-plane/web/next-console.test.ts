// Next's console wrapper works whatever order the test files load Next in.
//
// next/navigation builds Next's work-unit store when it loads, from
// globalThis.AsyncLocalStorage, and falls back to a fake whose exit() throws.
// next/dist/server/node-environment sets that global and then wraps each
// console method in the store's exit(). Bun runs many test files in one
// process, so a file that loads next/navigation before another file loads
// node-environment made every later console call throw. This file loads them
// in that order itself, so it does not depend on which files ran before it.

import { expect, spyOn, test } from "bun:test";

test("a console call works after next/navigation loads before node-environment", async () => {
  await import("next/navigation");
  await import("next/dist/server/node-environment");
  const { workUnitAsyncStorage } =
    await import("next/dist/server/app-render/work-unit-async-storage.external");

  const exit = spyOn(workUnitAsyncStorage, "exit");
  let thrown: unknown;
  let exitCalls: number;
  try {
    // groupEnd goes through the same wrapper as console.error and prints nothing.
    console.groupEnd();
  } catch (err) {
    thrown = err;
  } finally {
    exitCalls = exit.mock.calls.length;
    exit.mockRestore();
  }

  // The call went through Next's wrapper, so the store's exit() ran.
  expect(exitCalls).toBe(1);
  expect((thrown as Error | undefined)?.message).toBeUndefined();
});
