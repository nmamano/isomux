// Draw UI marks so mobile browsers cannot replace them with color emoji.
export function StatusShape({
  kind,
  rotate = 0,
}: {
  kind: "triangle" | "dot" | "check" | "warning" | "hook" | "clock";
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
      {kind === "warning" && (
        <>
          <path d="M6 1.2 L11.2 10.6 H0.8 Z" />
          <path d="M6 4.6 V7" />
          <circle cx="6" cy="8.8" r="0.4" fill="currentColor" />
        </>
      )}
      {kind === "clock" && (
        <>
          <circle cx="6" cy="6" r="4.8" />
          <path d="M6 3.4 V6 L7.8 7.2" />
        </>
      )}
      {kind === "hook" && (
        <>
          <circle cx="7.5" cy="2.2" r="1.2" />
          <path d="M7.5 3.4 V7.6 A2.9 2.9 0 0 1 1.7 7.6 V6.2 L3.4 7.6" />
        </>
      )}
    </svg>
  );
}
