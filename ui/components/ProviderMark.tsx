// A small mark for each model provider, next to its name on the
// Integrations page (Nil, 2026-10-13). Simple shapes drawn here, not the
// providers' logo files. SVG, never a glyph: iOS draws glyphs with the emoji
// font. The name is always next to the mark, so the mark is aria-hidden.

import type { AgentBackendType } from "../../shared/types.ts";

const tile = (size: number, background: string) => ({
  width: size,
  height: size,
  borderRadius: size / 4,
  background,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
});

// Claude: a spark of rays on the Claude terracotta.
function ClaudeMark({ size }: { size: number }) {
  const rays = [0, 30, 60, 90, 120, 150];
  return (
    <span aria-hidden data-provider-mark="claude" style={tile(size, "#d97757")}>
      <svg width={size * 0.66} height={size * 0.66} viewBox="0 0 20 20">
        {rays.map((angle) => (
          <line
            key={angle}
            x1="10"
            y1="2.5"
            x2="10"
            y2="17.5"
            stroke="#fff"
            strokeWidth="2.2"
            strokeLinecap="round"
            transform={`rotate(${angle} 10 10)`}
          />
        ))}
      </svg>
    </span>
  );
}

// Codex (OpenAI): three crossed loops on a dark tile.
function CodexMark({ size }: { size: number }) {
  return (
    <span aria-hidden data-provider-mark="codex" style={tile(size, "#202123")}>
      <svg width={size * 0.7} height={size * 0.7} viewBox="0 0 20 20">
        {[0, 60, 120].map((angle) => (
          <ellipse
            key={angle}
            cx="10"
            cy="10"
            rx="7.5"
            ry="3.4"
            fill="none"
            stroke="#fff"
            strokeWidth="1.6"
            transform={`rotate(${angle} 10 10)`}
          />
        ))}
      </svg>
    </span>
  );
}

// OpenCode: a square block in a square frame.
function OpenCodeMark({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      data-provider-mark="opencode"
      style={tile(size, "#131010")}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 20 20">
        <rect
          x="2.5"
          y="2.5"
          width="15"
          height="15"
          fill="none"
          stroke="#f1ecec"
          strokeWidth="2.6"
        />
        <rect x="7" y="9" width="6" height="6" fill="#b7b1b1" />
      </svg>
    </span>
  );
}

export function ProviderMark({
  provider,
  size = 22,
}: {
  provider: AgentBackendType;
  size?: number;
}) {
  switch (provider) {
    case "claude":
      return <ClaudeMark size={size} />;
    case "codex":
      return <CodexMark size={size} />;
    case "opencode":
      return <OpenCodeMark size={size} />;
  }
}
