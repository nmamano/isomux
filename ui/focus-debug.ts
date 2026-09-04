// Gated focus-event tracer for "editor input capture". With
// the cursor in the editor panel, clicking the chat input box sometimes
// doesn't move focus there. The bug doesn't reproduce in headless Chrome -
// the suspected trigger is real OS window activation - so this tracer
// records exactly what happens around the failing click in the affected
// browser. One reproduction discriminates the candidate mechanisms:
//   (a) the pointerdown/mousedown never reaches the textarea (an overlay
//       swallows it - visible in target/composedPath),
//   (b) the textarea gains focus and is then yanked back to the CodeMirror
//       contenteditable (visible as focusin TEXTAREA followed by focusin
//       cm-content, or in the microtask/rAF activeElement probes),
//   (c) mousedown lands on the textarea but focus never changes (Chrome
//       contenteditable blur failure - no focusout/focusin at all).
//
// Enable:  localStorage.setItem("isomux-debug-focus", "1")  then reload.
// Dump:    window.__isomuxFocusDump()   (console.table + returns the array)
// Disable: localStorage.removeItem("isomux-debug-focus")    then reload.
//
// Off by default and fully inert without the flag - initFocusDebug() returns
// before installing any listener. With the flag on, listeners are
// capture-phase and record-only (no preventDefault/stopPropagation, no
// focus calls), so they cannot alter the behavior being observed.

interface FocusDebugEntry {
  t: number; // ms since page load, one decimal
  type: string;
  target?: string;
  path?: string; // first few composedPath entries, innermost first
  active: string; // document.activeElement when the event fired
  activeMicro?: string; // ...at the following microtask
  activeRaf?: string; // ...at the next animation frame
}

const MAX_ENTRIES = 300;

function describe(el: unknown): string {
  if (el === null || el === undefined) return "null";
  if (el === window) return "window";
  if (el === document) return "document";
  if (!(el instanceof Element)) {
    // Non-element event targets (e.g. text nodes) - name the type, not the
    // value ([object Object] stringification is useless in the trace).
    const ctor = el.constructor?.name;
    return ctor ? `<${ctor}>` : typeof el;
  }
  const id = el.id ? `#${el.id}` : "";
  const cls =
    typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 80);
}

export function initFocusDebug(): void {
  let enabled = false;
  try {
    enabled = localStorage.getItem("isomux-debug-focus") === "1";
  } catch {
    return;
  }
  if (!enabled) return;

  const buf: FocusDebugEntry[] = [];
  const record = (type: string, ev?: Event) => {
    const entry: FocusDebugEntry = {
      t: Math.round(performance.now() * 10) / 10,
      type,
      target: ev ? describe(ev.target) : undefined,
      path: ev
        ? ev.composedPath().slice(0, 4).map(describe).join(" < ")
        : undefined,
      active: describe(document.activeElement),
    };
    // Probe activeElement again after the current task and after the next
    // frame - a focus grab that happens asynchronously (e.g. the browser's
    // window-activation focus restore, or a deferred .focus() call) shows up
    // as a difference between these three snapshots.
    queueMicrotask(() => {
      entry.activeMicro = describe(document.activeElement);
    });
    requestAnimationFrame(() => {
      entry.activeRaf = describe(document.activeElement);
    });
    buf.push(entry);
    if (buf.length > MAX_ENTRIES) buf.shift();
  };

  for (const type of [
    "pointerdown",
    "mousedown",
    "click",
    "focusin",
    "focusout",
  ]) {
    document.addEventListener(type, (ev) => record(type, ev), true);
  }
  window.addEventListener("focus", () => record("window-focus"));
  window.addEventListener("blur", () => record("window-blur"));
  document.addEventListener("visibilitychange", () =>
    record(`visibility:${document.visibilityState}`),
  );

  (
    window as unknown as { __isomuxFocusDump: () => FocusDebugEntry[] }
  ).__isomuxFocusDump = () => {
    console.table(buf);
    return buf;
  };
  console.info(
    "[isomux] focus debug tracer active - dump with window.__isomuxFocusDump()",
  );
}
