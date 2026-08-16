import { useTheme } from "../store.tsx";
import { THEMES, type Theme } from "../themes.ts";

const HEADING_ID = "theme-picker-heading";

export function ThemePicker() {
  const { theme: currentId, setTheme } = useTheme();

  return (
    <section aria-labelledby={HEADING_ID} style={{ marginTop: 18 }}>
      <div
        id={HEADING_ID}
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-muted)",
          marginBottom: 5,
        }}
      >
        Theme
      </div>
      <p
        style={{
          fontSize: 10,
          color: "var(--text-ghost)",
          margin: "0 0 6px",
        }}
      >
        Click the moon or sun to switch between your light and dark themes.
      </p>
      <div
        role="radiogroup"
        aria-labelledby={HEADING_ID}
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          padding: 4,
        }}
      >
        {THEMES.map((theme) => (
          <ThemeRow
            key={theme.id}
            theme={theme}
            selected={theme.id === currentId}
            onSelect={() => setTheme(theme.id)}
          />
        ))}
      </div>
    </section>
  );
}

function ThemeRow({
  theme,
  selected,
  onSelect,
}: {
  theme: Theme;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      data-theme-row
      data-selected={selected || undefined}
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        padding: "9px 12px",
        border: "none",
        background: selected ? "var(--accent-bg)" : "transparent",
        color: selected ? "var(--accent)" : "var(--text-primary)",
        fontSize: 13,
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <ThemeSwatch theme={theme} />
      <span style={{ flex: 1 }}>{theme.displayName}</span>
      {selected && (
        <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>
          ✓
        </span>
      )}
    </button>
  );
}

// A tiny 4-color chip previewing the theme's base, accent, green, and red.
// Helps the boss recognize themes at a glance without having to read names.
function ThemeSwatch({ theme }: { theme: Theme }) {
  const colors = [
    theme.vars["--bg-base"],
    theme.vars["--accent"],
    theme.vars["--green"],
    theme.vars["--red"],
  ];
  return (
    <span
      style={{
        display: "inline-flex",
        width: 20,
        height: 20,
        borderRadius: 4,
        overflow: "hidden",
        border: "1px solid var(--border-light)",
        flexShrink: 0,
      }}
    >
      {colors.map((c, i) => (
        <span key={i} style={{ flex: 1, background: c, display: "block" }} />
      ))}
    </span>
  );
}
