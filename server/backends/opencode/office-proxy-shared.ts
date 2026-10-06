import { join } from "node:path";
import { STATE_ROOT } from "../../config.ts";
import { SHARE_ROOT, SPLIT_CONFIG } from "../../split/roots.ts";

export const OPENCODE_TURN_HANDLE_PLACEHOLDER = "__ISOMUX_OPENCODE_TURN__";

// In split mode the socket is in the share, where an agent-user process can
// connect and cannot replace it (design section 3.1.1).
export function openCodeAuthoritySocketPath(): string {
  return SPLIT_CONFIG
    ? join(SHARE_ROOT, "authority", "authority.sock")
    : join(STATE_ROOT, "opencode", "authority", "authority.sock");
}
