// Module state that outlives one test file: bun runs many files in one
// process, and a module is evaluated once per process. A module whose state
// one file can leave behind registers its reset here, at module scope; the
// DOM test harness (ui/test-support/dom.ts) runs every registered reset at the
// start of each DOM file. Only modules that some file loaded have registered,
// so the harness never loads app code itself.

const resets = new Set<() => void>();

/** Registers a reset that runs before each DOM test file. */
export function resetBetweenTestFiles(reset: () => void): void {
  resets.add(reset);
}

/** Runs every registered reset. Called by the DOM test harness. */
export function runTestFileResets(): void {
  for (const reset of resets) reset();
}
