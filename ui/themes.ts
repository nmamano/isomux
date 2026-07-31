// Theme registry. Each theme is a `data-theme="<id>"` attribute value on
// <html>, plus a `data-theme-mode` ('dark'|'light') for the few CSS rules
// that must branch on mode rather than on a specific theme (lamp glow,
// window day/night, neon sign, diff2html palette).
//
// All ~73 CSS variables are defined per theme. Existing Dark and Light
// values are byte-for-byte preserved from the original styles.ts. New
// themes (Nord, Dracula, Solarized Dark/Light) supply the same shape;
// office-scene props are picked to fit each palette rather than hand-tuned
// pixel-by-pixel.

export type ThemeMode = "dark" | "light";

// The Dark theme acts as the canonical variable schema: every other theme
// must define the same keys. (Enforced by the `ThemeVars` type below.)
const DARK_VARS = {
  "--bg-base": "#0a0e16",
  "--bg-surface": "rgba(15,20,32,0.95)",
  "--bg-surface-solid": "#0f1420",
  "--bg-overlay": "rgba(14,20,35,0.96)",
  "--bg-overlay-solid": "#0e1423",
  "--bg-input": "rgba(0,0,0,0.3)",
  "--bg-hover": "rgba(255,255,255,0.04)",
  "--bg-subtle": "rgba(255,255,255,0.02)",
  "--bg-code": "rgba(255,255,255,0.06)",
  "--bg-code-block": "rgba(0,0,0,0.3)",
  "--bg-hud": "rgba(10,14,22,0.7)",
  "--bg-hud-bottom": "rgba(10,14,22,0.5)",
  "--bg-tag": "rgba(10,14,25,0.88)",
  "--bg-tooltip": "rgba(10,14,25,0.94)",

  "--text-primary": "#e0e8f5",
  "--text-secondary": "#c0c8d8",
  "--text-dim": "#8a9ab8",
  "--text-muted": "#5a6f8f",
  "--text-faint": "#4a5a7a",
  "--text-ghost": "#3a4a6a",
  "--text-hint": "#3a4a68",

  "--border": "rgba(255,255,255,0.06)",
  "--border-subtle": "rgba(255,255,255,0.03)",
  "--border-medium": "rgba(255,255,255,0.07)",
  "--border-light": "rgba(255,255,255,0.08)",
  "--border-strong": "rgba(255,255,255,0.05)",

  "--accent": "#7eb8ff",
  "--accent-bg": "rgba(126,184,255,0.08)",
  "--accent-hover": "rgba(126,184,255,0.06)",
  "--accent-glow": "rgba(126,184,255,0.15)",
  "--green": "#50B86C",
  "--green-bg": "rgba(80,184,108,0.04)",
  "--green-border": "rgba(80,184,108,0.15)",
  "--orange": "#F5A623",
  "--orange-bg": "rgba(245,166,35,0.15)",
  "--orange-border": "rgba(245,166,35,0.3)",
  "--red": "#E85D75",
  "--red-bg": "rgba(232,93,117,0.08)",
  "--purple": "#9B6DFF",

  "--user-msg-bg": "rgba(126,184,255,0.08)",
  "--tool-result-bg": "rgba(0,0,0,0.15)",
  "--tool-call-bg": "rgba(80,184,108,0.04)",
  // Isomux API tool-call cards (see LogEntryCard). Dedicated so light themes
  // can tint them distinctly from ordinary (green) tool calls - on white the
  // plain --accent-bg tint is too faint to tell apart. Dark themes keep the
  // accent tint + neutral border (matches --accent-bg / --border here).
  "--isomux-card-bg": "rgba(126,184,255,0.08)",
  "--isomux-card-border": "rgba(255,255,255,0.06)",
  "--tool-open-bg": "rgba(0,0,0,0.2)",
  "--thinking-bg": "rgba(255,255,255,0.015)",
  "--thinking-border": "rgba(255,255,255,0.05)",
  "--shadow": "rgba(0,0,0,0.4)",
  "--shadow-heavy": "rgba(0,0,0,0.5)",
  "--vignette": "rgba(0,0,0,0.4)",
  "--monitor-text": "rgba(160,200,255,0.5)",
  "--desk-shadow": "rgba(0,0,0,0.2)",

  "--floor-light": "#181e2e",
  "--floor-dark": "#151b28",
  "--floor-stroke": "rgba(255,255,255,0.018)",
  "--wall-left": "#111825",
  "--wall-right": "#0f1520",
  "--wall-stroke": "rgba(255,255,255,0.025)",
  "--whiteboard-outer": "#1a2236",
  "--whiteboard-inner": "#1e2840",
  "--wall-decor": "#1a2236",
  "--wall-decor-inner": "#151d2c",
  "--wall-decor-stroke": "rgba(255,255,255,0.06)",
  "--clock-hand": "rgba(255,255,255,0.4)",
  "--room-prop-body": "#2a3548",
  "--room-prop-accent": "#3a5070",
  "--room-prop-base": "#222d3a",

  "--ambient-1": "rgba(126,184,255,0.025)",
  "--ambient-2": "rgba(80,184,108,0.015)",
  "--ambient-3": "rgba(245,166,35,0.01)",

  "--btn-surface": "rgba(255,255,255,0.03)",
  "--expand-btn": "rgba(255,255,255,0.04)",

  "--hljs-keyword": "#c678dd",
  "--hljs-string": "#98c379",
  "--hljs-comment": "#5c6370",
  "--hljs-number": "#d19a66",
  "--hljs-function": "#61afef",
  "--hljs-type": "#e5c07b",
  "--hljs-variable": "#e06c75",
  "--hljs-regexp": "#56b6c2",
  "--hljs-symbol": "#56b6c2",
  "--hljs-meta": "#abb2bf",
  "--hljs-deletion": "#e06c75",
} as const;

