// A value inside a sentence (an email, a member's name, a path, a host, a
// server or variable name) looks unlike the words around it (AGENTS.md "UI
// rules"): one style for all of it. Put it in a sentence through rich().

import { Fragment, type CSSProperties, type ReactNode } from "react";
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

// A plain-text sentence with known values in it (for one, a send failure
// held as a string): each occurrence of a value becomes a Data span.
export function withData(text: string, values: string[]): ReactNode {
  const marks = values.filter((v) => v.length > 0);
  const out: ReactNode[] = [];
  let rest = text;
  for (;;) {
    // The earliest occurrence of any value; plain indexOf, so a value's
    // characters are never read as a pattern.
    let at = -1;
    let value = "";
    for (const v of marks) {
      const i = rest.indexOf(v);
      if (
        i !== -1 &&
        (at === -1 || i < at || (i === at && v.length > value.length))
      ) {
        at = i;
        value = v;
      }
    }
    if (at === -1) break;
    if (at > 0) out.push(rest.slice(0, at));
    out.push(<Data key={out.length}>{value}</Data>);
    rest = rest.slice(at + value.length);
  }
  if (rest) out.push(rest);
  return <>{out}</>;
}

// A list of values in a sentence: each one a Data span, joined by ", ".
export function dataList(values: string[]): ReactNode {
  return (
    <>
      {values.map((v, i) => (
        <Fragment key={i}>
          {i > 0 && ", "}
          <Data>{v}</Data>
        </Fragment>
      ))}
    </>
  );
}

// Names as a list in the reader's language, each name a value.
export function nameValues(names: string[], language: string): ReactNode {
  return new Intl.ListFormat(language, { type: "conjunction" })
    .formatToParts(names)
    .map((part, index) =>
      part.type === "element" ? (
        <Data key={index}>{part.value}</Data>
      ) : (
        part.value
      ),
    );
}
