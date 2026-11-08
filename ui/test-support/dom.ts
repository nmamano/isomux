// Render-test harness for the UI: happy-dom plus @testing-library/react,
// registered per test file. Never through the bunfig preload - that one serves
// the server suite, which must keep Bun's own globals. The preload only records
// those globals (start-globals.ts), as the baseline for the leak checks below.
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
//
// Module state outlives a file too: a module is evaluated once per process.
// A module whose state one file can leave behind registers a reset with
// ui/test-file-resets.ts, and the harness runs every registered reset at the
// start of each DOM file, so the state an earlier file left (DOM or not) never
// reaches this one's tests.

import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type Globals,
  snapshotGlobals,
  startGlobals,
} from "./start-globals.ts";
import { runTestFileResets } from "../test-file-resets.ts";

type MatcherUtils = {
  printExpected(value: unknown): string;
  printReceived(value: unknown): string;
};

type NodeShape = {
  nodeType: number;
  nodeName: string;
  getAttribute?: (name: string) => string | null;
};

function isNodeShape(value: unknown): value is NodeShape {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NodeShape>;
  return (
    Number.isInteger(candidate.nodeType) &&
    typeof candidate.nodeName === "string"
  );
}

function describeNode(node: NodeShape): string {
  if (node.nodeType !== 1) return node.nodeName.toLowerCase();
  const id = node.getAttribute?.("id");
  const classes = node
    .getAttribute?.("class")
    ?.trim()
    .split(/\s+/)
    .filter(Boolean);
  const marker = ["data-testid", "role", "aria-label"]
    .map((name) => [name, node.getAttribute?.(name)] as const)
    .find(([, value]) => value);
  return `<${node.nodeName.toLowerCase()}${id ? `#${id}` : ""}${
    classes?.length ? `.${classes.join(".")}` : ""
  }${marker ? ` ${marker[0]}=${JSON.stringify(marker[1])}` : ""}>`;
}

function received(value: unknown, utils: MatcherUtils): string {
  return isNodeShape(value) ? describeNode(value) : utils.printReceived(value);
}

function expected(value: unknown, utils: MatcherUtils): string {
  return isNodeShape(value) ? describeNode(value) : utils.printExpected(value);
}

let compactMatchersRegistered = false;

/**
 * Keeps Bun from serializing a happy-dom node's document and window graph when
 * a basic identity or absence assertion fails. These replace built-ins, so
 * their pass conditions must remain exactly the same as Bun's.
 */
function registerCompactDomMatchers(): void {
  if (compactMatchersRegistered) return;
  expect.extend({
    toBe(actual: unknown, wanted: unknown) {
      const pass = Object.is(actual, wanted);
      return {
        pass,
        message: () =>
          `expected ${received(actual, this.utils)} ${pass ? "not " : ""}to be ${expected(wanted, this.utils)}`,
      };
    },
    toBeNull(actual: unknown) {
      const pass = actual === null;
      return {
        pass,
        message: () =>
          `expected ${received(actual, this.utils)} ${pass ? "not " : ""}to be null`,
      };
    },
    toBeUndefined(actual: unknown) {
      const pass = actual === undefined;
      return {
        pass,
        message: () =>
          `expected ${received(actual, this.utils)} ${pass ? "not " : ""}to be undefined`,
      };
    },
    toBeFalsy(actual: unknown) {
      const pass = !actual;
      return {
        pass,
        message: () =>
          `expected ${received(actual, this.utils)} ${pass ? "not " : ""}to be falsy`,
      };
    },
  });
  compactMatchersRegistered = true;
}

registerCompactDomMatchers();

// Requests sent through happy-dom's fetch or XMLHttpRequest since the current
// file set up. None leaves the process: a DOM test that needs a response gives
// the file setApiShim() or a fetch stub, and the harness fails a file that
// sends one, naming each "<METHOD> <url>". The rejection is a TypeError, as
// from a browser that is offline, so app code takes its normal failure path.
const refusedRequests: string[] = [];

function refuse(request: { method: string; url: string }): never {
  refusedRequests.push(`${request.method} ${request.url}`);
  throw new TypeError(
    `Failed to fetch ${request.url}: a DOM test sends no real requests`,
  );
}

/** Returns true when it registered a new window. */
function register(): boolean {
  const fresh = !GlobalRegistrator.isRegistered;
  if (fresh)
    GlobalRegistrator.register({
      url: "http://localhost/",
      settings: {
        fetch: {
          interceptor: {
            beforeAsyncRequest: async ({ request }) => refuse(request),
            beforeSyncRequest: ({ request }) => refuse(request),
          },
        },
      },
    });
  forwardSchedulers();
  stubMissingBrowserApis();
  return fresh;
}

// The window's timer and microtask entry points, which a closed happy-dom
// window turns into no-ops. A module is evaluated once per bun process, so
// react-dom keeps the queueMicrotask and setTimeout of the window that was
// registered when the first DOM file loaded it. In every later file in the
// process, React's root-scheduling microtask went to a closed window and was
// dropped: an update outside act() never committed (task 76d20063, measured
// 2026-10-07). So each registration puts a forwarder on globalThis that calls
// the current window's own function. What a module captures is the forwarder,
// and it reaches whichever window is open now.
const WINDOW_SCHEDULERS = [
  "queueMicrotask",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
type Scheduler = (...args: unknown[]) => unknown;
const bunSchedulers = new Map<string, unknown>(
  WINDOW_SCHEDULERS.map((name) => [
    name,
    (globalThis as Record<string, unknown>)[name],
  ]),
);
const windowSchedulers = new Map<string, Scheduler>();
const forwarders = new Map<string, Scheduler>(
  WINDOW_SCHEDULERS.map((name) => [
    name,
    (...args: unknown[]) => windowSchedulers.get(name)!(...args),
  ]),
);

function forwardSchedulers(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const name of WINDOW_SCHEDULERS) {
    const current = globals[name];
    // Only what happy-dom put there: its unregister then restores Bun's own,
    // so no forwarder outlives the file.
    if (
      typeof current !== "function" ||
      current === forwarders.get(name) ||
      current === bunSchedulers.get(name)
    )
      continue;
    windowSchedulers.set(name, current as Scheduler);
    Object.defineProperty(globals, name, {
      value: forwarders.get(name),
      writable: true,
      configurable: true,
    });
  }
}

// What we put on globalThis ourselves, and therefore have to take back off.
// GlobalRegistrator captures the global property set when it registers, so a
// stub added afterwards survives its unregister: only we can remove it.
const stubbed = new Set<string>();

/**
 * Stand-ins for browser APIs happy-dom does not implement but the app reaches
 * for anyway. Kept to what a test actually trips over, and only ever added when
 * absent, so a happy-dom that grows its own is never overridden.
 *
 * AudioContext: ui/store.tsx opens one on the first click anywhere in the
 * document, for the notification sound. Without this, every DOM test that
 * clicks throws inside a once-only listener, where the error is unhandled and
 * reads as if the click failed. A test that needs a sound to actually play will
 * have to grow this beyond construction.
 */
function stubMissingBrowserApis(): void {
  const globals = globalThis as Record<string, unknown>;
  if (globals.AudioContext === undefined) {
    globals.AudioContext = class AudioContextStub {};
    stubbed.add("AudioContext");
  }
}

function removeStubs(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const name of stubbed) delete globals[name];
  stubbed.clear();
}

// Globals a module sets once per process, at its first import, and never takes
// back: not a leak of whichever file happened to import it first.
const PROCESS_GLOBALS = new Set([
  // @testing-library/react, at its import in this module's body.
  "IS_REACT_ACT_ENVIRONMENT",
  // zod's global config and registry, at the first import of zod.
  "__zod_globalConfig",
  "__zod_globalRegistry",
]);

function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return Object.is(a.value, b.value) && a.get === b.get && a.set === b.set;
}

/** The globals that differ from `baseline`: added, removed or replaced. */
function changedGlobals(baseline: Globals): string[] {
  const now = snapshotGlobals();
  const changed = new Set<string>();
  for (const [name, descriptor] of now) {
    const before = baseline.get(name);
    if (!before || !sameDescriptor(before, descriptor)) changed.add(name);
  }
  for (const name of baseline.keys()) if (!now.has(name)) changed.add(name);
  return [...changed].filter((name) => !PROCESS_GLOBALS.has(name)).sort();
}

function restoreGlobals(baseline: Globals, names: string[]): void {
  const globals = globalThis as Record<string, unknown>;
  for (const name of names) {
    const descriptor = baseline.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globals[name];
  }
}

/** The test file that called into this module: the first frame outside it. */
function callerPath(): string {
  for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
    const path = /\(?((?:file:\/\/)?\/[^\s()]+?):\d+:\d+\)?$/.exec(line)?.[1];
    if (path && path !== import.meta.path) return path;
  }
  return "an unknown test file";
}

/** One DOM test file, from its setUpDomTestFile() to the end of its teardown. */
type DomFile = {
  path: string;
  /** The globals before this file registered a window. */
  before: Globals;
  /** The globals once the window was up, with the harness's own stubs. */
  window: Globals;
  /** What stubGlobal() replaced, by name: the descriptor before its first call. */
  stubs: Map<string, PropertyDescriptor | undefined>;
};

let currentFile: DomFile | null = null;
let lastDomFile: string | null = null;

// Bun's own globals, as the preload recorded them before any test file ran.
// Without the preload, the earliest point left is this module's first load.
const bunGlobals = startGlobals() ?? snapshotGlobals();

// What files that ran before this module loaded left changed. The harness
// puts Bun's back now, and the first DOM file reports them.
const leftBeforeHarness = changedGlobals(bunGlobals);
restoreGlobals(bunGlobals, leftBeforeHarness);

function leftByEarlierFile(left: string[], path: string): string {
  return (
    `An earlier file in this bun process left these globals changed: ${left.join(", ")}. ` +
    `The harness put Bun's back. ${path} did not change them: look at ` +
    (lastDomFile
      ? `${lastDomFile}, the last DOM file, or a file that ran after it and does not use this harness.`
      : `a file that ran before this one and does not use this harness.`)
  );
}