export type ThemeVars = Record<keyof typeof DARK_VARS, string>;

const LIGHT_VARS: ThemeVars = {
  "--bg-base": "#f0f2f6",
  "--bg-surface": "rgba(255,255,255,0.92)",
  "--bg-surface-solid": "#ffffff",
  "--bg-overlay": "rgba(255,255,255,0.96)",
  "--bg-overlay-solid": "#ffffff",
  "--bg-input": "rgba(0,0,0,0.04)",
  "--bg-hover": "rgba(0,0,0,0.04)",
  "--bg-subtle": "rgba(0,0,0,0.02)",
  "--bg-code": "rgba(0,0,0,0.05)",
  "--bg-code-block": "rgba(0,0,0,0.04)",
  "--bg-hud": "rgba(255,255,255,0.85)",
  "--bg-hud-bottom": "rgba(255,255,255,0.7)",
  "--bg-tag": "rgba(255,255,255,0.92)",
  "--bg-tooltip": "rgba(255,255,255,0.96)",

  "--text-primary": "#1a2030",
  "--text-secondary": "#3a4a60",
  "--text-dim": "#5a6a80",
  "--text-muted": "#7a8a9a",
  "--text-faint": "#8a95a8",
  "--text-ghost": "#a0aab8",
  "--text-hint": "#b0b8c5",

  "--border": "rgba(0,0,0,0.08)",
  "--border-subtle": "rgba(0,0,0,0.04)",
  "--border-medium": "rgba(0,0,0,0.10)",
  "--border-light": "rgba(0,0,0,0.10)",
  "--border-strong": "rgba(0,0,0,0.08)",

  "--accent": "#3b82f6",
  "--accent-bg": "rgba(59,130,246,0.08)",
  "--accent-hover": "rgba(59,130,246,0.06)",
  "--accent-glow": "rgba(59,130,246,0.12)",
  "--green": "#16a34a",
  "--green-bg": "rgba(22,163,74,0.06)",
  "--green-border": "rgba(22,163,74,0.2)",
  "--orange": "#d97706",
  "--orange-bg": "rgba(217,119,6,0.1)",
  "--orange-border": "rgba(217,119,6,0.25)",
  "--red": "#dc2626",
  "--red-bg": "rgba(220,38,38,0.06)",
  "--purple": "#7c3aed",

  "--user-msg-bg": "rgba(59,130,246,0.07)",
  "--tool-result-bg": "rgba(0,0,0,0.03)",
  "--tool-call-bg": "rgba(22,163,74,0.05)",
  // Stronger than --accent-bg (0.08) + an accent-colored border so isomux
  // cards read as clearly blue against the green tool calls in light mode.
  "--isomux-card-bg": "rgba(59,130,246,0.12)",
  "--isomux-card-border": "rgba(59,130,246,0.28)",
  "--tool-open-bg": "rgba(0,0,0,0.04)",
  "--thinking-bg": "rgba(0,0,0,0.02)",
  "--thinking-border": "rgba(0,0,0,0.06)",
  "--shadow": "rgba(0,0,0,0.08)",
  "--shadow-heavy": "rgba(0,0,0,0.12)",
  "--vignette": "rgba(0,0,0,0.06)",
  "--monitor-text": "rgba(30,60,120,0.4)",
  "--desk-shadow": "rgba(0,0,0,0.08)",

  "--floor-light": "#d8dce8",
  "--floor-dark": "#cdd2de",
  "--floor-stroke": "rgba(0,0,0,0.04)",
  "--wall-left": "#c5cad8",
  "--wall-right": "#bcc2d0",
  "--wall-stroke": "rgba(0,0,0,0.06)",
  "--whiteboard-outer": "#e8ecf4",
  "--whiteboard-inner": "#f0f4fc",
  "--wall-decor": "#e0e4ee",
  "--wall-decor-inner": "#eaecf4",
  "--wall-decor-stroke": "rgba(0,0,0,0.08)",
  "--clock-hand": "rgba(0,0,0,0.5)",
  "--room-prop-body": "#c8d0e0",
  "--room-prop-accent": "#a0b0c8",
  "--room-prop-base": "#b8c0d0",

  "--ambient-1": "rgba(59,130,246,0.03)",
  "--ambient-2": "rgba(22,163,74,0.02)",
  "--ambient-3": "rgba(217,119,6,0.015)",

  "--btn-surface": "rgba(0,0,0,0.03)",
  "--expand-btn": "rgba(0,0,0,0.04)",

  "--hljs-keyword": "#a626a4",
  "--hljs-string": "#50a14f",
  "--hljs-comment": "#a0a1a7",
  "--hljs-number": "#986801",
  "--hljs-function": "#4078f2",
  "--hljs-type": "#c18401",
  "--hljs-variable": "#e45649",
  "--hljs-regexp": "#0184bc",
  "--hljs-symbol": "#0184bc",
  "--hljs-meta": "#696c77",
  "--hljs-deletion": "#e45649",
};

