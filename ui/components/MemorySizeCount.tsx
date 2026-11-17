// The size half of a memory "{size} / {cap}" line. The slot is as wide as the
// cap's digits from the first frame, so the "…" shown while the memory loads
// and the size that replaces it take the same room and the line keeps its
// width (AGENTS.md "UI rules": a view keeps its layout while it loads).

export function MemorySizeCount({
  size,
  cap,
  loaded,
}: {
  size: number;
  cap: number;
  loaded: boolean;
}) {
  return (
    <span
      data-memory-size=""
      style={{
        display: "inline-block",
        minWidth: `${String(cap).length}ch`,
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {loaded ? size : "…"}
    </span>
  );
}
