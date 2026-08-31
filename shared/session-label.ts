import type { SessionInfo } from "./types.ts";

export const UNTITLED_CONVERSATION_LABEL = "Untitled conversation";
export const SESSION_MESSAGE_PREVIEW_LENGTH = 80;

export function sessionMessagePreview(content: string): string | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, SESSION_MESSAGE_PREVIEW_LENGTH);
}

export function sessionResumeLabel(
  session: Pick<SessionInfo, "topic" | "firstUserMessage">,
): string {
  return (
    session.topic ||
    session.firstUserMessage?.trim() ||
    UNTITLED_CONVERSATION_LABEL
  );
}