// Nord - Polar Night background, Frost accents.
// Palette ref: https://www.nordtheme.com/
const NORD_VARS: ThemeVars = {
  "--bg-base": "#2e3440",
  "--bg-surface": "rgba(59,66,82,0.95)",
  "--bg-surface-solid": "#3b4252",
  "--bg-overlay": "rgba(46,52,64,0.96)",
  "--bg-overlay-solid": "#2e3440",
  "--bg-input": "rgba(0,0,0,0.3)",
  "--bg-hover": "rgba(255,255,255,0.04)",
  "--bg-subtle": "rgba(255,255,255,0.02)",
  "--bg-code": "rgba(255,255,255,0.06)",
  "--bg-code-block": "rgba(0,0,0,0.3)",
  "--bg-hud": "rgba(46,52,64,0.7)",
  "--bg-hud-bottom": "rgba(46,52,64,0.5)",
  "--bg-tag": "rgba(46,52,64,0.88)",
  "--bg-tooltip": "rgba(46,52,64,0.94)",

  "--text-primary": "#eceff4",
  "--text-secondary": "#d8dee9",
  "--text-dim": "#b8c2d2",
  "--text-muted": "#9aa3b5",
  "--text-faint": "#828c9e",
  "--text-ghost": "#6b748a",
  "--text-hint": "#5e6776",

  "--border": "rgba(255,255,255,0.06)",
  "--border-subtle": "rgba(255,255,255,0.03)",
  "--border-medium": "rgba(255,255,255,0.07)",
  "--border-light": "rgba(255,255,255,0.08)",
  "--border-strong": "rgba(255,255,255,0.05)",

  "--accent": "#88c0d0",
  "--accent-bg": "rgba(136,192,208,0.08)",
  "--accent-hover": "rgba(136,192,208,0.06)",
  "--accent-glow": "rgba(136,192,208,0.15)",
  "--green": "#a3be8c",
  "--green-bg": "rgba(163,190,140,0.04)",
  "--green-border": "rgba(163,190,140,0.15)",
  "--orange": "#d08770",
  "--orange-bg": "rgba(208,135,112,0.15)",
  "--orange-border": "rgba(208,135,112,0.3)",
  "--red": "#bf616a",
  "--red-bg": "rgba(191,97,106,0.08)",
  "--purple": "#b48ead",

  "--user-msg-bg": "rgba(136,192,208,0.08)",
  "--tool-result-bg": "rgba(0,0,0,0.15)",
  "--tool-call-bg": "rgba(163,190,140,0.04)",
  "--isomux-card-bg": "rgba(136,192,208,0.08)",
  "--isomux-card-border": "rgba(255,255,255,0.06)",
  "--tool-open-bg": "rgba(0,0,0,0.2)",
  "--thinking-bg": "rgba(255,255,255,0.015)",
  "--thinking-border": "rgba(255,255,255,0.05)",
  "--shadow": "rgba(0,0,0,0.4)",
  "--shadow-heavy": "rgba(0,0,0,0.5)",
  "--vignette": "rgba(0,0,0,0.4)",
  "--monitor-text": "rgba(136,192,208,0.5)",
  "--desk-shadow": "rgba(0,0,0,0.2)",

  "--floor-light": "#393f4e",
  "--floor-dark": "#353a48",
  "--floor-stroke": "rgba(255,255,255,0.018)",
  "--wall-left": "#2a313e",
  "--wall-right": "#283040",
  "--wall-stroke": "rgba(255,255,255,0.025)",
  "--whiteboard-outer": "#3b4458",
  "--whiteboard-inner": "#424d65",
  "--wall-decor": "#3b4458",
  "--wall-decor-inner": "#353d50",
  "--wall-decor-stroke": "rgba(255,255,255,0.06)",
  "--clock-hand": "rgba(255,255,255,0.4)",
  "--room-prop-body": "#4c566a",
  "--room-prop-accent": "#5e81ac",
  "--room-prop-base": "#434c5e",

  "--ambient-1": "rgba(136,192,208,0.025)",
  "--ambient-2": "rgba(163,190,140,0.015)",
  "--ambient-3": "rgba(208,135,112,0.01)",

  "--btn-surface": "rgba(255,255,255,0.03)",
  "--expand-btn": "rgba(255,255,255,0.04)",

  "--hljs-keyword": "#81a1c1",
  "--hljs-string": "#a3be8c",
  "--hljs-comment": "#4c566a",
  "--hljs-number": "#b48ead",
  "--hljs-function": "#88c0d0",
  "--hljs-type": "#ebcb8b",
  "--hljs-variable": "#d08770",
  "--hljs-regexp": "#ebcb8b",
  "--hljs-symbol": "#ebcb8b",
  "--hljs-meta": "#d8dee9",
  "--hljs-deletion": "#bf616a",
};

