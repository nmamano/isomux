import type { SessionInfo } from "./types.ts";

export const UNTITLED_CONVERSATION_LABEL = "Untitled conversation";
export const SESSION_MESSAGE_PREVIEW_LENGTH = 80;

export function sessionMessagePreview(content: string): string | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, SESSION_MESSAGE_PREVIEW_LENGTH);
}

/**
 * The label a resume row shows: the session's topic, else its first message,
 * else a fallback for a session with neither.
 *
 * `untitled` defaults to the English constant, so a caller that passes nothing
 * gets exactly what it got before - which is what keeps every server caller
 * byte-identical while the UI passes its catalog value (internal-docs/i18n-loop.md,
 * S6; the server resolves its own language in S7).
 */
export function sessionResumeLabel(
  session: Pick<SessionInfo, "topic" | "firstUserMessage">,
  untitled: string = UNTITLED_CONVERSATION_LABEL,
): string {
  return (
    sessionMessagePreview(session.topic ?? "") ||
    sessionMessagePreview(session.firstUserMessage ?? "") ||
    untitled
  );
}
