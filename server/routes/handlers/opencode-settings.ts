import type { SecretScope } from "../../secret-store.ts";

// A saved env variable, secret or MCP server goes to the OpenCode servers
// that `scope` reaches (task d4a7031e).
export type PushOpenCodeSettings = (scope: SecretScope) => void;

// Called after the store write: a push that fails is logged and never fails
// the save.
export function pushOpenCodeSettings(
  push: PushOpenCodeSettings | undefined,
  scope: SecretScope,
): void {
  try {
    push?.(scope);
  } catch {
    console.error("[opencode] Saved settings did not reach the server.");
  }
}