// Dracula - purple/pink accents on a near-black background.
// Palette ref: https://draculatheme.com/contribute
const DRACULA_VARS: ThemeVars = {
  "--bg-base": "#282a36",
  "--bg-surface": "rgba(40,42,54,0.95)",
  "--bg-surface-solid": "#2c2e3a",
  "--bg-overlay": "rgba(40,42,54,0.96)",
  "--bg-overlay-solid": "#282a36",
  "--bg-input": "rgba(0,0,0,0.3)",
  "--bg-hover": "rgba(255,255,255,0.04)",
  "--bg-subtle": "rgba(255,255,255,0.02)",
  "--bg-code": "rgba(255,255,255,0.06)",
  "--bg-code-block": "rgba(0,0,0,0.3)",
  "--bg-hud": "rgba(30,32,42,0.7)",
  "--bg-hud-bottom": "rgba(30,32,42,0.5)",
  "--bg-tag": "rgba(30,32,42,0.88)",
  "--bg-tooltip": "rgba(30,32,42,0.94)",

  "--text-primary": "#f8f8f2",
  "--text-secondary": "#dcdcd6",
  "--text-dim": "#a3a3a8",
  "--text-muted": "#757585",
  "--text-faint": "#6272a4",
  "--text-ghost": "#4d5878",
  "--text-hint": "#404a65",

  "--border": "rgba(255,255,255,0.06)",
  "--border-subtle": "rgba(255,255,255,0.03)",
  "--border-medium": "rgba(255,255,255,0.07)",
  "--border-light": "rgba(255,255,255,0.08)",
  "--border-strong": "rgba(255,255,255,0.05)",

  "--accent": "#bd93f9",
  "--accent-bg": "rgba(189,147,249,0.08)",
  "--accent-hover": "rgba(189,147,249,0.06)",
  "--accent-glow": "rgba(189,147,249,0.15)",
  "--green": "#50fa7b",
  "--green-bg": "rgba(80,250,123,0.04)",
  "--green-border": "rgba(80,250,123,0.15)",
  "--orange": "#ffb86c",
  "--orange-bg": "rgba(255,184,108,0.15)",
  "--orange-border": "rgba(255,184,108,0.3)",
  "--red": "#ff5555",
  "--red-bg": "rgba(255,85,85,0.08)",
  "--purple": "#ff79c6",

  "--user-msg-bg": "rgba(189,147,249,0.08)",
  "--tool-result-bg": "rgba(0,0,0,0.15)",
  "--tool-call-bg": "rgba(80,250,123,0.04)",
  "--isomux-card-bg": "rgba(189,147,249,0.08)",
  "--isomux-card-border": "rgba(255,255,255,0.06)",
  "--tool-open-bg": "rgba(0,0,0,0.2)",
  "--thinking-bg": "rgba(255,255,255,0.015)",
  "--thinking-border": "rgba(255,255,255,0.05)",
  "--shadow": "rgba(0,0,0,0.4)",
  "--shadow-heavy": "rgba(0,0,0,0.5)",
  "--vignette": "rgba(0,0,0,0.4)",
  "--monitor-text": "rgba(189,147,249,0.5)",
  "--desk-shadow": "rgba(0,0,0,0.2)",

  "--floor-light": "#353846",
  "--floor-dark": "#2f323e",
  "--floor-stroke": "rgba(255,255,255,0.018)",
  "--wall-left": "#232532",
  "--wall-right": "#1f2230",
  "--wall-stroke": "rgba(255,255,255,0.025)",
  "--whiteboard-outer": "#383b4c",
  "--whiteboard-inner": "#424659",
  "--wall-decor": "#383b4c",
  "--wall-decor-inner": "#2e3140",
  "--wall-decor-stroke": "rgba(255,255,255,0.06)",
  "--clock-hand": "rgba(255,255,255,0.4)",
  "--room-prop-body": "#44475a",
  "--room-prop-accent": "#6272a4",
  "--room-prop-base": "#383a4a",

  "--ambient-1": "rgba(189,147,249,0.025)",
  "--ambient-2": "rgba(80,250,123,0.015)",
  "--ambient-3": "rgba(255,184,108,0.01)",

  "--btn-surface": "rgba(255,255,255,0.03)",
  "--expand-btn": "rgba(255,255,255,0.04)",

  "--hljs-keyword": "#ff79c6",
  "--hljs-string": "#f1fa8c",
  "--hljs-comment": "#6272a4",
  "--hljs-number": "#bd93f9",
  "--hljs-function": "#50fa7b",
  "--hljs-type": "#8be9fd",
  "--hljs-variable": "#ffb86c",
  "--hljs-regexp": "#ff5555",
  "--hljs-symbol": "#8be9fd",
  "--hljs-meta": "#f8f8f2",
  "--hljs-deletion": "#ff5555",
};

