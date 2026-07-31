// Shared rejection assertion for the test tiers. Bun's
// `expect(promise).rejects.toThrow(...)` is typed as returning `void`
// (bun-types gap), so `await`-ing it trips @typescript-eslint/await-thenable
// even though the runtime returns a thenable. This helper awaits the promise,
// fails if it resolved, and matches the rejection's message against a pattern -
// portable and lint-clean. Only imported by test files (runs under `bun test`).
import { expect } from "bun:test";

export async function expectRejection(
  p: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect((err as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected promise to reject, but it resolved");
}
