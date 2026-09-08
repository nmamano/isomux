// Small isometric drawing kit for lobby props. Every prop is drawn in local
// floor coordinates: `a` runs along COL (screen down-right), `b` along ROW
// (screen down-left), `h` straight up. The prop's floor contact centre is the
// local origin. iso() projects to screen units in the scene's SVG space.
//
// Light comes from the window on the left wall, like the office: a box's top
// is brightest, the face towards the left (b = +d/2) is lit, the face towards
// the right (a = +w/2) is in shade.

export function iso(a: number, b: number, h = 0): [number, number] {
  return [a - b, (a + b) / 2 - h];
}

export function pts(list: Array<[number, number, number]>): string {
  return list.map(([a, b, h]) => iso(a, b, h).join(" ")).join(" L");
}

export function poly(list: Array<[number, number, number]>): string {
  return `M${pts(list)} Z`;
}

// Mix a hex colour: f < 1 multiplies towards black, f > 1 mixes towards white.
export function shade(hex: string, f: number): string {
  const n = hex.replace("#", "");
  const full =
    n.length === 3
      ? n
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : n;
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  const out = ch.map((v) => {
    const m = f <= 1 ? v * f : v + (255 - v) * (f - 1);
    return Math.max(0, Math.min(255, Math.round(m)));
  });
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export interface IsoBoxProps {
  w: number; // extent along a (COL)
  d: number; // extent along b (ROW)
  h: number; // height
  a?: number; // centre offset along a
  b?: number; // centre offset along b
  z?: number; // base height
  color: string;
  top?: string;
  left?: string;
  right?: string;
  stroke?: string;
  strokeWidth?: number;
}

// A shaded block. Faces are drawn back to front: right (shaded), left (lit),
// then top, so a thin stroke never cuts across a lit face.
export function IsoBox({
  w,
  d,
  h,
  a = 0,
  b = 0,
  z = 0,
  color,
  top,
  left,
  right,
  stroke,
  strokeWidth = 0.5,
}: IsoBoxProps) {
  const a0 = a - w / 2,
    a1 = a + w / 2,
    b0 = b - d / 2,
    b1 = b + d / 2;
  const s = stroke ?? shade(color, 0.55);
  return (
    <g>
      <path
        d={poly([
          [a1, b0, z],
          [a1, b1, z],
          [a1, b1, z + h],
          [a1, b0, z + h],
        ])}
        fill={right ?? shade(color, 0.74)}
        stroke={s}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <path
        d={poly([
          [a0, b1, z],
          [a1, b1, z],
          [a1, b1, z + h],
          [a0, b1, z + h],
        ])}
        fill={left ?? shade(color, 0.92)}
        stroke={s}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <path
        d={poly([
          [a0, b0, z + h],
          [a1, b0, z + h],
          [a1, b1, z + h],
          [a0, b1, z + h],
        ])}
        fill={top ?? shade(color, 1.16)}
        stroke={s}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </g>
  );
}

// A vertical cylinder standing on the floor at local (a, b): the front half
// of the body plus the top disc. The body takes a horizontal gradient so the
// lit side faces the window.
export function IsoCylinder({
  r,
  h,
  a = 0,
  b = 0,
  z = 0,
  color,
  gradId,
  stroke,
}: {
  r: number;
  h: number;
  a?: number;
  b?: number;
  z?: number;
  color: string;
  gradId: string;
  stroke?: string;
}) {
  const [cx, cy] = iso(a, b, z);
  const ry = r / 2;
  const s = stroke ?? shade(color, 0.55);
  return (
    <g>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={shade(color, 1.05)} />
          <stop offset="0.55" stopColor={color} />
          <stop offset="1" stopColor={shade(color, 0.7)} />
        </linearGradient>
      </defs>
      <path
        d={`M${cx - r} ${cy - h} L${cx - r} ${cy} A${r} ${ry} 0 0 0 ${cx + r} ${cy} L${cx + r} ${cy - h} Z`}
        fill={`url(#${gradId})`}
        stroke={s}
        strokeWidth="0.5"
      />
      <ellipse
        cx={cx}
        cy={cy - h}
        rx={r}
        ry={ry}
        fill={shade(color, 1.18)}
        stroke={s}
        strokeWidth="0.5"
      />
    </g>
  );
}

// Contact shadow under a prop: centred, faint, solid core with a soft edge.
// Needs the `lobby-shadow` gradient from ShadowDefs once per SVG.
export function ContactShadow({
  rx,
  ry,
  a = 0,
  b = 0,
  opacity = 1,
}: {
  rx: number;
  ry: number;
  a?: number;
  b?: number;
  opacity?: number;
}) {
  const [cx, cy] = iso(a, b, 0);
  return (
    <ellipse
      cx={cx}
      cy={cy}
      rx={rx}
      ry={ry}
      fill="url(#lobby-shadow)"
      opacity={opacity}
    />
  );
}

export function ShadowDefs({ dark }: { dark: boolean }) {
  const o = dark ? 0.34 : 0.18;
  return (
    <defs>
      <radialGradient id="lobby-shadow">
        <stop offset="0" stopColor="#000" stopOpacity={o} />
        <stop offset="0.62" stopColor="#000" stopOpacity={o} />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

// Transform that maps a flat drawing (x along the wall, y up) onto a wall
// plane. Left wall runs up-right on screen, right wall runs down-right.
export function wallTransform(
  wall: "left" | "right",
  x: number,
  y: number,
): string {
  return wall === "left"
    ? `matrix(1 -0.5 0 1 ${x} ${y})`
    : `matrix(1 0.5 0 1 ${x} ${y})`;
}
