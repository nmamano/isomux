import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillInfo } from "../../shared/types.ts";
import { apiFetch } from "../api.ts";
import { buildSkillsMenuGroups, type CommandEntry } from "./skills-grouping.ts";

// Display groups + most-used ranking live in skills-grouping.ts (a pure,
// unit-tested transform); this component owns fetching the counts and
// rendering the returned groups.
export type { CommandEntry } from "./skills-grouping.ts";

// Popover listing the agent's available skills, opened from the "Sk" button
// in the composer. Renders inside the composer's position:relative container
// and anchors above it (same approach as the slash-command autocomplete).
// Clicking an entry hands its name (and its autoRun flag) to the parent: for a
// no-arg command (autoRun) the parent executes it immediately; otherwise it
// inserts `/name ` into the draft. There is no args handling here by design.
export function SkillsPopover({
  skills,
  commands,
  isMobile,
  onPick,
  onClose,
}: {
  skills: SkillInfo[];
  commands: CommandEntry[];
  isMobile: boolean;
  onPick: (name: string, autoRun?: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  // The viewing user's per-skill use counters (server-side so they follow the
  // user across devices — task f1769b1a). Fetched fresh on every open; until
  // (or if never) loaded, all counts read 0 and the alphabetical order stands.
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    apiFetch<{ counts: Record<string, number> }>("GET", "/api/skill-usage")
      .then((r) => {
        if (alive && r?.counts) setCounts(r.counts);
      })
      .catch(() => {
        // Demo build / transient failure: sorting falls back to alphabetical.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Outside-click / Escape dismissal. Capture phase so a preventDefault
  // somewhere below can't swallow the dismiss (same defensive pattern as
  // ContextMenu). Events on the "Sk" toggle button are excluded — its own
  // onClick toggles the popover, and closing here first would make that
  // click reopen it immediately.
  useEffect(() => {
    function onOutside(e: PointerEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if ((target as Element).closest?.("[data-skills-toggle]")) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("touchstart", onOutside, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("touchstart", onOutside, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  // Autofocus the filter box on desktop. Skipped on mobile: focusing a text
  // input pops the soft keyboard over the list the user is trying to browse.
  useEffect(() => {
    if (!isMobile) filterRef.current?.focus();
  }, [isMobile]);

  const groups = useMemo(
    () => buildSkillsMenuGroups({ skills, commands, counts, filter }),
    [skills, commands, filter, counts],
  );

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        bottom: "100%",
        left: 8,
        right: isMobile ? 8 : 20,
        marginBottom: 4,
        // Solid variant on purpose: the popover floats over chat content and
        // the translucent --bg-surface lets it bleed through (Nil 2026-07-17).
        background: "var(--bg-surface-solid)",
        border: "1px solid var(--border-medium)",
        borderRadius: 8,
        boxShadow: "0 -4px 16px rgba(0,0,0,0.3)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        maxHeight: isMobile ? "45vh" : 320,
      }}
    >
      <div
        style={{
          padding: 8,
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter skills & commands..."
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "4px 8px",
            background: "var(--bg-base)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
            color: "var(--text-secondary)",
            fontFamily: "'JetBrains Mono',monospace",
            // 16px on mobile keeps iOS Safari from auto-zooming on focus.
            fontSize: isMobile ? 16 : 12,
            caretColor: "var(--green)",
          }}
        />
      </div>
      <div style={{ overflowY: "auto", minHeight: 0 }}>
        {groups.length === 0 && (
          <div
            style={{
              padding: "10px 12px",
              fontSize: isMobile ? 13 : 12,
              color: "var(--text-ghost)",
            }}
          >
            No matching skills or commands
          </div>
        )}
        {groups.map((group) => (
          <div key={group.key}>
            <div
              style={{
                padding: "6px 12px 2px",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: "var(--text-ghost)",
              }}
            >
              {group.label}
            </div>
            {group.skills.map((s) => (
              <div
                key={s.name}
                // preventDefault on mousedown keeps focus where it is (filter
                // box or textarea) so the click doesn't cause a blur-flash;
                // the parent refocuses the textarea after inserting.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(s.name, s.autoRun)}
                // Desktop: full description via native hover tooltip. Mobile
                // has no hover, so the full description renders inline below.
                title={!isMobile ? s.description : undefined}
                style={{
                  padding: isMobile ? "8px 12px" : "5px 12px",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: isMobile ? "column" : "row",
                  alignItems: isMobile ? "stretch" : "center",
                  gap: isMobile ? 2 : 8,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-subtle)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  style={{
                    color: "var(--green)",
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 13,
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  /{s.name}
                  {s.count > 0 && (
                    // Use count (drives the most-used-first sort). Nested in
                    // the name span so it rides the name line in both the
                    // desktop row and mobile column layouts.
                    <span
                      style={{
                        marginLeft: 6,
                        color: "var(--text-ghost)",
                        fontSize: 10,
                        fontWeight: 400,
                      }}
                    >
                      ×{s.count}
                    </span>
                  )}
                </span>
                {s.description && (
                  <span
                    style={{
                      fontSize: isMobile ? 12 : 11,
                      color: "var(--text-ghost)",
                      ...(isMobile
                        ? {}
                        : {
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }),
                    }}
                  >
                    {s.description}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
