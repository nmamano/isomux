// bun test preload (wired in bunfig.toml). Runs ONCE per test process, before
// any test file imports server/config.ts, so STATE_ROOT resolves to a throwaway
// temp dir for the whole run. Two payoffs:
//   - T1 tests can boot the real server (server/test-support/harness.ts) against
//     temp state instead of the live ~/.isomux.
//   - The DI disk assertions no longer need to win an import-time race to set
//     ISOMUX_HOME (they were skipped in shared runs precisely because they lost
//     it); with ISOMUX_HOME preset, STATE_ROOT is already a temp dir.
//
// IMPORTANT: this file must NOT import server/config.ts. config.ts resolves
// STATE_ROOT once at import; importing it here (directly or transitively) before
// we set ISOMUX_HOME would freeze STATE_ROOT to the real home. temp-state.ts
// pulls in only os/fs/path, so it is safe to import.
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, sep } from "path";
import { canonicalize, removeStateDir } from "./temp-state.ts";

// Symlink-aware safety check for an explicitly-set ISOMUX_HOME. Reuses
// temp-state's canonicalize (realpath of the nearest existing ancestor) so a
// symlink like /tmp/x -> ~/.isomux cannot slip a real-state path past a lexical
// check; then requires the resolved path to live strictly under the OS temp dir.
function assertSafeTestHome(home: string): void {
  const canonical = canonicalize(home);
  const realHome = canonicalize(join(homedir(), ".isomux"));
  if (canonical === realHome || canonical.startsWith(realHome + sep)) {
    throw new Error(
      `[test preload] ISOMUX_HOME (${home}) resolves to the real ~/.isomux ` +
        `(${realHome}); refusing to run the test suite against real user state.`,
    );
  }
  const realTmp = canonicalize(tmpdir());
  if (!canonical.startsWith(realTmp + sep)) {
    throw new Error(
      `[test preload] ISOMUX_HOME (${home}) resolves to ${canonical}, which is ` +
        `not strictly under the OS temp dir (${realTmp}); test homes must be ` +
        `temp dirs.`,
    );
  }
}

const preset = process.env.ISOMUX_HOME?.trim();
if (preset) {
  // Honor an explicit override (e.g. a dedicated temp home for `test:live`),
  // but only if it is canonical-safe and strictly under the OS temp dir.
  assertSafeTestHome(preset);
  // Not ours to delete (we did not create it); leave cleanup to its owner.
} else {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "isomux-test-home-"));
  process.env.ISOMUX_HOME = home;
  // Best-effort guarded cleanup after the whole suite. Bun's test runner does
  // NOT fire preload-registered process "exit"/"beforeExit" handlers (verified:
  // they silently never run), so the prior process.on("exit") cleanup leaked one
  // temp home per `bun test` invocation. A preload-level afterAll runs once after
  // all tests, on the runner's own lifecycle. removeStateDir refuses any target
  // not strictly under the OS temp dir (and the real ~/.isomux), so a misconfig
  // fails loudly rather than wiping user state.
  afterAll(() => {
    try {
      removeStateDir(home);
    } catch {
      // Swallow: the guard already prevents unsafe deletes; a leftover temp dir
      // is harmless and gets reaped by the OS.
    }
  });
}
