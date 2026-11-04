// The globals of a bun test process before any test file runs. The bunfig
// preload records them as its last step, and ui/test-support/dom.ts compares
// against them, so a global that any file changed before the first DOM file is
// a change and not part of the baseline. The preload and the test files share
// this module's one instance.

export type Globals = Map<string, PropertyDescriptor>;

export function snapshotGlobals(): Globals {
  return new Map(Object.entries(Object.getOwnPropertyDescriptors(globalThis)));
}

let recorded: Globals | null = null;

/** Called once, at the end of server/test-support/preload.ts. */
export function recordStartGlobals(): void {
  recorded = snapshotGlobals();
}

/** What the preload recorded, or null in a run without it. */
export function startGlobals(): Globals | null {
  return recorded;
}
