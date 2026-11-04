// Single source of truth for the T3 "live" test gate. Live tests make real
// LLM/provider/network calls, so they are OFF by default: `bun test` (CI,
// pre-commit) sees LIVE === false and every live test self-skips. The
// `test:live` package.json script sets ISOMUX_TEST_LIVE=1 to turn them on.
//
// Usage in a live test file:
//   import { LIVE } from "../test-support/live-gate.ts";
//   describe.skipIf(!LIVE)("...live...", () => { ... });
// or it.skipIf(!LIVE)("...", ...). Gating on this constant (rather than an
// ad-hoc env read) keeps the skip uniform and greppable.
export const LIVE: boolean = !!process.env.ISOMUX_TEST_LIVE;

// The env of a live test that starts a real engine with the box's sign-in.
// The preload gives every run empty Claude and Codex homes and keeps the
// inherited ones in ISOMUX_TEST_INHERITED_*; this puts them back, and leaves
// the variable unset when the process that ran the tests had none.
export function liveEngineEnv(): { [key: string]: string | undefined } {
  const env = { ...process.env };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    const inherited = process.env[`ISOMUX_TEST_INHERITED_${name}`];
    if (inherited === undefined) delete env[name];
    else env[name] = inherited;
  }
  return env;
}