// Solarized Dark - Ethan Schoonover's palette.
// Palette ref: https://ethanschoonover.com/solarized/
const SOLARIZED_DARK_VARS: ThemeVars = {
  "--bg-base": "#002b36",
  "--bg-surface": "rgba(0,43,54,0.95)",
  "--bg-surface-solid": "#073642",
  "--bg-overlay": "rgba(0,43,54,0.96)",
  "--bg-overlay-solid": "#002b36",
  "--bg-input": "rgba(0,0,0,0.3)",
  "--bg-hover": "rgba(255,255,255,0.04)",
  "--bg-subtle": "rgba(255,255,255,0.02)",
  "--bg-code": "rgba(255,255,255,0.06)",
  "--bg-code-block": "rgba(0,0,0,0.3)",
  "--bg-hud": "rgba(0,43,54,0.7)",
  "--bg-hud-bottom": "rgba(0,43,54,0.5)",
  "--bg-tag": "rgba(0,43,54,0.88)",
  "--bg-tooltip": "rgba(0,43,54,0.94)",

  "--text-primary": "#fdf6e3",
  "--text-secondary": "#eee8d5",
  "--text-dim": "#93a1a1",
  "--text-muted": "#839496",
  "--text-faint": "#657b83",
  "--text-ghost": "#586e75",
  "--text-hint": "#4a6066",

  "--border": "rgba(255,255,255,0.06)",
  "--border-subtle": "rgba(255,255,255,0.03)",
  "--border-medium": "rgba(255,255,255,0.07)",
  "--border-light": "rgba(255,255,255,0.08)",
  "--border-strong": "rgba(255,255,255,0.05)",

  "--accent": "#268bd2",
  "--accent-bg": "rgba(38,139,210,0.08)",
  "--accent-hover": "rgba(38,139,210,0.06)",
  "--accent-glow": "rgba(38,139,210,0.15)",
  "--green": "#859900",
  "--green-bg": "rgba(133,153,0,0.04)",
  "--green-border": "rgba(133,153,0,0.15)",
  "--orange": "#cb4b16",
  "--orange-bg": "rgba(203,75,22,0.15)",
  "--orange-border": "rgba(203,75,22,0.3)",
  "--red": "#dc322f",
  "--red-bg": "rgba(220,50,47,0.08)",
  "--purple": "#6c71c4",

  "--user-msg-bg": "rgba(38,139,210,0.08)",
  "--tool-result-bg": "rgba(0,0,0,0.15)",
  "--tool-call-bg": "rgba(133,153,0,0.04)",
  "--isomux-card-bg": "rgba(38,139,210,0.08)",
  "--isomux-card-border": "rgba(255,255,255,0.06)",
  "--tool-open-bg": "rgba(0,0,0,0.2)",
  "--thinking-bg": "rgba(255,255,255,0.015)",
  "--thinking-border": "rgba(255,255,255,0.05)",
  "--shadow": "rgba(0,0,0,0.4)",
  "--shadow-heavy": "rgba(0,0,0,0.5)",
  "--vignette": "rgba(0,0,0,0.4)",
  "--monitor-text": "rgba(38,139,210,0.5)",
  "--desk-shadow": "rgba(0,0,0,0.2)",

  "--floor-light": "#0c4250",
  "--floor-dark": "#073642",
  "--floor-stroke": "rgba(255,255,255,0.018)",
  "--wall-left": "#052a32",
  "--wall-right": "#03252c",
  "--wall-stroke": "rgba(255,255,255,0.025)",
  "--whiteboard-outer": "#0c4250",
  "--whiteboard-inner": "#0e4a58",
  "--wall-decor": "#0c4250",
  "--wall-decor-inner": "#073744",
  "--wall-decor-stroke": "rgba(255,255,255,0.06)",
  "--clock-hand": "rgba(255,255,255,0.4)",
  "--room-prop-body": "#586e75",
  "--room-prop-accent": "#6c71c4",
  "--room-prop-base": "#4a6066",

  "--ambient-1": "rgba(38,139,210,0.025)",
  "--ambient-2": "rgba(133,153,0,0.015)",
  "--ambient-3": "rgba(203,75,22,0.01)",

  "--btn-surface": "rgba(255,255,255,0.03)",
  "--expand-btn": "rgba(255,255,255,0.04)",

  "--hljs-keyword": "#859900",
  "--hljs-string": "#2aa198",
  "--hljs-comment": "#586e75",
  "--hljs-number": "#d33682",
  "--hljs-function": "#268bd2",
  "--hljs-type": "#b58900",
  "--hljs-variable": "#cb4b16",
  "--hljs-regexp": "#2aa198",
  "--hljs-symbol": "#d33682",
  "--hljs-meta": "#93a1a1",
  "--hljs-deletion": "#dc322f",
};

