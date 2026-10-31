// A native select drawn like CheckboxFilter's button (task 93c943b1): as wide
// as the chosen label, with the same chevron at the same gap from the text and
// the same padding to the edge. The browser's own arrow sits at a gap that
// depends on the widest option.

import type { CSSProperties, ReactNode, SelectHTMLAttributes } from "react";
import { noTranslate } from "../no-translate.ts";

export function FilterChevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 10 6"
      width="10"
      height="6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      style={{ color: "var(--text-muted)", flexShrink: 0 }}
    >
      <path d="M1 1l4 4 4-4" />
    </svg>
  );
}

export function ChevronSelect({
  label,
  labelNoTranslate,
  style,
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "style"> & {
  /** The text of the chosen option: it sizes the control. */
  label: string;
  labelNoTranslate?: boolean;
  style: CSSProperties;
  children: ReactNode;
}) {
  const { flex, flexBasis, flexShrink, minWidth, maxWidth, ...box } = style;
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flex,
        flexBasis,
        flexShrink,
        minWidth,
        maxWidth,
      }}
    >
      {/* The select covers the box and takes the clicks; the layer over it
          sets the width and draws the chevron. */}
      <select
        {...props}
        style={{
          ...box,
          appearance: "none",
          WebkitAppearance: "none",
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          // Clipped text stops short of the chevron: padding 8 + chevron 10
          // + gap 6.
          paddingRight: 24,
          cursor: "pointer",
          textOverflow: "ellipsis",
        }}
      >
        {children}
      </select>
      <div
        aria-hidden="true"
        style={{
          ...box,
          position: "relative",
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          background: "transparent",
          pointerEvents: "none",
          whiteSpace: "nowrap",
        }}
      >
        <span
          {...(labelNoTranslate ? noTranslate() : {})}
          style={{
            visibility: "hidden",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
        <FilterChevron />
      </div>
    </div>
  );
}
