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

// A member's own socket, in their share (internal-docs/member-os-user-design.md,
// slice 2d-ii): their OpenCode runs as their OS user, which cannot reach the
// office's.
export function memberAuthoritySocketPath(share: string): string {
  return join(share, "authority", "authority.sock");
}
