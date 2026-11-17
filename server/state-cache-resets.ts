// The resets of the in-memory caches that load from STATE_ROOT. A module
// registers its reset when it loads; the test preload runs them all before
// and after each test, so a cache never outlives a test that wiped the disk
// under it. In production the list fills and nobody reads it.
// No imports: the preload loads this before any test imports config.ts.

const resets: (() => void)[] = [];

export function registerStateCacheReset(reset: () => void): void {
  resets.push(reset);
}

export function _testResetStateCaches(): void {
  for (const reset of resets) reset();
}
