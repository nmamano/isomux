// The stop of each agent manager made in this process. The test preload clears
// the list before each test and, after it, stops what that test made, so a
// manager from an ended test writes no transcript over the next test's state.
// A manager made at a file's top level or in beforeAll is cleared before the
// first test and so never stopped by the preload. In production the list holds
// the one office manager and nobody reads it.
// No imports: the preload loads this before any test imports config.ts.

const stops: (() => void)[] = [];

export function registerAgentManagerStop(stop: () => void): void {
  stops.push(stop);
}

export function _testClearAgentManagerStops(): void {
  stops.length = 0;
}

export function _testStopAgentManagers(): void {
  const due = stops.splice(0);
  for (const stop of due) stop();
}
