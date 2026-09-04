// Single source of truth for the T3 "live" test gate. Live tests make real
// LLM/provider/network calls, so they are OFF by default: `bun test` (CI,
// pre-commit) sees LIVE === false and every live test self-skips. The
// `test:live` package.json script sets ISOMUX_TEST_LIVE=1 to turn them on.
//
// Usage in a live test file:
//   import { LIVE } from "../test-support/live-gate.ts";
//   describe.skipIf(!LIVE)("...live...", () => { ... });
// or it.skipIf(!LIVE)("...", ...). Gating on this constant (rather than an
// ad-hoc env read) keeps the skip uniform and greppable. No live tests exist
// yet; this establishes the seam for future live tests.
export const LIVE: boolean = !!process.env.ISOMUX_TEST_LIVE;
