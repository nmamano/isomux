import type { SessionInfo } from "./types.ts";

const SESSION_MESSAGE_PREVIEW_LENGTH = 80;

export function sessionMessagePreview(content: string): string | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, SESSION_MESSAGE_PREVIEW_LENGTH);
}

/**
 * The label a resume row shows: the session's topic, else its first message,
 * else `untitled`, which the caller words in its reader's language
 * (internal-docs/i18n-loop.md, S6).
 */
export function sessionResumeLabel(
  session: Pick<SessionInfo, "topic" | "firstUserMessage">,
  untitled: string,
): string {
  return (
    sessionMessagePreview(session.topic ?? "") ||
    sessionMessagePreview(session.firstUserMessage ?? "") ||
    untitled
  );
}
