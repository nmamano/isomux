import { useMemo, type ReactNode } from "react";
import { Lexer, defaults, type Token } from "marked";

// The full log renderer also runs HTML, SVG, Mermaid and code hooks. Keep
// this small inline grammar separate, and let React escape all source text.
// Pass options to the static lexer; Marked instance options do not reach it.

function renderTokens(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => {
    if (token.type === "strong" && token.tokens)
      return <strong key={index}>{renderTokens(token.tokens)}</strong>;
    if (token.type === "em" && token.tokens)
      return <em key={index}>{renderTokens(token.tokens)}</em>;
    if (token.type === "link" && token.tokens) {
      // A parsed link still has an untrusted destination. Accept web and email URLs
      // only, including marked's normalized bare www. links.
      let safe = false;
      try {
        safe = ["https:", "http:", "mailto:"].includes(
          new URL(token.href).protocol,
        );
      } catch {
        /* Keep an invalid destination as literal text. */
      }
      if (safe)
        return (
          <a
            key={index}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {renderTokens(token.tokens)}
          </a>
        );
    }
    if (token.type === "escape") return token.text;
    return token.raw;
  });
}

export function InlineMarkdown({ content }: { content: string }) {
  const nodes = useMemo(
    () =>
      renderTokens(
        Lexer.lexInline(content, { ...defaults, gfm: true, breaks: false }),
      ),
    [content],
  );
  return <span style={{ whiteSpace: "pre-wrap" }}>{nodes}</span>;
}
