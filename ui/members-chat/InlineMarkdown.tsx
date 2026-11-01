import { Fragment, useMemo, type ReactNode } from "react";
import { Lexer, defaults, type MarkedToken, type Token } from "marked";
import { renderTaskText, type TaskMap } from "../log-view/task-links.tsx";

// The full log renderer also runs HTML, SVG, Mermaid and code hooks. Keep
// this small inline grammar separate, and let React escape all source text.
// Pass options to the static lexer; Marked instance options do not reach it.

// Task ids become chips only with both task props; never in link text, as in
// the chat (a button inside a link).
type Grammar = {
  code: boolean;
  links: boolean;
  tasks?: { map: TaskMap; onOpen: (id: string) => void };
};

// The source is .md-content code in ui/styles.ts. The size is relative, not
// its fixed 12px, so it follows the 11 to 13px lines of the ask surfaces.
const CODE_STYLE = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
  background: "var(--bg-code)",
  padding: "1px 5px",
  borderRadius: 4,
  color: "var(--text-dim)",
};

function renderTokens(tokens: Token[], grammar: Grammar): ReactNode[] {
  // No extensions are registered, so every token is a built-in one.
  return (tokens as MarkedToken[]).map((token, index) => {
    if (token.type === "strong" && token.tokens)
      return <strong key={index}>{renderTokens(token.tokens, grammar)}</strong>;
    if (token.type === "em" && token.tokens)
      return <em key={index}>{renderTokens(token.tokens, grammar)}</em>;
    if (token.type === "codespan" && grammar.code)
      return (
        <code key={index} style={CODE_STYLE}>
          {token.text}
        </code>
      );
    if (token.type === "text" && grammar.tasks)
      return (
        <Fragment key={index}>
          {renderTaskText(
            token.raw,
            grammar.tasks.map,
            grammar.tasks.onOpen,
            `task-${index}`,
          )}
        </Fragment>
      );
    if (token.type === "link" && token.tokens) {
      const linkGrammar = { ...grammar, tasks: undefined };
      // A parsed link still has an untrusted destination. Accept web and email URLs
      // only, including marked's normalized bare www. links. Without links, a
      // safe link draws as its text; an unsafe one stays raw markdown either way.
      let safe = false;
      try {
        safe = ["https:", "http:", "mailto:"].includes(
          new URL(token.href).protocol,
        );
      } catch {
        /* Keep an invalid destination as literal text. */
      }
      if (safe && !grammar.links)
        return (
          <span key={index}>{renderTokens(token.tokens, linkGrammar)}</span>
        );
      if (safe)
        return (
          <a
            key={index}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {renderTokens(token.tokens, linkGrammar)}
          </a>
        );
    }
    if (token.type === "escape") return token.text;
    return token.raw;
  });
}

export function InlineMarkdown({
  content,
  code = false,
  links = true,
  whiteSpace = "pre-wrap",
  tasks,
  onOpenTask,
}: {
  content: string;
  /** Render `code` spans as code. Off by default: the members chat keeps
   * bold, italics and links only. */
  code?: boolean;
  /** False draws a safe link as its text, for a line inside a button. */
  links?: boolean;
  whiteSpace?: "pre-wrap" | "nowrap";
  /** With onOpenTask, draw these tasks' ids as chips (TaskChip). */
  tasks?: TaskMap;
  onOpenTask?: (id: string) => void;
}) {
  const nodes = useMemo(
    () =>
      renderTokens(
        Lexer.lexInline(content, { ...defaults, gfm: true, breaks: false }),
        {
          code,
          links,
          ...(tasks && onOpenTask
            ? { tasks: { map: tasks, onOpen: onOpenTask } }
            : {}),
        },
      ),
    [content, code, links, tasks, onOpenTask],
  );
  return <span style={{ whiteSpace }}>{nodes}</span>;
}
