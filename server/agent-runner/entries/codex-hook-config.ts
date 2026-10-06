// The Codex hooks.json and config.toml merge in the agent user's CODEX_HOME
// (server/backends/codex/safety-hook-install.ts).
import { configureCodexHooks } from "../../backends/codex/safety-hook-install.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const req = input as {
    codexHome?: unknown;
    hookPath?: unknown;
    trustedHash?: unknown;
  } | null;
  if (
    typeof req?.codexHome !== "string" ||
    typeof req.hookPath !== "string" ||
    typeof req.trustedHash !== "string"
  )
    throw new Error(
      "codex-hook-config needs codexHome, hookPath and trustedHash",
    );
  return configureCodexHooks(req.codexHome, req.hookPath, req.trustedHash);
});
