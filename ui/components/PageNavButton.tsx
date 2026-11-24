// The control that leaves a page: the Close at the left of a page's header,
// and a phone's back-to-list row. One look on every page (AGENTS.md "UI
// rules": every button has a background, one look per kind of control), so it
// takes no style: a caller spaces it with a wrapper element.

import type { ReactNode } from "react";
import { pageNavBtn } from "./dialog-styles.ts";
import { noTranslate as keepForm } from "../no-translate.ts";

type DataAttrs = { [attr: `data-${string}`]: string };

export function PageNavButton({
  label,
  onClick,
  noTranslate = false,
  wide = false,
  ...attrs
}: {
  label: ReactNode;
  onClick: () => void;
  // The label is a name (an agent, a member) that browser translation keeps.
  noTranslate?: boolean;
  // Outside a header: the label takes the width it has, not 12em.
  wide?: boolean;
} & DataAttrs): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={wide ? { ...pageNavBtn, maxWidth: "100%" } : pageNavBtn}
      {...attrs}
    >
      <BackArrow />
      {/* A long name or a long translation ends in an ellipsis rather than
          pushing the page title off a phone's header. */}
      <span
        {...(noTranslate ? keepForm() : {})}
        style={{
          maxWidth: wide ? undefined : "12em",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>
    </button>
  );
}

function BackArrow() {
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 12 12"
      style={{ display: "block", flexShrink: 0 }}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.5 6 H1.5 M5 2.5 L1.5 6 L5 9.5" />
    </svg>
  );
}
