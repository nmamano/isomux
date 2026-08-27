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

// Cron job names are free-form, unlike app names. Normalize them before they
// enter an agent prompt so controls, newlines, and delimiter-like whitespace
// cannot forge a second sender line. Clamp after normalization so the rendered
// value has a firm bound.
export function formatCronjobSenderPrefix(cronjobName: string): string {
  const normalized = cronjobName
    // eslint-disable-next-line no-control-regex -- controls are the threat here
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .trim()
    .slice(0, 80);
  return `[Cron job "${normalized}"]`;
}

const API_TOKEN_DEVICE_PREFIX = 'API token "';

export function formatApiTokenDevice(tokenName: string): string {
  const normalized = tokenName
    // eslint-disable-next-line no-control-regex -- controls are the threat here
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .trim()
    .slice(0, 64);
  return `${API_TOKEN_DEVICE_PREFIX}${normalized}"`;
}

// An API-token message carries the issuing human's authority but was NOT typed
// in the office, so the log renders it like the other machine senders. A
// personal token stays a user-kind sender (that is what preserves completion
// sounds and permission-reply authority), so the device string is what marks
// it - hence this matcher lives beside the formatter that writes it, with a
// test pinning the pair. Worst case for a hand-typed device that mimics the
// format is a dashed border on the typist's own message.
export function isApiTokenDevice(device: string | undefined): boolean {
  return device?.startsWith(API_TOKEN_DEVICE_PREFIX) === true;
}

// Lowercase key used for users.json lookup. Display case is whatever the
// client sent; the key only normalizes for matching.
export function lowercaseKey(name: string): string {
  return name.trim().toLowerCase();
}
