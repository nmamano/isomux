// Render-test harness for the UI: happy-dom plus @testing-library/react,
// registered per test file. Never through the bunfig preload - that one serves
// the server suite, which must keep Bun's own globals.
//
// Two measured facts (2026-09-05; bun 1.3.11, happy-dom 20.14.0) give this
// module its shape.
//
// 1. The globals have to be gone again when the file ends. happy-dom replaces
//    globalThis.WebSocket, and server/test-support/harness.ts constructs one,
//    so a DOM file that leaves its globals behind fails three server tests
//    later in the same `bun test` process.
// 2. Registration cannot ride on this module's import. bun loads and runs test
//    files one at a time, and not in the order given on the command line, so a
//    later DOM file finds this module cached, its top-level side effect already
//    spent, and the DOM already unregistered by the file before it.
//
// So a test file statically imports nothing but bun:test and this module, calls
// setUpDomTestFile() in its body, and then loads @testing-library/react and
// every module under test with `await import(...)`. bun evaluates a file's
// static imports before its body, so a static import evaluates DOM-sensitive
// code too early. That is not always a crash, which is what makes it worth a
// rule: ui/store.tsx reads window.innerWidth at module scope behind a `typeof
// window` guard, so without a DOM it silently records the wrong viewport
// instead of failing.
//
//     import { describe, expect, it } from "bun:test";
//     import { setUpDomTestFile } from "./test-support/dom.ts";
//
//     setUpDomTestFile();
//
//     const { act, render } = await import("@testing-library/react");
//     const { App } = await import("./App.tsx");

import { afterAll, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Wall-clock budget for one DOM test file. Nil's constraint on this harness:
 * DOM tests stay cheap enough that nobody has to think about them in ci. A
 * warm App render costs about 275 ms, so a file has room for a page of
 * routing tests and none for a browser.
 */
export const DOM_TEST_CAP_MS = 5000;

function register(): void {
  if (!GlobalRegistrator.isRegistered)
    GlobalRegistrator.register({ url: "http://localhost/" });
}

/**
 * Registers happy-dom for one test file and wires its lifecycle: React cleanup
 * after every test, unregistration after the file, and the wall-clock cap.
 *
 * Call it once, in the module body, before any `await import(...)` of UI code.
 * The clock starts here, so it measures the file's own time - bun's startup and
 * transpile land outside it and the whole `bun test` invocation always reads
 * longer than the cap allows for.
 */
export function setUpDomTestFile({
  capMs = DOM_TEST_CAP_MS,
}: { capMs?: number } = {}): void {
  const startedAt = performance.now();
  register();
  // The body call above covers bun's current load-then-run order. This covers a
  // run that loads every file before executing any test, where another file's
  // afterAll would have unregistered in between.
  beforeAll(register);
  // Imported here rather than at the top of the module: @testing-library/react
  // must not be evaluated before a DOM exists, and by the first afterEach one
  // always does.
  afterEach(async () => {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
  });
  afterAll(async () => {
    const elapsedMs = performance.now() - startedAt;
    // try/finally, not sequence: a file that blows its budget still has to hand
    // Bun's globals back to whatever runs next.
    try {
      if (elapsedMs > capMs)
        throw new Error(
          `DOM test file took ${Math.round(elapsedMs)} ms, over the ${capMs} ms cap. ` +
            `Cut renders or move the assertion to a plain unit test.`,
        );
    } finally {
      if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
    }
  });
}
