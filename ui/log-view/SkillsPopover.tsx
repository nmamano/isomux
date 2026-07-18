import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillInfo, SkillOrigin } from "../../shared/types.ts";

// Display groups in the agreed order: bundled / user / project / plugin.
// "isomux" is the origin of skills bundled with isomux, hence "Bundled".
// The "claude" origin exists in the SkillOrigin union but no discovery path
// currently emits it; fold it into Bundled rather than surfacing a fifth
// group that was never part of the agreed grouping.
type GroupKey = "bundled" | "user" | "project" | "plugin";
const GROUP_ORDER: GroupKey[] = ["bundled", "user", "project", "plugin"];
const GROUP_LABELS: Record<GroupKey, string> = {
  bundled: "Bundled",
  user: "User",
  project: "Project",
  plugin: "Plugin",
};
function groupForOrigin(origin: SkillOrigin): GroupKey {
  if (origin === "isomux" || origin === "claude") return "bundled";
  return origin;
}

// Popover listing the agent's available skills, opened from the "Sk" button
// in the composer. Renders inside the composer's position:relative container
// and anchors above it (same approach as the slash-command autocomplete).
// Clicking a skill hands its name to the parent, which inserts `/name ` into
// the draft; there is no args handling here by design.
export function SkillsPopover({
  skills,
  isMobile,
  onPick,
  onClose,
}: {
  skills: SkillInfo[];
  isMobile: boolean;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");

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

  const groups = useMemo(() => {
    // A skill entry with aliasFor is a friendlier alias of a canonical
    // (on-disk) name. Mirror /help: show one line per skill — the alias —
    // and hide the canonical it points at.
    const aliasTargets = new Set(
      skills.filter((s) => s.aliasFor).map((s) => s.aliasFor as string),
    );
    const q = filter.trim().toLowerCase();
    const byGroup = new Map<GroupKey, SkillInfo[]>();
    for (const s of skills) {
      if (aliasTargets.has(s.name)) continue;
      if (
        q &&
        !s.name.toLowerCase().includes(q) &&
        !(s.description ?? "").toLowerCase().includes(q)
      ) {
        continue;
      }
      const group = groupForOrigin(s.origin);
      const list = byGroup.get(group) ?? [];
      list.push(s);
      byGroup.set(group, list);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
      key: g,
      label: GROUP_LABELS[g],
      skills: byGroup.get(g)!.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [skills, filter]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        bottom: "100%",
        left: 8,
        right: isMobile ? 8 : 20,
        marginBottom: 4,
        background: "var(--bg-surface)",
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
          placeholder="Filter skills..."
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
            No matching skills
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
                onClick={() => onPick(s.name)}
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
