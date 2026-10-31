// The filter-row checkbox list of the Tasks page and the Inbox's Asks tab
// (task 2bbc5021): a button that shows a summary and opens a list of choices,
// each with a count.

import { useEffect, useRef } from "react";
import { noTranslate } from "../no-translate.ts";
import {
  FILTER_PRIORITIES,
  PRIORITY_ORDER,
  type PriorityFilterValue,
} from "../task-priority.ts";
import type { TaskPriority } from "../../shared/types.ts";
import type { Translator } from "../../shared/i18n/translate.ts";

// Adjacent levels collapse to a range: "P0-P3, none".
export function prioritySummary(
  checked: readonly PriorityFilterValue[],
  t: Translator["t"],
): string {
  if (checked.length === FILTER_PRIORITIES.length) {
    return t("tasks.filterAllPriorities");
  }
  if (checked.length === 0) return t("tasks.filterNone");
  const levels = FILTER_PRIORITIES.filter(
    (p): p is TaskPriority => p !== "none" && checked.includes(p),
  );
  const parts: string[] = [];
  for (let i = 0; i < levels.length; ) {
    let j = i;
    while (
      j + 1 < levels.length &&
      PRIORITY_ORDER[levels[j + 1]] === PRIORITY_ORDER[levels[j]] + 1
    ) {
      j++;
    }
    parts.push(j > i ? `${levels[i]}-${levels[j]}` : levels[i]);
    i = j + 1;
  }
  if (checked.includes("none")) parts.push(t("tasks.filterPriorityNoneShort"));
  return parts.join(", ");
}

export function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

// The parent holds which list is open, so its Escape handler can close it
// first; `name` marks the root (data-checkbox-filter) for that handler and for
// tests. An option or the summary with `noTranslate` is a name, such as a
// room's, that page translation must not change.
export function CheckboxFilter<T extends string>({
  name,
  label,
  summary,
  summaryNoTranslate = false,
  options,
  checked,
  onToggle,
  open,
  onOpenChange,
  buttonStyle,
}: {
  name: string;
  label: string;
  summary: string;
  summaryNoTranslate?: boolean;
  options: { value: T; label: string; count: number; noTranslate?: boolean }[];
  checked: readonly T[];
  onToggle: (value: T) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buttonStyle: React.CSSProperties;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // A tap, click or focus move outside the list closes it.
    function onOutside(e: Event) {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    }
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [open, onOpenChange]);
  return (
    <div
      ref={rootRef}
      data-checkbox-filter={name}
      style={{
        position: "relative",
        display: "flex",
        flex: buttonStyle.flex,
        minWidth: buttonStyle.minWidth,
      }}
    >
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`${label}: ${summary}`}
        title={label}
        onClick={() => onOpenChange(!open)}
        style={{
          ...buttonStyle,
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span
          {...(summaryNoTranslate ? noTranslate() : {})}
          style={{ overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {summary}
        </span>
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
      </button>
      {open && (
        <div
          role="group"
          aria-label={label}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: "100%",
            zIndex: 600,
            background: "var(--bg-overlay-solid)",
            border: "1px solid var(--border-light)",
            borderRadius: 8,
            padding: 4,
            boxShadow: "0 12px 40px var(--shadow-heavy)",
          }}
        >
          {options.map((o) => (
            <label
              key={o.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                minHeight: 28,
                borderRadius: 6,
                fontSize: 12,
                color: "var(--text-primary)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <input
                type="checkbox"
                value={o.value}
                checked={checked.includes(o.value)}
                onChange={() => onToggle(o.value)}
                style={{ margin: 0 }}
              />
              <span
                {...(o.noTranslate ? noTranslate() : {})}
                style={{ flex: 1 }}
              >
                {o.label}
              </span>
              <span
                style={{
                  marginLeft: 12,
                  color: "var(--text-muted)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {o.count}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