// This module's own body is the earliest point at which a DOM can exist, and it
// runs before the importing test file's body, so registering here and THEN
// resolving @testing-library/react keeps that library's evaluation at module
// scope. It must not be evaluated from inside a hook: its module body calls
// beforeAll, and bun rejects that with "Cannot call beforeAll() inside a test".
register();
const { cleanup } = await import("@testing-library/react");

/**
 * Wall-clock budget for one DOM test file. Nil's constraint on this harness:
 * DOM tests stay cheap enough that nobody has to think about them in ci. A
 * warm App render costs about 275 ms, so a file has room for a page of
 * routing tests and none for a browser.
 */
export const DOM_TEST_CAP_MS = 5000;

/**
 * Sets a global for the rest of this test file. The harness puts the value
 * that was there before back when the file ends, before it checks for leaks.
 * Call it after setUpDomTestFile().
 */
export function stubGlobal(name: string, value: unknown): void {
  if (!currentFile)
    throw new Error(
      `stubGlobal("${name}") needs setUpDomTestFile() first, in the same file`,
    );
  if (!currentFile.stubs.has(name))
    currentFile.stubs.set(
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    );
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function restoreStubGlobals(file: DomFile): void {
  const globals = globalThis as Record<string, unknown>;
  for (const [name, descriptor] of file.stubs) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globals[name];
  }
  file.stubs.clear();
}

