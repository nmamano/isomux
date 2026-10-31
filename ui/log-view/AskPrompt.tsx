import { useMemo } from "react";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";
import { splitPromptDiffs, type DiffLine } from "./ask-prompt-diff.ts";

// The chat diff card's colors (diff2html's variables, re-routed in dark mode
// under .d2h-isomux-host), with the light values for a page without its sheet.
const ROW = {
  removed: {
    marker: "-",
    line: "var(--d2h-del-bg-color, #fee8e9)",
    word: "var(--d2h-del-highlight-bg-color, #ffb6ba)",
  },
  added: {
    marker: "+",
    line: "var(--d2h-ins-bg-color, #dfd)",
    word: "var(--d2h-ins-highlight-bg-color, #97f295)",
  },
};

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "context")
    return (
      <div
        data-diff-line="context"
        // An empty line keeps its height.
        style={{ color: "var(--text-secondary)", minHeight: "1.5em" }}
      >
        {line.text}
      </div>
    );
  const row = ROW[line.kind];
  return (
    <div
      data-diff-line={line.kind}
      style={{
        background: row.line,
        // The marker hangs left of wrapped lines.
        paddingLeft: "1.4em",
        textIndent: "-1.1em",
      }}
    >
      <span style={{ display: "inline-block", width: "1.1em", textIndent: 0 }}>
        {row.marker}
      </span>
      {line.words
        ? line.words.map((w, i) =>
            w.changed ? (
              <span
                key={i}
                data-diff-word="changed"
                style={{ background: row.word, borderRadius: 2 }}
              >
                {w.text}
              </span>
            ) : (
              w.text
            ),
          )
        : line.text}
    </div>
  );
}

// An ask prompt: inline markdown, with each ```diff block drawn as a red and
// green diff.
export function AskPrompt({ content }: { content: string }) {
  const segments = useMemo(() => splitPromptDiffs(content), [content]);
  return segments.map((segment, i) =>
    segment.kind === "text" ? (
      <InlineMarkdown key={i} content={segment.text} code />
    ) : (
      <div
        key={i}
        data-ask-diff=""
        className="d2h-isomux-host"
        style={{
          margin: "4px 0",
          borderRadius: 4,
          overflow: "hidden",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: "var(--text-primary)",
        }}
      >
        {segment.lines.map((line, j) => (
          <DiffRow key={j} line={line} />
        ))}
      </div>
    ),
  );
}
