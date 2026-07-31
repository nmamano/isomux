#!/usr/bin/env bun
// Regenerate the codex JSON-RPC TS schemas under
// server/backends/codex/_generated using the bundled @openai/codex launcher.
//
// Runs the launcher's `app-server generate-ts --experimental` and writes to
// the _generated directory. Schema regen does NOT need auth, so we don't set
// CODEX_HOME - just the binary path. Pinning runtime to the bundled package
// would be defeated if codegen still shelled out to a global codex, so this
// script must stay in sync with the runtime spawn path.

import { spawnSync } from "child_process";

import { resolveCodexLauncherPath } from "../server/backends/codex/native-bin.ts";

const launcher = resolveCodexLauncherPath();

const args = [
  launcher,
  "app-server",
  "generate-ts",
  "--out",
  "server/backends/codex/_generated",
  "--experimental",
];

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
});

if (result.error) {
  console.error("Failed to spawn codex launcher:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