// Solarized Light - same accent palette as Solarized Dark, light base.
const SOLARIZED_LIGHT_VARS: ThemeVars = {
  "--bg-base": "#fdf6e3",
  "--bg-surface": "rgba(238,232,213,0.92)",
  "--bg-surface-solid": "#eee8d5",
  "--bg-overlay": "rgba(253,246,227,0.96)",
  "--bg-overlay-solid": "#fdf6e3",
  "--bg-input": "rgba(0,0,0,0.04)",
  "--bg-hover": "rgba(0,0,0,0.04)",
  "--bg-subtle": "rgba(0,0,0,0.02)",
  "--bg-code": "rgba(0,0,0,0.05)",
  "--bg-code-block": "rgba(0,0,0,0.04)",
  "--bg-hud": "rgba(253,246,227,0.85)",
  "--bg-hud-bottom": "rgba(253,246,227,0.7)",
  "--bg-tag": "rgba(253,246,227,0.92)",
  "--bg-tooltip": "rgba(253,246,227,0.96)",

  "--text-primary": "#073642",
  "--text-secondary": "#586e75",
  "--text-dim": "#657b83",
  "--text-muted": "#839496",
  "--text-faint": "#93a1a1",
  "--text-ghost": "#a8b3b3",
  "--text-hint": "#b8c2c2",

  "--border": "rgba(0,0,0,0.08)",
  "--border-subtle": "rgba(0,0,0,0.04)",
  "--border-medium": "rgba(0,0,0,0.10)",
  "--border-light": "rgba(0,0,0,0.10)",
  "--border-strong": "rgba(0,0,0,0.08)",

  "--accent": "#268bd2",
  "--accent-bg": "rgba(38,139,210,0.08)",
  "--accent-hover": "rgba(38,139,210,0.06)",
  "--accent-glow": "rgba(38,139,210,0.12)",
  "--green": "#859900",
  "--green-bg": "rgba(133,153,0,0.06)",
  "--green-border": "rgba(133,153,0,0.2)",
  "--orange": "#cb4b16",
  "--orange-bg": "rgba(203,75,22,0.1)",
  "--orange-border": "rgba(203,75,22,0.25)",
  "--red": "#dc322f",
  "--red-bg": "rgba(220,50,47,0.06)",
  "--purple": "#6c71c4",

  "--user-msg-bg": "rgba(38,139,210,0.07)",
  "--tool-result-bg": "rgba(0,0,0,0.03)",
  "--tool-call-bg": "rgba(133,153,0,0.05)",
  // Light theme: stronger accent tint + accent border (see LIGHT_VARS).
  "--isomux-card-bg": "rgba(38,139,210,0.12)",
  "--isomux-card-border": "rgba(38,139,210,0.28)",
  "--tool-open-bg": "rgba(0,0,0,0.04)",
  "--thinking-bg": "rgba(0,0,0,0.02)",
  "--thinking-border": "rgba(0,0,0,0.06)",
  "--shadow": "rgba(0,0,0,0.08)",
  "--shadow-heavy": "rgba(0,0,0,0.12)",
  "--vignette": "rgba(0,0,0,0.06)",
  "--monitor-text": "rgba(38,139,210,0.4)",
  "--desk-shadow": "rgba(0,0,0,0.08)",

  "--floor-light": "#ebe4d0",
  "--floor-dark": "#e0d9c5",
  "--floor-stroke": "rgba(0,0,0,0.04)",
  "--wall-left": "#d4ccb8",
  "--wall-right": "#cac2ae",
  "--wall-stroke": "rgba(0,0,0,0.06)",
  "--whiteboard-outer": "#f6efdb",
  "--whiteboard-inner": "#fdf6e3",
  "--wall-decor": "#ede5d1",
  "--wall-decor-inner": "#f3eddb",
  "--wall-decor-stroke": "rgba(0,0,0,0.08)",
  "--clock-hand": "rgba(0,0,0,0.5)",
  "--room-prop-body": "#d4ccb8",
  "--room-prop-accent": "#a8a085",
  "--room-prop-base": "#bfb8a3",

  "--ambient-1": "rgba(38,139,210,0.03)",
  "--ambient-2": "rgba(133,153,0,0.02)",
  "--ambient-3": "rgba(203,75,22,0.015)",

  "--btn-surface": "rgba(0,0,0,0.03)",
  "--expand-btn": "rgba(0,0,0,0.04)",

  "--hljs-keyword": "#859900",
  "--hljs-string": "#2aa198",
  "--hljs-comment": "#93a1a1",
  "--hljs-number": "#d33682",
  "--hljs-function": "#268bd2",
  "--hljs-type": "#b58900",
  "--hljs-variable": "#cb4b16",
  "--hljs-regexp": "#2aa198",
  "--hljs-symbol": "#d33682",
  "--hljs-meta": "#586e75",
  "--hljs-deletion": "#dc322f",
};

