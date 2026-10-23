// The dark edge around the office screen. The back room draws it stronger
// (Nil, task c18ef3e8): a basement is darker in its corners.
export function Vignette({ strong = false }: { strong?: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        boxShadow: strong
          ? "inset 0 0 160px var(--vignette), inset 0 0 160px var(--vignette), inset 0 0 60px var(--vignette)"
          : "inset 0 0 120px var(--vignette)",
      }}
    />
  );
}
