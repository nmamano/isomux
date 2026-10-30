// The MCP sign-in leaves the page for the authorization server and comes back
// to /integrations?mcpSignIn=<code>. The code says only ok or why not, so the
// page notes which server it signed in, and for whom, before it leaves: an
// owner who signs in for Stephen's server lands back on "You", and the notice
// must still say whose server it was. The note lives in this tab's
// sessionStorage, is read once, and goes stale after 15 minutes.

import type { McpServerSignInRes } from "../../shared/contract-shapes.ts";
import { apiFetch } from "../api.ts";
import { basePath, type Target } from "./target.ts";

const KEY = "isomux:mcpSignIn";
const MAX_AGE_MS = 15 * 60_000;

export type SignInNote = { server: string; target: Target };

export function rememberSignIn(note: SignInNote): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...note, at: Date.now() }));
  } catch {
    // No storage: the notice falls back to words without the server.
  }
}

export function takeSignIn(now = Date.now()): SignInNote | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const note = JSON.parse(raw) as {
      server?: unknown;
      at?: unknown;
      target?: { kind?: unknown; username?: unknown };
    };
    if (typeof note.server !== "string" || typeof note.at !== "number")
      return null;
    if (now - note.at > MAX_AGE_MS || note.at > now) return null;
    const kind = note.target?.kind;
    const username = note.target?.username;
    if (kind === "office") return { server: note.server, target: { kind } };
    if ((kind === "self" || kind === "member") && typeof username === "string")
      return { server: note.server, target: { kind, username } };
    return null;
  } catch {
    return null;
  }
}

// Start the sign-in to a server of `target`: the browser leaves for the
// authorization server. A caller that unmounts meanwhile (an ask card that
// the save closed) still gets the redirect; a refusal rejects.
export async function startMcpSignIn(
  target: Target,
  server: string,
): Promise<void> {
  const { authorizationUrl } = await apiFetch<McpServerSignInRes>(
    "POST",
    `${basePath(target)}/mcp-servers/${encodeURIComponent(server)}/sign-in`,
  );
  rememberSignIn({ server, target });
  window.location.assign(authorizationUrl);
}