/**
 * Registers happy-dom for one test file and wires its lifecycle: React cleanup
 * after every test, unregistration after the file, and the wall-clock cap.
 *
 * At the start of the file the harness runs the module resets registered with
 * ui/test-file-resets.ts. At the end of the file it puts back every global the
 * file changed, and fails the file, naming each one, and each request it sent through
 * happy-dom. It also repairs, and fails on, what an earlier file left behind
 * when this file starts. It cannot see a global that a file's own afterAll
 * writes after the harness's afterAll; the next DOM file reports that one.
 * When the harness fails the file, bun 1.4.4 skips the file's later afterAll
 * hooks, as it does after any afterAll that throws.
 *
 * Call it once, in the module body, before any `await import(...)` of UI code.
 * The clock starts here and includes the awaited UI imports below the call.
 * Bun's startup is outside it, so a whole invocation can take longer.
 */
export function setUpDomTestFile({
  capMs = DOM_TEST_CAP_MS,
}: { capMs?: number } = {}): void {
  const startedAt = performance.now();
  const path = callerPath();
  const problems: string[] = [];
  let before = bunGlobals;
  // Registered already only in the first DOM file of the process, by this
  // module's body, so nothing ran in between.
  if (!GlobalRegistrator.isRegistered) {
    const left = changedGlobals(bunGlobals);
    if (left.length) {
      restoreGlobals(bunGlobals, left);
      problems.push(leftByEarlierFile(left, path));
    }
    before = snapshotGlobals();
  } else if (leftBeforeHarness.length) {
    problems.push(leftByEarlierFile(leftBeforeHarness, path));
    leftBeforeHarness.length = 0;
  }
  refusedRequests.length = 0;
  register();
  const file: DomFile = {
    path,
    before,
    window: snapshotGlobals(),
    stubs: new Map(),
  };
  currentFile = file;
  // The body call above covers bun's current load-then-run order. This covers a
  // run that loads every file before executing any test, where another file's
  // afterAll would have unregistered in between.
  beforeAll(() => {
    if (register()) file.window = snapshotGlobals();
    // Module state an earlier file left behind, DOM or not (task 5062bbe5).
    runTestFileResets();
  });
  afterEach(cleanup);
  afterAll(async () => {
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > capMs)
      problems.push(
        `DOM test file took ${Math.round(elapsedMs)} ms, over the ${capMs} ms cap. ` +
          `Cut renders or move the assertion to a plain unit test.`,
      );
    const changed = new Set<string>();
    // Nested try/finally, so the globals come back even when unregister
    // throws: nothing else hands Bun's globals back to whatever runs next.
    try {
      restoreStubGlobals(file);
      // React's scheduler can still hold a task after cleanup, and it reads
      // window when it runs. Run it while the DOM exists: in a process with
      // no file after this one it ran after unregister and failed the file
      // (ui/App.boot.dom.test.tsx, 2026-10-07).
      await new Promise((resolve) => setImmediate(resolve));
      // While the window is up: unregister puts its own keys back, so a
      // window global the file replaced is visible only here.
      for (const name of changedGlobals(file.window)) changed.add(name);
      if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
    } finally {
      removeStubs();
      const left = changedGlobals(file.before);
      restoreGlobals(file.before, left);
      for (const name of left) changed.add(name);
      currentFile = null;
      lastDomFile = path;
    }
    if (changed.size)
      problems.push(
        `${path} left these globals changed: ${[...changed].sort().join(", ")}. ` +
          `Put each back before the file ends (in afterEach or in the test), or set it with stubGlobal(). ` +
          `A restore in the file's own afterAll comes too late: bun runs it after the harness's.`,
      );
    if (refusedRequests.length)
      problems.push(
        `${path} sent requests through happy-dom, which DOM tests refuse: ${refusedRequests.join(", ")}. ` +
          `Give the file setApiShim() or a fetch stub.`,
      );
    if (problems.length) throw new Error(problems.join("\n\n"));
  });
}
