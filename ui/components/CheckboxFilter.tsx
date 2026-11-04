// The filter-row checkbox list of the Tasks page and the Inbox's Asks tab
// (task 2bbc5021): a button that shows a summary and opens a list of choices,
// each with a count. An All box checks or clears every choice, and each
// choice's Only button checks it alone (task 286eaa5d).

import { useEffect, useRef } from "react";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { FilterChevron } from "./ChevronSelect.tsx";
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
// room's, that page translation must not change. `onSet` replaces the checked
// values at once, for All and Only.
export function CheckboxFilter<T extends string>({
  name,
  label,
  summary,
  summaryNoTranslate = false,
  options,
  checked,
  onToggle,
  onSet,
  allLabel,
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
  onSet: (values: T[]) => void;
  allLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buttonStyle: React.CSSProperties;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const allRef = useRef<HTMLInputElement>(null);
  const checkedCount = options.filter((o) => checked.includes(o.value)).length;
  const allChecked = checkedCount === options.length;
  // indeterminate is a DOM property, with no attribute to render.
  useEffect(() => {
    if (allRef.current) {
      allRef.current.indeterminate = checkedCount > 0 && !allChecked;
    }
  });
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
  const rowStyle: React.CSSProperties = {
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
  };
  return (
    <div
      ref={rootRef}
      data-checkbox-filter={name}
      style={{
        position: "relative",
        display: "flex",
        flex: buttonStyle.flex,
        minWidth: buttonStyle.minWidth,
        maxWidth: buttonStyle.maxWidth,
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
        <FilterChevron />
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
            maxWidth: "calc(100vw - 24px)",
            // A long list, such as the Inbox's agents, scrolls.
            maxHeight: "min(60vh, 420px)",
            overflowY: "auto",
            zIndex: 600,
            background: "var(--bg-overlay-solid)",
            border: "1px solid var(--border-light)",
            borderRadius: 8,
            padding: 4,
            boxShadow: "0 12px 40px var(--shadow-heavy)",
          }}
        >
          <label style={rowStyle}>
            <input
              ref={allRef}
              type="checkbox"
              data-checkbox-all=""
              checked={allChecked}
              onChange={() =>
                onSet(allChecked ? [] : options.map((o) => o.value))
              }
              style={{ margin: 0 }}
            />
            <span style={{ flex: 1 }}>{allLabel}</span>
          </label>
          {/* Only is beside the label, not in it: a button in a label would
              toggle the checkbox too. */}
          {options.map((o) => (
            <div
              key={o.value}
              style={{ display: "flex", alignItems: "center" }}
            >
              <label style={{ ...rowStyle, flex: 1, minWidth: 0 }}>
                <input
                  type="checkbox"
                  value={o.value}
                  checked={checked.includes(o.value)}
                  onChange={() => onToggle(o.value)}
                  style={{ margin: 0 }}
                />
                <span
                  {...(o.noTranslate ? noTranslate() : {})}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
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
              <button
                type="button"
                data-checkbox-only={o.value}
                aria-label={t("tasks.filterOnlyName", { name: o.label })}
                onClick={() => onSet([o.value])}
                style={{
                  alignSelf: "stretch",
                  minHeight: 28,
                  padding: "0 10px",
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {t("tasks.filterOnly")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
