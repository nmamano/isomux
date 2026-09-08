import type { ThemeMode } from "../../themes.ts";
import { ContactShadow, ShadowDefs, iso, poly, wallTransform } from "./iso.tsx";
import { lobbyColors } from "./palette.ts";
import { LOBBY_PROPS, PropDefs, type PropStar, type PropVariant } from "./props.tsx";
import type { DirectoryRoom } from "./props-decor.tsx";

// Contact sheet: every prop variant in its own cell, on a patch of floor (or
// wall) so shadows and skews read the way they will in a room.

const CELL_W = 210;
const CELL_H = 176;
const VIEW = `-105 -131 ${CELL_W} ${CELL_H}`;

function FloorPatch({ a: fa, b: fb }: { a: string; b: string }) {
  const boards = [];
  for (let i = -5; i < 5; i++) {
    boards.push(
      <path
        key={i}
        d={poly([
          [i * 10, -60, 0],
          [i * 10 + 10, -60, 0],
          [i * 10 + 10, 60, 0],
          [i * 10, 60, 0],
        ])}
        fill={i % 2 === 0 ? fa : fb}
        stroke="rgba(0,0,0,0.15)"
        strokeWidth="0.4"
      />,
    );
  }
  return <g clipPath="url(#lobby-sheet-floor)">{boards}</g>;
}

function Cell({
  variant,
  family,
  mode,
  rooms,
  officeName,
  star,
}: {
  variant: PropVariant;
  family: string;
  mode: ThemeMode;
  rooms: DirectoryRoom[];
  officeName: string;
  star: PropStar | null;
}) {
  const c = lobbyColors(mode);
  const C = variant.Component;
  const wall = "left" as const;
  return (
    <div style={{ width: CELL_W, textAlign: "center" }}>
      <svg width={CELL_W} height={CELL_H} viewBox={VIEW} overflow="visible">
        <ShadowDefs dark={mode === "dark"} />
        <PropDefs />
        <defs>
          <clipPath id="lobby-sheet-floor">
            <path d={poly([[-50, -50, 0], [50, -50, 0], [50, 50, 0], [-50, 50, 0]])} />
          </clipPath>
        </defs>
        {variant.wall ? (
          <g>
            <path
              d={`M-70 10 L-70 -110 L70 -110 L70 10 Z`}
              transform={wallTransform(wall, 0, 0)}
              fill={c.wallLeftBot}
            />
            <g transform="translate(0 -14)">
              <C rooms={rooms} officeName={officeName} wall={wall} star={star} back="far" />
            </g>
          </g>
        ) : (
          <g>
            <FloorPatch a={c.floorA} b={c.floorB} />
            {variant.shadow && (
              <ContactShadow rx={variant.shadow.rx} ry={variant.shadow.ry} />
            )}
            <C rooms={rooms} officeName={officeName} wall={wall} star={star} back="far" />
          </g>
        )}
        <circle cx={iso(0, 0, 0)[0]} cy={iso(0, 0, 0)[1]} r="0" />
      </svg>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          marginTop: -4,
          lineHeight: 1.3,
        }}
      >
        <span style={{ color: "var(--text-dim)" }}>{family} · </span>
        {variant.label}
        <div style={{ fontSize: 9, color: "var(--text-dim)" }}>{variant.id}</div>
      </div>
    </div>
  );
}

export function PropSheet({
  mode,
  rooms,
  officeName,
  star,
}: {
  mode: ThemeMode;
  rooms: DirectoryRoom[];
  officeName: string;
  star: PropStar | null;
}) {
  return (
    <div style={{ padding: "12px 8px" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px 4px",
          justifyContent: "center",
        }}
      >
        {LOBBY_PROPS.flatMap((f) =>
          f.variants.map((v) => (
            <Cell
              key={`${f.id}-${v.id}`}
              variant={v}
              family={f.label}
              mode={mode}
              rooms={rooms}
              officeName={officeName}
              star={star}
            />
          )),
        )}
      </div>
    </div>
  );
}
