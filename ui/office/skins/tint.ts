import { getThemeById } from "../../themes.ts";

// A room tint repaints the walls and the floor in one hue and keeps the
// theme's lightness, so a tinted room reads as the same theme in another
// colour: dark walls stay dark, light walls stay light, and the desks, the
// characters and the text keep their contrast under every theme.

export type RoomTint = "clinic" | "teal" | "sky" | "lilac" | "rose" | "clay";

/** Hue in OKLCH degrees, and the chroma the walls take. The floor takes half,
 *  so the walls carry the colour and the floor only follows it. Equal chroma
 *  does not look equal across hues - blue and violet read stronger than
 *  yellow-green - so each tint has its own, set by eye on the dark and the
 *  light theme. A dark yellow reads as brown, so there is no yellow. */
const TINTS: Record<RoomTint, { hue: number; chroma: number }> = {
  clinic: { hue: 148, chroma: 0.045 },
  teal: { hue: 195, chroma: 0.038 },
  sky: { hue: 250, chroma: 0.032 },
  lilac: { hue: 305, chroma: 0.034 },
  rose: { hue: 10, chroma: 0.034 },
  clay: { hue: 45, chroma: 0.034 },
};

export function isRoomTint(value: string): value is RoomTint {
  return Object.hasOwn(TINTS, value);
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
}

/** The OKLab lightness of a #rrggbb colour. */
function oklabLightness(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

function oklchToHex(L: number, C: number, hueDeg: number): string {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return (
    "#" +
    [r, g, bl]
      .map((c) =>
        Math.round(linearToSrgb(c) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

// What a tint repaints: the walls carry the colour; the floor and the plates
// hung on the walls (the name plate among them) take half of it and follow.
const WALLS = ["--wall-left", "--wall-right"] as const;
const FOLLOWERS = [
  "--floor-light",
  "--floor-dark",
  "--wall-decor",
  "--wall-decor-inner",
] as const;
const BASES: readonly string[] = [...WALLS, ...FOLLOWERS];

/** The scene variables a tinted room overrides under one theme. */
export function tintSceneVars(
  tint: RoomTint,
  themeId: string,
): Record<string, string> {
  const theme = getThemeById(themeId);
  const vars: Record<string, string> = theme.vars;
  const { hue, chroma } = TINTS[tint];
  // Light walls show the same chroma more strongly than dark ones.
  const wallChroma = theme.mode === "light" ? chroma * 0.8 : chroma;
  const out: Record<string, string> = {};
  for (const name of WALLS) {
    out[name] = oklchToHex(oklabLightness(vars[name]), wallChroma, hue);
  }
  for (const name of FOLLOWERS) {
    out[name] = oklchToHex(oklabLightness(vars[name]), wallChroma / 2, hue);
  }
  // The faces the theme builds from these bases (cut faces, slab sides). A
  // var() inside a custom property resolves where it is DECLARED, so each is
  // declared again next to the tinted bases, with the theme's own expression,
  // to mix against them.
  for (const [name, value] of Object.entries(vars)) {
    if (BASES.some((base) => value.includes(`var(${base})`))) {
      out[name] = value;
    }
  }
  return out;
}
