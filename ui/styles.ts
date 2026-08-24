import { emitThemesCss } from "./themes.ts";

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

${emitThemesCss()}

  /* Mode-dependent visuals (independent of which specific theme is active). */
  [data-theme-mode="light"] .lamp-glow { display: none; }
  [data-theme-mode="light"] .window-night { display: none; }
  :root .window-day, [data-theme-mode="dark"] .window-day { display: none; }
  [data-theme-mode="light"] .window-day { display: block; }
  .sunrays { display: none; }
  [data-theme-mode="light"] .sunrays { display: block; }
  .neon-sign-on { display: none; }
  .neon-sign-off { display: block; }
  [data-theme-mode="dark"] .neon-sign-on { display: block; }
  [data-theme-mode="dark"] .neon-sign-off { display: none; }

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

  body { background: var(--bg-base); overflow:hidden; font-family: 'DM Sans', sans-serif; }
  html, body { max-width: 100vw; overflow-x: hidden; }
  input, select, textarea, button { font-family: inherit; }

  /* Markdown content styles */
  .md-content { font-size: 13px; line-height: 1.7; color: var(--text-secondary); }
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
  .md-content .table-wrapper { overflow-x: auto; margin: 8px 0; max-width: 100%; }
  .md-content table { border-collapse: collapse; }
  .md-content th, .md-content td {
    border: 1px solid var(--border); padding: 6px 10px; text-align: left; font-size: 12px; white-space: nowrap;
  }
  .md-content th { background: var(--bg-subtle); color: var(--text-primary); font-weight: 600; }

  /* Mermaid diagrams: the wrapper is the responsive boundary AND a horizontal
     scroller. body has overflow-x:hidden, so without a local scroll context
     any diagram wider than the column would be clipped to invisibility.
     overflow-x:auto only paints a scrollbar when the SVG actually exceeds
     the column, so on normal-sized diagrams it stays invisible. */
  .md-content .mermaid-wrapper {
    position: relative;
    margin: 8px 0;
    max-width: 100%;
    overflow-x: auto;
    /* Defensive: -webkit-overflow-scrolling is a no-op on iOS 13+ but
       keeping it preserves smooth-momentum horizontal scroll on any older
       device where the user hits a diagram wider than the column. */
    -webkit-overflow-scrolling: touch;
  }
  /* mermaid emits SVGs with width="100%" HTML attr + inline max-width:Npx
     matching the diagram's intrinsic width. That responsive default scales
     correctly with the column. We only center the SVG; deliberately NOT
     overriding mermaid's max-width, so small diagrams keep their intended
     size instead of stretching to fill the chat column. */
  .md-content .mermaid-wrapper > .mermaid > svg {
    display: block;
    margin: 0 auto;
  }
  /* The wrapper-data-attribute carries the diagram source; .mermaid is
     empty until the effect renders SVG or writes an error message. Empty
     ::before shows a placeholder string so cold loads don't show a blank
     gap. Once .mermaid has either an SVG or error text inside, :empty no
     longer matches and the placeholder is gone. Font/color rules live here
     (not on .mermaid itself) so they don't inherit into the rendered SVG's
     text labels. */
  .md-content .mermaid { display: block; }
  .md-content .mermaid:empty::before {
    content: "Rendering diagram…";
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
  }
  /* Visible failure state. The Markdown effect sets data-mermaid-error on
     the wrapper when a single diagram's parse fails so the user sees what
     failed (and we get diagnostic info from a screenshot) instead of a
     silently-blank wrapper. */
  .md-content .mermaid-wrapper[data-mermaid-error="true"] {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--red);
    background: var(--red-bg);
    border: 1px dashed var(--red);
    border-radius: 4px;
    padding: 6px 8px;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  /* Mobile: ensure code blocks don't overflow horizontally */
  @media (max-width: 767px) {
    .md-content pre { max-width: calc(100vw - 48px); }
    .md-content .table-wrapper { max-width: calc(100vw - 48px); }
    .md-content code { word-break: break-all; }
    .md-content pre code { word-break: normal; }
  }

  /* Narrow log view: drop labels from header action buttons (icons + tooltips remain).
     Container query keys off the chat column's actual width so opening the side
     editor/terminal collapses labels even when the window itself is wide. */
  @container (max-width: 1199px) {
    .log-view-column .nav-action-label { display: none; }
  }

  /* Side panel resizer: invisible 6 px hit target with a 1 px visible line
     drawn via ::after so the line tints on hover/drag without layout reflow. */
  .panel-resizer { background: transparent; }
  .panel-resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
    background: var(--border-strong);
    transition: background 0.15s, width 0.1s;
    pointer-events: none;
  }
  .panel-resizer:hover::after,
  .panel-resizer:active::after {
    background: var(--accent);
    width: 2px;
    left: 2.5px;
  }
  @media (max-width: 1199px) {
    .nav-action-label { display: none; }
  }

  /* Edit-agent dialog widens on wide-enough screens */
  .edit-agent-dialog-desktop { width: 380px; }
  .spawn-agent-dialog-desktop { width: min(640px, 94vw); }
  .spawn-engine-band { margin-bottom: 18px; }
  .spawn-engine-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .spawn-dialog-grid { display: block; }
  .spawn-template-section,
  .spawn-identity-section,
  .spawn-engine-settings { margin-bottom: 18px; }
  @media (min-width: 1100px) {
    .edit-agent-dialog-desktop { width: 460px; }
  }
  @media (min-width: 1000px) {
    .spawn-agent-dialog-desktop { width: min(1040px, 94vw); }
    .spawn-dialog-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 0 28px;
      align-items: start;
    }
    .spawn-template-section { grid-column: 1; grid-row: 1; }
    .spawn-right-column { grid-column: 2; grid-row: 1 / 3; }
    .spawn-appearance-section { grid-column: 1; grid-row: 2; }
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

  /* diff2html - chat-context tweaks: tighter density, no per-file double-border. */
  .d2h-isomux-host .d2h-file-wrapper {
    border: none; border-radius: 0; margin-bottom: 0;
  }
  .d2h-isomux-host .d2h-file-header {
    display: none;
  }
  .d2h-isomux-host .d2h-diff-table {
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
  }
  /* Side-by-side shows a single line number per pane, so its gutter can be
     tightened. Line-by-line is intentionally left at diff2html's defaults: its
     gutter holds BOTH the old and new line numbers (two floated columns), so
     narrowing it collapses the two numbers on top of each other on every line
     where they diverge (i.e. below any hunk) - which is what broke the gutter
     for large diffs in the modal view. */
  .d2h-isomux-host .d2h-code-side-line {
    padding: 0 3em; width: calc(100% - 6em);
  }
  .d2h-isomux-host .d2h-code-side-linenumber {
    width: 3.5em;
  }

  /* Dark mode: re-route diff2html's light defaults to its own dark palette. */
  [data-theme-mode="dark"] .d2h-isomux-host {
    --d2h-bg-color: var(--d2h-dark-bg-color);
    --d2h-border-color: var(--d2h-dark-border-color);
    --d2h-dim-color: var(--d2h-dark-dim-color);
    --d2h-line-border-color: var(--d2h-dark-line-border-color);
    --d2h-file-header-bg-color: var(--d2h-dark-file-header-bg-color);
    --d2h-file-header-border-color: var(--d2h-dark-file-header-border-color);
    --d2h-empty-placeholder-bg-color: var(--d2h-dark-empty-placeholder-bg-color);
    --d2h-empty-placeholder-border-color: var(--d2h-dark-empty-placeholder-border-color);
    --d2h-selected-color: var(--d2h-dark-selected-color);
    --d2h-ins-bg-color: var(--d2h-dark-ins-bg-color);
    --d2h-ins-border-color: var(--d2h-dark-ins-border-color);
    --d2h-ins-highlight-bg-color: var(--d2h-dark-ins-highlight-bg-color);
    --d2h-ins-label-color: var(--d2h-dark-ins-label-color);
    --d2h-del-bg-color: var(--d2h-dark-del-bg-color);
    --d2h-del-border-color: var(--d2h-dark-del-border-color);
    --d2h-del-highlight-bg-color: var(--d2h-dark-del-highlight-bg-color);
    --d2h-del-label-color: var(--d2h-dark-del-label-color);
    --d2h-change-del-color: var(--d2h-dark-change-del-color);
    --d2h-change-ins-color: var(--d2h-dark-change-ins-color);
    --d2h-info-bg-color: var(--d2h-dark-info-bg-color);
    --d2h-info-border-color: var(--d2h-dark-info-border-color);
    --d2h-change-label-color: var(--d2h-dark-change-label-color);
    --d2h-moved-label-color: var(--d2h-dark-moved-label-color);
    color: var(--d2h-dark-color);
  }
`;
