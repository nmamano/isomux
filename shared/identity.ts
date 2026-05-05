// Identity formatting helpers shared between server and UI.
// `username` is the human boss; `device` is an optional connection-point label.
// Old log entries (pre-migration) carry combined values like "Nil Phone" in
// `username` with no `device` — the helpers below render them verbatim.

export function formatPrefix({ username, device }: { username?: string | null; device?: string | null }): string {
  if (!username) return "";
  if (!device) return `[${username}] `;
  return `[${username} (${device})] `;
}

export function formatIdentity({ username, device }: { username?: string | null; device?: string | null }): string {
  if (!username) return "";
  if (!device) return username;
  return `${username} (${device})`;
}

// Lowercase key used for users.json lookup. Display case is whatever the
// client sent; the key only normalizes for matching.
export function lowercaseKey(name: string): string {
  return name.trim().toLowerCase();
}