export interface Theme {
  id: string;
  displayName: string;
  mode: ThemeMode;
  vars: ThemeVars;
}

export const THEMES: readonly Theme[] = [
  { id: "dark", displayName: "Dark", mode: "dark", vars: DARK_VARS },
  { id: "light", displayName: "Light", mode: "light", vars: LIGHT_VARS },
  { id: "nord", displayName: "Nord", mode: "dark", vars: NORD_VARS },
  { id: "dracula", displayName: "Dracula", mode: "dark", vars: DRACULA_VARS },
  {
    id: "solarized-dark",
    displayName: "Solarized Dark",
    mode: "dark",
    vars: SOLARIZED_DARK_VARS,
  },
  {
    id: "solarized-light",
    displayName: "Solarized Light",
    mode: "light",
    vars: SOLARIZED_LIGHT_VARS,
  },
];

export const DEFAULT_THEME_ID = "dark";

export function getThemeById(id: string): Theme {
  return (
    THEMES.find((t) => t.id === id) ??
    THEMES.find((t) => t.id === DEFAULT_THEME_ID)!
  );
}

// Emit the per-theme CSS blocks. The first (Dark) doubles as `:root` so the
// page renders correctly before any `data-theme` attribute is applied.
export function emitThemesCss(): string {
  return THEMES.map((theme, index) => {
    const selector =
      index === 0
        ? `:root, [data-theme="${theme.id}"]`
        : `[data-theme="${theme.id}"]`;
    const declarations = Object.entries(theme.vars)
      .map(([name, value]) => `    ${name}: ${value};`)
      .join("\n");
    return `  /* Theme: ${theme.displayName} */\n  ${selector} {\n${declarations}\n    color-scheme: ${theme.mode};\n  }`;
  }).join("\n\n");
}
