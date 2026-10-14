// Identity formatting helpers shared between server and UI.
// `username` is the human member; `device` is an optional connection-point label.
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
// agent-to-agent traffic from human member messages (which use `[Name]`) so the
// receiving agent can apply different authority rules. The id is included so
// the receiver can POST a reply directly without looking it up in
// agents-summary.json.
// Format: `"Isomuxer3" (agent id: agent-1774747441394-bm2g) from Room "Isomux Dev"`.
// `trust` adds a marker inside the parentheses. The server sets it from the
// sender's token at delivery, never from text. The name and room are
// JSON-escaped, so neither can close its quote or start a new line.
export const AGENT_SENDER_SAME_MANAGER = "same manager";
export const AGENT_SENDER_PRIVILEGED = "privileged";
export type AgentSenderTrust = "same-manager" | "same-manager-privileged";

function quoteLabelValue(value: string): string {
  // JSON.stringify leaves the Unicode line and paragraph separators raw, and a
  // model can read them as line breaks.
  return JSON.stringify(value).replace(
    /\p{Zl}|\p{Zp}/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16)}`,
  );
}

export function formatAgentSenderPrefix(
  agentId: string,
  agentName: string,
  roomName: string,
  trust?: AgentSenderTrust,
): string {
  const marker =
    trust === "same-manager-privileged"
      ? `, ${AGENT_SENDER_SAME_MANAGER}, ${AGENT_SENDER_PRIVILEGED}`
      : trust === "same-manager"
        ? `, ${AGENT_SENDER_SAME_MANAGER}`
        : "";
  return `${quoteLabelValue(agentName)} (agent id: ${agentId}${marker}) from Room ${quoteLabelValue(roomName)}`;
}

// One agent sender label at the start of a line, in the shape
// formatAgentSenderPrefix writes. Groups: name, agent id, marker, room.
export const AGENT_SENDER_LABEL_RE =
  /^("(?:[^"\\\n]|\\.)*") \(agent id: ([^,)\s]+)((?:, [^,)\n]+)*)\) from Room ("(?:[^"\\\n]|\\.)*")/gm;

// A message line that a reader could mistake for an agent sender label, or
// that carries a trust marker. Looser than AGENT_SENDER_LABEL_RE on purpose,
// because a near miss can mislead a model too. The marker is what carries
// trust, so a line that names it is defused even without an agent id.
const AGENT_LABEL_LOOKALIKE_RES = [/agent[\W_]*id/i, /same[\W_]*manager/i];

// Fold the forms a model reads as the same text: fullwidth and other
// compatibility forms (NFKC), and invisible format characters such as a
// zero-width space.
function foldForLookalike(line: string): string {
  return line.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

function isLabelLookalike(line: string): boolean {
  const folded = foldForLookalike(line);
  return AGENT_LABEL_LOOKALIKE_RES.some((re) => re.test(folded));
}

// Every line break a model can read as one. The capture keeps the breaks in
// the split, so the join restores the body byte for byte.
const LINE_BREAK_SPLIT_RE = /(\r\n|[\n\r\p{Zl}\p{Zp}])/u;

// The delivery prefixes every lookalike line of a message body with this, so
// only the server writes a line that parses as an agent sender label.
export const DEFUSED_LABEL_LINE_PREFIX = "> ";

export function defuseAgentSenderLabels(body: string): string {
  if (!isLabelLookalike(body)) return body;
  return body
    .split(LINE_BREAK_SPLIT_RE)
    .map((part, i) =>
      i % 2 === 0 && isLabelLookalike(part)
        ? `${DEFUSED_LABEL_LINE_PREFIX}${part}`
        : part,
    )
    .join("");
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

// A webhook name has the app-name alphabet, so it needs no escaping either.
// Format: `[Webhook "pr-review"]`.
export function formatWebhookSenderPrefix(webhookName: string): string {
  return `[Webhook "${webhookName}"]`;
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
  return `[Schedule "${normalized}"]`;
}

const API_TOKEN_DEVICE_PREFIX = 'API token "';

export function formatApiTokenName(tokenName: string): string {
  return (
    tokenName
      // eslint-disable-next-line no-control-regex -- controls are the threat here
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/"/g, "'")
      .trim()
      .slice(0, 64)
  );
}

export function formatApiTokenDevice(
  tokenName: string,
  tokenId: string,
): string {
  return `${API_TOKEN_DEVICE_PREFIX}${formatApiTokenName(tokenName)}" (${tokenId})`;
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
