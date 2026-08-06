// Identity formatting helpers shared between server and UI.
// `username` is the human boss; `device` is an optional connection-point label.
// Old log entries (pre-migration) carry combined values like "Nil Phone" in
// `username` with no `device` - the helpers below render them verbatim.

export function formatPrefix({
  username,
  device,
}: {
  username?: string | null;
  device?: string | null;
}): string {
  if (!username) return "";
  if (!device) return `[${username}] `;
  return `[${username} (${device})] `;
}

export function formatIdentity({
  username,
  device,
}: {
  username?: string | null;
  device?: string | null;
}): string {
  if (!username) return "";
  if (!device) return username;
  return `${username} (${device})`;
}

// Sender prefix for messages that come from another agent. Distinguishes
// agent-to-agent traffic from human boss messages (which use `[Name]`) so the
// receiving agent can apply different authority rules. The id is included so
// the receiver can POST a reply directly without looking it up in
// agents-summary.json.
// Format: `"Isomuxer3" (agent id: agent-1774747441394-bm2g) from Room "Isomux Dev"`.
export function formatAgentSenderPrefix(
  agentId: string,
  agentName: string,
  roomName: string,
): string {
  return `"${agentName}" (agent id: ${agentId}) from Room "${roomName}"`;
}

// Sender prefix for a message from a registered app (POST /api/app/message).
// Distinct from both the human `[Name]` form and the agent form above, because
// an app is neither: it is code the receiving agent wrote, running unattended.
// No id, unlike the agent prefix - an app has no inbox, so there is nothing to
// reply to; the name is what the agent manages it by.
// Format: `[App "habits"]`.
export function formatAppSenderPrefix(appName: string): string {
  return `[App "${appName}"]`;
}

// Lowercase key used for users.json lookup. Display case is whatever the
// client sent; the key only normalizes for matching.
export function lowercaseKey(name: string): string {
  return name.trim().toLowerCase();
}
