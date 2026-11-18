// A value inside a sentence (an email, a member's name, a path, a host, a
// server or variable name) looks unlike the words around it (AGENTS.md "UI
// rules"): one style for all of it. Put it in a sentence through rich().

import type { CSSProperties, ReactNode } from "react";
import { noTranslate } from "../no-translate.ts";

const dataStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: "0.92em",
  fontWeight: 500,
  color: "var(--text-primary)",
  background: "var(--bg-code)",
  padding: "1px 5px",
  borderRadius: 4,
  overflowWrap: "anywhere",
};

// Service-authored and member-authored text: rendered as text only, and
// page translation leaves it alone.
export function Data({ children }: { children: ReactNode }) {
  return (
    <span data-integrations-data="" style={dataStyle} {...noTranslate()}>
      {children}
    </span>
  );
}
