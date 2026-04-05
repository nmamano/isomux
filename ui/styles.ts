export const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  ::-webkit-scrollbar { width:6px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:var(--bg-hover); border-radius:3px; }
  .hide-scrollbar::-webkit-scrollbar { display:none; }
  .hide-scrollbar { scrollbar-width:none; -ms-overflow-style:none; }

  @keyframes waitBounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
  @keyframes errShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-2px)} 75%{transform:translateX(2px)} }
  @keyframes dotPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.7;transform:scale(1.15)} }
  @keyframes termEnter { from{opacity:0} to{opacity:1} }
  @keyframes hudIn { from{opacity:0;transform:translateY(4px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
  @keyframes toastSlide { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
  @keyframes dotBounce { 0%,80%,100%{opacity:0.3;transform:scale(0.8)} 40%{opacity:1;transform:scale(1.2)} }
  @keyframes fadeIn { from{opacity:0} to{opacity:1} }
  @keyframes mic-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(255,50,50,0.4)} 50%{box-shadow:0 0 0 6px rgba(255,50,50,0)} }

  /* Theme: Dark (default) */
  :root, [data-theme="dark"] {
    --bg-base: #0a0e16;
    --bg-surface: rgba(15,20,32,0.95);
    --bg-surface-solid: #0f1420;
    --bg-overlay: rgba(14,20,35,0.96);
    --bg-overlay-solid: #0e1423;
    --bg-input: rgba(0,0,0,0.3);
    --bg-hover: rgba(255,255,255,0.04);
    --bg-subtle: rgba(255,255,255,0.02);
    --bg-code: rgba(255,255,255,0.06);
    --bg-code-block: rgba(0,0,0,0.3);
    --bg-hud: rgba(10,14,22,0.7);
    --bg-hud-bottom: rgba(10,14,22,0.5);
    --bg-tag: rgba(10,14,25,0.88);
    --bg-tooltip: rgba(10,14,25,0.94);

    --text-primary: #e0e8f5;
    --text-secondary: #c0c8d8;
    --text-dim: #8a9ab8;
    --text-muted: #5a6f8f;
    --text-faint: #4a5a7a;
    --text-ghost: #3a4a6a;
    --text-hint: #3a4a68;

    --border: rgba(255,255,255,0.06);
    --border-subtle: rgba(255,255,255,0.03);
    --border-medium: rgba(255,255,255,0.07);
    --border-light: rgba(255,255,255,0.08);
    --border-strong: rgba(255,255,255,0.05);

    --accent: #7eb8ff;
    --accent-bg: rgba(126,184,255,0.08);
    --accent-hover: rgba(126,184,255,0.06);
    --accent-glow: rgba(126,184,255,0.15);
    --green: #50B86C;
    --green-bg: rgba(80,184,108,0.04);
    --green-border: rgba(80,184,108,0.15);
    --orange: #F5A623;
    --orange-bg: rgba(245,166,35,0.15);
    --orange-border: rgba(245,166,35,0.3);
    --red: #E85D75;
    --red-bg: rgba(232,93,117,0.08);
    --purple: #9B6DFF;

    --user-msg-bg: rgba(126,184,255,0.08);
    --tool-result-bg: rgba(0,0,0,0.15);
    --tool-call-bg: rgba(80,184,108,0.04);
    --tool-open-bg: rgba(0,0,0,0.2);
    --thinking-bg: rgba(255,255,255,0.015);
    --thinking-border: rgba(255,255,255,0.05);
    --shadow: rgba(0,0,0,0.4);
    --shadow-heavy: rgba(0,0,0,0.5);
    --vignette: rgba(0,0,0,0.4);
    --monitor-text: rgba(160,200,255,0.5);
    --desk-shadow: rgba(0,0,0,0.2);

    --floor-light: #181e2e;
    --floor-dark: #151b28;
    --floor-stroke: rgba(255,255,255,0.018);
    --wall-left: #111825;
    --wall-right: #0f1520;
    --wall-stroke: rgba(255,255,255,0.025);
    --whiteboard-outer: #1a2236;
    --whiteboard-inner: #1e2840;
    --wall-decor: #1a2236;
    --wall-decor-inner: #151d2c;
    --wall-decor-stroke: rgba(255,255,255,0.06);
    --clock-hand: rgba(255,255,255,0.4);
    --room-prop-body: #2a3548;
    --room-prop-accent: #3a5070;
    --room-prop-base: #222d3a;

    --ambient-1: rgba(126,184,255,0.025);
    --ambient-2: rgba(80,184,108,0.015);
    --ambient-3: rgba(245,166,35,0.01);

    --btn-surface: rgba(255,255,255,0.03);
    --expand-btn: rgba(255,255,255,0.04);

    --hljs-keyword: #c678dd;
    --hljs-string: #98c379;
    --hljs-comment: #5c6370;
    --hljs-number: #d19a66;
    --hljs-function: #61afef;
    --hljs-type: #e5c07b;
    --hljs-variable: #e06c75;
    --hljs-regexp: #56b6c2;
    --hljs-symbol: #56b6c2;
    --hljs-meta: #abb2bf;
    --hljs-deletion: #e06c75;

    color-scheme: dark;
  }

  /* Theme: Light */
  [data-theme="light"] {
    --bg-base: #f0f2f6;
    --bg-surface: rgba(255,255,255,0.92);
    --bg-surface-solid: #ffffff;
    --bg-overlay: rgba(255,255,255,0.96);
    --bg-overlay-solid: #ffffff;
    --bg-input: rgba(0,0,0,0.04);
    --bg-hover: rgba(0,0,0,0.04);
    --bg-subtle: rgba(0,0,0,0.02);
    --bg-code: rgba(0,0,0,0.05);
    --bg-code-block: rgba(0,0,0,0.04);
    --bg-hud: rgba(255,255,255,0.85);
    --bg-hud-bottom: rgba(255,255,255,0.7);
    --bg-tag: rgba(255,255,255,0.92);
    --bg-tooltip: rgba(255,255,255,0.96);

    --text-primary: #1a2030;
    --text-secondary: #3a4a60;
    --text-dim: #5a6a80;
    --text-muted: #7a8a9a;
    --text-faint: #8a95a8;
    --text-ghost: #a0aab8;
    --text-hint: #b0b8c5;

    --border: rgba(0,0,0,0.08);
    --border-subtle: rgba(0,0,0,0.04);
    --border-medium: rgba(0,0,0,0.10);
    --border-light: rgba(0,0,0,0.10);
    --border-strong: rgba(0,0,0,0.08);

    --accent: #3b82f6;
    --accent-bg: rgba(59,130,246,0.08);
    --accent-hover: rgba(59,130,246,0.06);
    --accent-glow: rgba(59,130,246,0.12);
    --green: #16a34a;
    --green-bg: rgba(22,163,74,0.06);
    --green-border: rgba(22,163,74,0.2);
    --orange: #d97706;
    --orange-bg: rgba(217,119,6,0.1);
    --orange-border: rgba(217,119,6,0.25);
    --red: #dc2626;
    --red-bg: rgba(220,38,38,0.06);
    --purple: #7c3aed;

    --user-msg-bg: rgba(59,130,246,0.07);
    --tool-result-bg: rgba(0,0,0,0.03);
    --tool-call-bg: rgba(22,163,74,0.05);
    --tool-open-bg: rgba(0,0,0,0.04);
    --thinking-bg: rgba(0,0,0,0.02);
    --thinking-border: rgba(0,0,0,0.06);
    --shadow: rgba(0,0,0,0.08);
    --shadow-heavy: rgba(0,0,0,0.12);
    --vignette: rgba(0,0,0,0.06);
    --monitor-text: rgba(30,60,120,0.4);
    --desk-shadow: rgba(0,0,0,0.08);

    --floor-light: #d8dce8;
    --floor-dark: #cdd2de;
    --floor-stroke: rgba(0,0,0,0.04);
    --wall-left: #c5cad8;
    --wall-right: #bcc2d0;
    --wall-stroke: rgba(0,0,0,0.06);
    --whiteboard-outer: #e8ecf4;
    --whiteboard-inner: #f0f4fc;
    --wall-decor: #e0e4ee;
    --wall-decor-inner: #eaecf4;
    --wall-decor-stroke: rgba(0,0,0,0.08);
    --clock-hand: rgba(0,0,0,0.5);
    --room-prop-body: #c8d0e0;
    --room-prop-accent: #a0b0c8;
    --room-prop-base: #b8c0d0;

    --ambient-1: rgba(59,130,246,0.03);
    --ambient-2: rgba(22,163,74,0.02);
    --ambient-3: rgba(217,119,6,0.015);

    --btn-surface: rgba(0,0,0,0.03);
    --expand-btn: rgba(0,0,0,0.04);

    --hljs-keyword: #a626a4;
    --hljs-string: #50a14f;
    --hljs-comment: #a0a1a7;
    --hljs-number: #986801;
    --hljs-function: #4078f2;
    --hljs-type: #c18401;
    --hljs-variable: #e45649;
    --hljs-regexp: #0184bc;
    --hljs-symbol: #0184bc;
    --hljs-meta: #696c77;
    --hljs-deletion: #e45649;

    color-scheme: light;
  }

  [data-theme="light"] .lamp-glow { display: none; }
  [data-theme="light"] .window-night { display: none; }
  :root .window-day, [data-theme="dark"] .window-day { display: none; }
  [data-theme="light"] .window-day { display: block; }
  .neon-sign-on { display: none; }
  .neon-sign-off { display: block; }
  [data-theme="dark"] .neon-sign-on { display: block; }
  [data-theme="dark"] .neon-sign-off { display: none; }

  @keyframes neonFlicker {
    0%, 100% { opacity: 1; }
    4% { opacity: 0.85; }
    6% { opacity: 1; }
    40% { opacity: 1; }
    42% { opacity: 0.7; }
    43% { opacity: 1; }
    80% { opacity: 1; }
    82% { opacity: 0.9; }
    83% { opacity: 1; }
  }

  body { background: var(--bg-base); overflow:hidden; }
  html, body { max-width: 100vw; overflow-x: hidden; }

  /* Markdown content styles */
  .md-content { font-family: 'DM Sans', sans-serif; font-size: 13px; line-height: 1.7; color: var(--text-secondary); }
  .md-content p { margin: 0 0 8px 0; }
  .md-content p:last-child { margin-bottom: 0; }
  .md-content strong { color: var(--text-primary); font-weight: 600; }
  .md-content em { color: var(--text-dim); }
  .md-content h1, .md-content h2, .md-content h3, .md-content h4 {
    color: var(--text-primary); margin: 12px 0 6px 0; font-weight: 600;
  }
  .md-content h1 { font-size: 16px; }
  .md-content h2 { font-size: 15px; }
  .md-content h3 { font-size: 14px; }
  .md-content code {
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
    background: var(--bg-code); padding: 1px 5px; border-radius: 4px; color: var(--text-dim);
  }
  .code-block-wrapper {
    position: relative; margin: 8px 0;
  }
  .md-content pre {
    background: var(--bg-code-block); border-radius: 8px; padding: 10px 14px;
    margin: 0; overflow-x: auto; border: 1px solid var(--border-subtle);
    position: relative;
  }
  .md-content pre code {
    background: transparent; padding: 0; font-size: 12px; line-height: 1.5; color: var(--text-dim);
  }

  /* Syntax highlighting tokens */
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-name { color: var(--hljs-keyword); }
  .hljs-string, .hljs-attr, .hljs-addition { color: var(--hljs-string); }
  .hljs-comment, .hljs-quote { color: var(--hljs-comment); font-style: italic; }
  .hljs-number, .hljs-literal, .hljs-boolean { color: var(--hljs-number); }
  .hljs-function .hljs-title, .hljs-title.function_, .hljs-title.class_ { color: var(--hljs-function); }
  .hljs-type, .hljs-template-variable { color: var(--hljs-type); }
  .hljs-variable, .hljs-template-tag { color: var(--hljs-variable); }
  .hljs-regexp, .hljs-link { color: var(--hljs-regexp); }
  .hljs-symbol, .hljs-bullet { color: var(--hljs-symbol); }
  .hljs-meta, .hljs-meta .hljs-keyword { color: var(--hljs-meta); }
  .hljs-deletion { color: var(--hljs-deletion); }
  .hljs-section, .hljs-title { color: var(--hljs-function); font-weight: 600; }
  .hljs-attribute { color: var(--hljs-type); }
  .hljs-params { color: var(--text-dim); }
  .md-content ul, .md-content ol { margin: 4px 0 8px 20px; }
  .md-content li { margin: 2px 0; }
  .md-content a { color: var(--accent); text-decoration: none; }
  .md-content a:hover { text-decoration: underline; }
  .md-content blockquote {
    border-left: 3px solid var(--border-light); margin: 8px 0; padding: 4px 12px; color: var(--text-dim);
  }
  .md-content hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .md-content table { border-collapse: collapse; margin: 8px 0; width: 100%; }
  .md-content th, .md-content td {
    border: 1px solid var(--border); padding: 6px 10px; text-align: left; font-size: 12px;
  }
  .md-content th { background: var(--bg-subtle); color: var(--text-primary); font-weight: 600; }

  /* Mobile: ensure code blocks don't overflow horizontally */
  @media (max-width: 767px) {
    .md-content pre { max-width: calc(100vw - 48px); }
    .md-content code { word-break: break-all; }
    .md-content pre code { word-break: normal; }
  }

  /* Copy buttons */
  .copy-btn:hover { color: var(--text-secondary) !important; border-color: var(--border-light) !important; background: var(--bg-hover) !important; }
  .code-copy-btn {
    position: absolute; top: 6px; right: 6px; z-index: 1;
    width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border-medium); border-radius: 6px;
    background: var(--btn-surface); color: var(--text-faint);
    cursor: pointer; padding: 0;
    transition: color 0.15s, background 0.15s, border-color 0.15s;
  }
`;
