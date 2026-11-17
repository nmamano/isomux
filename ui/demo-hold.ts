// The demo's hold switch for scripts/loading-check.sh (task d3593a12). While
// held, the demo server answers nothing: each wrapped call waits and runs, in
// call order, at release. With no hold, a wrapped call runs at once, inside
// the call, so the shipped demo keeps its order of emits. Nothing in the
// shipped demo holds; only the script does, through window.__isomuxDemoHold.

type Queued = () => void;

let queue: Queued[] | null = null;

/** Start holding: wrapped calls queue until release(). */
export function hold(): void {
  if (queue === null) queue = [];
}

/** Stop holding: run the queued calls in call order; later calls run at once. */
export function release(): void {
  const pending = queue;
  queue = null;
  for (const run of pending ?? []) run();
}

/** Wrap fn so that it waits for the hold. */
export function held<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => Promise<Awaited<R>> {
  return (...args: A) => {
    if (queue === null) return Promise.resolve(fn(...args));
    const waiting = queue;
    return new Promise<Awaited<R>>((resolve, reject) => {
      waiting.push(() => {
        try {
          resolve(fn(...args) as Awaited<R>);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  };
}
