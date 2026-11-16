// Long walks use sync fs calls (an await per file costs ~50 s for 167k
// files) and give the event loop a turn every YIELD_EVERY entries and at
// least every YIELD_MS, so the server keeps answering.
const YIELD_EVERY = 1000;
const YIELD_MS = 20;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function pacer(): () => Promise<void> | undefined {
  let n = 0;
  let last = performance.now();
  return () => {
    if (++n % YIELD_EVERY !== 0 && performance.now() - last < YIELD_MS)
      return undefined;
    return yieldToLoop().then(() => {
      last = performance.now();
    });
  };
}
