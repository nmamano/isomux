// The pinned Codex's trust hash for the safety hook command, measured by a
// codex app-server of the agent user (safety-hook-trust-probe.ts).
import { discoverCodexHookTrustedHash } from "../../backends/codex/safety-hook-trust-probe.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => {
  const req = input as { commandPath?: unknown } | null;
  if (typeof req?.commandPath !== "string")
    throw new Error("codex-trust-hash needs commandPath");
  return discoverCodexHookTrustedHash(req.commandPath);
});
