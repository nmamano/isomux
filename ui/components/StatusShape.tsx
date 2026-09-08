// Draw UI marks so mobile browsers cannot replace them with color emoji.
export function StatusShape({
  kind,
  rotate = 0,
}: {
  kind: "triangle" | "dot" | "check";
  rotate?: number;
}) {
  // Same CSS circle as AppsView's StateDot, inheriting the surrounding color.
  if (kind === "dot")
    return (
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          flexShrink: 0,
          background: "currentColor",
        }}
      />
    );
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 12 12"
      style={{
        display: "inline-block",
        verticalAlign: "-0.1em",
        flexShrink: 0,
        transform: `rotate(${rotate}deg)`,
      }}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "triangle" && (
        <path d="M3 1 L11 6 L3 11 Z" fill="currentColor" stroke="none" />
      )}
      {kind === "check" && <path d="M1.5 6 L4.5 9 L10.5 2.5" />}
    </svg>
  );
}
