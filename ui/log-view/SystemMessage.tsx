// A system line in the agent chat. One line (and every notice) is a quiet
// centered sentence whose values and code spans show apart (Data); several
// lines render as Markdown.

import { Data } from "../components/Data.tsx";
import { useI18n } from "../i18n.tsx";
import { logEntrySegments } from "../../shared/i18n/log-message.ts";
import { Markdown } from "./Markdown.tsx";

export function SystemMessage({
  content,
  message,
  isMobile,
  notice,
}: {
  // The line as the reader sees it (logEntryText), or a bare text.
  content: string;
  // The entry's stored parts (entry.message), when it has them.
  message?: unknown;
  isMobile?: boolean;
  notice?: boolean;
}) {
  const i18n = useI18n();
  const isMultiline = !notice && content.includes("\n");
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "6px 0",
        textAlign: isMultiline ? "left" : "center",
        color: isMultiline ? "var(--text-dim)" : "var(--text-ghost)",
        fontSize: isMultiline ? (isMobile ? 15 : 13) : isMobile ? 13 : 11,
        fontFamily: isMultiline ? "'JetBrains Mono',monospace" : undefined,
        fontStyle: isMultiline ? "normal" : "italic",
        ...(!isMultiline && { whiteSpace: "pre-wrap" }),
      }}
    >
      {isMultiline ? (
        <Markdown content={content} />
      ) : (
        logEntrySegments(i18n, { content, message }).map((segment, i) =>
          segment.kind === "text" ? (
            segment.text
          ) : segment.text === "" ? null : (
            <Data key={i}>{segment.text}</Data>
          ),
        )
      )}
    </div>
  );
}
