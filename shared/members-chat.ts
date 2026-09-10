import { Lexer, defaults, type Token } from "marked";
import type { Attachment, MembersChatMessage } from "./types.ts";

// A plain-text snapshot shared by the server, composer and demo. Count Unicode
// code points so the limit cannot split a surrogate pair.
export function membersChatExcerpt(content: string, attachments: Pick<Attachment, "originalName">[]): string {
  const text = content.trim() ? content : attachments.map((attachment) => attachment.originalName).join(", ");
  return Array.from(text).slice(0, 200).join("");
}

// Strip the supported inline markup only when displaying a locator. Stored
// excerpts stay raw; unsupported markup stays literal, as it does in the chat.
export function membersChatPreview(content: string): string {
  const text = (tokens: Token[]): string => tokens.map((token) => {
    if ((token.type === "strong" || token.type === "em" || token.type === "link") && token.tokens)
      return text(token.tokens);
    if (token.type === "text" || token.type === "escape") return token.text;
    if (token.type === "br") return "\n";
    return token.raw;
  }).join("");
  return text(Lexer.lexInline(content, { ...defaults, gfm: true, breaks: false }));
}

// This caps the returned list, never the number of pins stored on disk.
// The extra entry lets the strip distinguish exactly twenty from more.
export const MEMBERS_CHAT_PIN_LIMIT = 21;

export function recentMembersChatPins(messages: Iterable<MembersChatMessage>): MembersChatMessage[] {
  // Pins use wall-clock pin time; message history retains its file ordering.
  return Array.from(messages).filter((message) => message.pinnedAt !== undefined)
    .sort((a, b) => b.pinnedAt! - a.pinnedAt!).slice(0, MEMBERS_CHAT_PIN_LIMIT);
}
