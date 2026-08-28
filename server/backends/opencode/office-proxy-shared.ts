import { join } from "node:path";
import { STATE_ROOT } from "../../config.ts";

export const OPENCODE_TURN_HANDLE_PLACEHOLDER = "__ISOMUX_OPENCODE_TURN__";

export function openCodeAuthoritySocketPath(): string {
  return join(STATE_ROOT, "opencode", "authority", "authority.sock");
}
