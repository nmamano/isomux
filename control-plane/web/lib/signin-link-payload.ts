// What the browser may know about a sign-in token: how long it lives, and the
// address it names, for display only. The server never trusts that address:
// redeeming the token checks the signature (signin-link.server.ts).

export const SIGNIN_LINK_TTL_MS = 15 * 60 * 1000;

export function addressInSignInToken(token: string): string | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims !== "object" || claims === null) return null;
    const { e } = claims as Record<string, unknown>;
    return typeof e === "string" && e ? e : null;
  } catch {
    return null;
  }
}
