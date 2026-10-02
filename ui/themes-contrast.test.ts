import { describe, expect, it } from "bun:test";
import { THEMES, type ThemeVars } from "./themes.ts";
import { MODEL_STYLES, FALLBACK_PALETTE } from "./model-styles.ts";

// Every colour the UI draws as text holds WCAG AA (4.5:1) against every
// background it can sit on, in every theme. The backgrounds are the solid
// panels plus each translucent tint composited over them; the worst one
// decides.

type Rgb = [number, number, number];
const AA = 4.5;

function parse(color: string): { rgb: Rgb; alpha: number } {
  if (color.startsWith("#")) {
    const h = color.slice(1);
    return {
      rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb,
      alpha: 1,
    };
  }
  const parts = color
    .match(/rgba?\(([^)]+)\)/)![1]
    .split(",")
    .map(Number);
  return { rgb: [parts[0], parts[1], parts[2]], alpha: parts[3] ?? 1 };
}

function over(top: string, below: Rgb): Rgb {
  const { rgb, alpha } = parse(top);
  return rgb.map((c, i) => c * alpha + below[i] * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TINTS = [
  "--bg-input",
  "--bg-hover",
  "--bg-code",
  "--bg-code-block",
  "--user-msg-bg",
  "--isomux-card-bg",
  "--accent-bg",
  "--tool-result-bg",
  "--tool-open-bg",
  "--tool-call-bg",
  "--thinking-bg",
  "--btn-surface",
] as const;
const STATUS_TINTS = ["--green-bg", "--orange-bg", "--red-bg"] as const;

function backgrounds(v: ThemeVars, tints: readonly string[]): Rgb[] {
  const base = parse(v["--bg-base"]).rgb;
  const solids = [
    base,
    parse(v["--bg-surface-solid"]).rgb,
    parse(v["--bg-overlay-solid"]).rgb,
  ];
  const out: Rgb[] = [
    ...solids,
    over(v["--bg-surface"], base),
    over(v["--bg-overlay"], base),
  ];
  for (const solid of solids)
    for (const tint of tints) out.push(over(v[tint as keyof ThemeVars], solid));
  return out;
}

function worst(color: string, bgs: Rgb[]): number {
  const fg = parse(color).rgb;
  return Math.min(...bgs.map((bg) => contrast(fg, bg)));
}

const TEXT = ["primary", "secondary", "dim", "muted", "faint", "ghost", "hint"];
const HUES = ["accent", "green", "orange", "red", "purple"];

describe.each(THEMES.map((t) => [t.id, t] as const))("%s theme", (_, t) => {
  const v = t.vars;
  const neutral = backgrounds(v, TINTS);

  it("draws every --text-* colour at AA or better", () => {
    for (const k of TEXT) {
      const key = `--text-${k}` as keyof ThemeVars;
      expect({ key, ratio: worst(v[key], neutral) >= AA }).toEqual({
        key,
        ratio: true,
      });
    }
  });

  it("keeps the text tiers in order", () => {
    const panel = parse(v["--bg-overlay-solid"]).rgb;
    const ratios = TEXT.map((k) =>
      contrast(parse(v[`--text-${k}` as keyof ThemeVars]).rgb, panel),
    );
    for (let i = 1; i < ratios.length; i++)
      expect(ratios[i]).toBeLessThanOrEqual(ratios[i - 1]);
    // primary > secondary > dim > muted are visibly separate steps.
    for (let i = 1; i < 4; i++) expect(ratios[i]).toBeLessThan(ratios[i - 1]);
  });

  it("draws each status hue's text variant at AA, also as a labelled fill", () => {
    const withTints = backgrounds(v, [...TINTS, ...STATUS_TINTS]);
    const base = parse(v["--bg-base"]).rgb;
    for (const hue of HUES) {
      const key = `--${hue}-text` as keyof ThemeVars;
      expect({ key, text: worst(v[key], withTints) >= AA }).toEqual({
        key,
        text: true,
      });
      expect({
        key,
        label: contrast(base, parse(v[key]).rgb) >= AA,
      }).toEqual({ key, label: true });
    }
  });

  it("draws syntax colours at AA", () => {
    for (const key of Object.keys(v).filter((k) => k.startsWith("--hljs-")))
      expect({
        key,
        ratio: worst(v[key as keyof ThemeVars], neutral) >= AA,
      }).toEqual({ key, ratio: true });
  });

  it("holds agent names at AA on every nameplate tint over the floor and walls", () => {
    const fg = parse(v["--text-primary"]).rgb;
    const under = (
      ["--floor-light", "--floor-dark", "--wall-left", "--wall-right"] as const
    ).map((k) => parse(v[k]).rgb);
    for (const style of [...Object.values(MODEL_STYLES), ...FALLBACK_PALETTE])
      for (const u of under)
        expect({
          bg: style.bg,
          ratio: contrast(fg, over(style.bg, u)) >= AA,
        }).toEqual({ bg: style.bg, ratio: true });
  });
});
