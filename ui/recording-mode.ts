// Recording mode (task 6e08239a): a display layer for a member who records
// or streams the office. While it is on, the text the page draws goes
// through the rules of shared/recording-redact.ts before paint, and images,
// videos and iframes stay blurred until a click. Nothing changes on the
// server. The switch is per browser (localStorage); the word list follows
// the member (their record).
//
// A MutationObserver callback runs at the microtask checkpoint after React's
// commit, so a stand-in is written before the browser paints the original.

import { useSyncExternalStore } from "react";
import {
  compileRedactor,
  type RecordingRules,
  type Redactor,
} from "../shared/recording-redact.ts";

export const RECORDING_STORAGE_KEY = "isomux-recording-mode";

// --- The DOM layer ---------------------------------------------------------

// Never rewritten: a stand-in in an editable field would be saved back as
// the real value. CodeMirror draws its own stand-ins (recording-codemirror).
const SKIP = "script, style, noscript, textarea, [contenteditable], .cm-editor";
const DRAWN_ATTRS = ["title", "aria-label", "alt", "placeholder"];
// Text the terminal draws in fixed columns: a stand-in keeps the length.
const TERMINAL_ROWS = ".xterm-rows";
const FIELD_BLUR = "data-recording-blur";
// Input types whose value is text a member reads on screen.
const NOT_TEXT_INPUTS = new Set([
  "hidden",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "color",
  "range",
  "image",
]);

export interface AttachedRedactor {
  // New rules: every node is redacted again from its original.
  update(redact: Redactor): void;
  // Restore every original still on screen and stop observing.
  detach(): void;
}

interface Written {
  original: string;
  written: string;
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function isTextField(el: Element): boolean {
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT")
    return !NOT_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return (
    el.hasAttribute("contenteditable") &&
    el.closest("[contenteditable='false']") !== el
  );
}

function fieldValue(el: Element): string {
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT")
    return (el as HTMLInputElement).value;
  return el.textContent ?? "";
}

// Rewrites the text nodes and drawn attributes of `doc` with `redact`, now
// and on every later change.
export function attachRedactor(
  doc: Document,
  redact: Redactor,
): AttachedRedactor {
  return attachWith(doc, redact, "");
}

// `titleMark` goes in front of the tab title while the layer is attached.
function attachWith(
  doc: Document,
  initial: Redactor,
  titleMark: string,
): AttachedRedactor {
  let redact = initial;
  const texts = new WeakMap<Text, Written>();
  const attrs = new WeakMap<Element, Map<string, Written>>();

  const transformText = (node: Text, text: string): string => {
    const parent = node.parentElement;
    if (parent?.tagName === "TITLE") return titleMark + redact(text);
    return redact(text, { keepLength: !!parent?.closest(TERMINAL_ROWS) });
  };

  // `fresh`: start from the original even when the node still shows what
  // the layer wrote (a rule change).
  const fixText = (node: Text, fresh = false) => {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP)) return;
    const current = node.nodeValue ?? "";
    const seen = texts.get(node);
    if (seen && current === seen.written && !fresh) return;
    const original = seen && current === seen.written ? seen.original : current;
    const out = transformText(node, original);
    if (out === original) {
      texts.delete(node);
      if (current !== original) node.nodeValue = original;
      return;
    }
    texts.set(node, { original, written: out });
    if (current !== out) node.nodeValue = out;
  };

  const fixAttr = (el: Element, name: string, fresh = false) => {
    if (el.closest(".cm-editor, [contenteditable]")) return;
    const current = el.getAttribute(name);
    let byName = attrs.get(el);
    const seen = byName?.get(name);
    if (current === null) {
      byName?.delete(name);
      return;
    }
    if (seen && current === seen.written && !fresh) return;
    const original = seen && current === seen.written ? seen.original : current;
    const out = redact(original);
    if (out === original) {
      byName?.delete(name);
      if (current !== original) el.setAttribute(name, original);
      return;
    }
    if (!byName) attrs.set(el, (byName = new Map<string, Written>()));
    byName.set(name, { original, written: out });
    if (current !== out) el.setAttribute(name, out);
  };

  const checkField = (el: Element) => {
    const value = fieldValue(el);
    if (value && redact(value) !== value) el.setAttribute(FIELD_BLUR, "");
    else el.removeAttribute(FIELD_BLUR);
  };

  const fixElement = (el: Element, fresh = false) => {
    for (const name of DRAWN_ATTRS)
      if (el.hasAttribute(name)) fixAttr(el, name, fresh);
    if (isTextField(el)) checkField(el);
  };

  const sweep = (root: Node, fresh = false) => {
    if (root.nodeType === Node.TEXT_NODE) return fixText(root as Text, fresh);
    if (root.nodeType === Node.ELEMENT_NODE) fixElement(root as Element, fresh);
    else if (root.nodeType !== Node.DOCUMENT_NODE) return;
    const walker = doc.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    );
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) fixText(n as Text, fresh);
      else fixElement(n as Element, fresh);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      // A field's value React set with no input event: an input's value
      // attribute, a textarea's text. Checked, never rewritten.
      if (r.type === "attributes" && r.attributeName === "value") {
        if (isTextField(r.target as Element)) checkField(r.target as Element);
        continue;
      }
      if (r.type === "characterData") fixText(r.target as Text);
      else if (r.type === "attributes")
        fixAttr(r.target as Element, r.attributeName!);
      else r.addedNodes.forEach((n) => sweep(n));
      const el = elementOf(r.target);
      const field = el?.closest("textarea, [contenteditable]");
      if (field && isTextField(field)) checkField(field);
    }
  });
  const onInput = (e: Event) => {
    const el = e.target as Element | null;
    if (el && el.nodeType === Node.ELEMENT_NODE && isTextField(el))
      checkField(el);
  };

  const observe = () =>
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...DRAWN_ATTRS, "value"],
    });
  doc.addEventListener("input", onInput, true);
  sweep(doc);
  observe();

  const restore = () => {
    // Records still queued are the page's own changes: a restore keeps them.
    observer.takeRecords();
    observer.disconnect();
    const walker = doc.createTreeWalker(
      doc,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    );
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const seen = texts.get(n as Text);
        if (seen && n.nodeValue === seen.written) n.nodeValue = seen.original;
        texts.delete(n as Text);
        continue;
      }
      const el = n as Element;
      el.removeAttribute(FIELD_BLUR);
      const byName = attrs.get(el);
      if (!byName) continue;
      for (const [name, seen] of byName)
        if (el.getAttribute(name) === seen.written)
          el.setAttribute(name, seen.original);
      attrs.delete(el);
    }
  };

  return {
    update(next) {
      // The fresh sweep below covers the records still queued.
      observer.takeRecords();
      observer.disconnect();
      redact = next;
      sweep(doc, true);
      observe();
    },
    detach() {
      restore();
      doc.removeEventListener("input", onInput, true);
    },
  };
}

// --- Blur until a click ----------------------------------------------------

const SHOWN = "data-recording-shown";
const BLURRED = "img, video, iframe, image";
// The attributes that change the picture an element shows.
const PICTURE_ATTRS = ["src", "srcset", "srcdoc", "poster", "href"];
const GESTURE = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];

const BLUR_CSS = `
html[data-recording] :is(img, video, iframe, svg image):not([${SHOWN}]) {
  filter: blur(18px);
}
html[data-recording] iframe:not([${SHOWN}]) {
  pointer-events: none;
}
html[data-recording] [${FIELD_BLUR}] {
  filter: blur(6px);
}
`;

function isBlurred(doc: Document, el: Element): boolean {
  return (
    doc.documentElement.hasAttribute("data-recording") &&
    el.matches(BLURRED) &&
    !el.hasAttribute(SHOWN)
  );
}

// The blurred picture a gesture lands on, if nothing is drawn above it. An
// img or video is in the event's path; an iframe takes no pointer events
// while blurred, so the event goes to what is under it, and the iframe is
// found inside that element at the pointer.
function blurredTarget(doc: Document, e: Event): Element | null {
  for (const node of e.composedPath()) {
    if (!(node instanceof Element)) continue;
    if (isBlurred(doc, node)) return node;
  }
  const target = e.target;
  if (!(target instanceof Element) || !("clientX" in e)) return null;
  const { clientX: x, clientY: y } = e as MouseEvent;
  for (const frame of target.querySelectorAll("iframe")) {
    if (!isBlurred(doc, frame)) continue;
    const box = frame.getBoundingClientRect();
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
      return frame;
  }
  return null;
}

// Blur until a click: the first pointer gesture on a blurred image, video or
// iframe only reveals it. Returns the uninstaller, which also drops every
// reveal.
export function installClickReveal(doc: Document): () => void {
  const win = doc.defaultView ?? window;
  // The picture whose gesture is being swallowed, from its press to its
  // click.
  let swallowing: Element | null = null;
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onGesture = (e: Event) => {
    if ((e as MouseEvent).button > 0) return;
    if (e.type === "pointerdown") swallowing = blurredTarget(doc, e);
    if (swallowing) {
      swallow(e);
      if (e.type === "pointerup" || e.type === "click")
        swallowing.setAttribute(SHOWN, "");
      if (e.type === "click") swallowing = null;
      return;
    }
    // A click with no press first (a keyboard or a script) reveals too.
    if (e.type === "click") {
      const el = blurredTarget(doc, e);
      if (el) {
        swallow(e);
        el.setAttribute(SHOWN, "");
      }
    }
  };
  for (const type of GESTURE) win.addEventListener(type, onGesture, true);

  // A reveal is for the picture that was clicked: a new picture in the same
  // element (the lightbox's next, a preview's re-render) is blurred again.
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as Element;
      if (
        el.hasAttribute(SHOWN) &&
        el.getAttribute(r.attributeName!) !== r.oldValue
      )
        el.removeAttribute(SHOWN);
    }
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: PICTURE_ATTRS,
  });

  return () => {
    for (const type of GESTURE) win.removeEventListener(type, onGesture, true);
    observer.disconnect();
    swallowing = null;
    for (const el of doc.querySelectorAll(`[${SHOWN}]`))
      el.removeAttribute(SHOWN);
  };
}

// --- The switch ------------------------------------------------------------

// Drawn outside the page area (the tab), so a recording of the page does
// not show it.
const TITLE_MARK = "● REC ";
const ICON_MARK = "data-recording-icon";
const STYLE_MARK = "data-recording-style";

function readFlag(): boolean {
  try {
    return localStorage.getItem(RECORDING_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function writeFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(RECORDING_STORAGE_KEY, "1");
    else localStorage.removeItem(RECORDING_STORAGE_KEY);
  } catch {
    // Blocked storage: the mode lasts until this page is closed.
  }
}

let rules: RecordingRules | null = null;
let redactor: Redactor | null = null;
let attached: AttachedRedactor | null = null;
let uninstallReveal: (() => void) | null = null;
const listeners = new Set<() => void>();

function rulesNow(): RecordingRules {
  return rules ?? { officeHosts: [location.host], otherOffices: [], words: [] };
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[recording-mode] listener failed:", err);
    }
  }
}

// The favicon with a red dot: the page's own SVG icon with a circle added,
// or a red dot alone.
function markedIcon(): string {
  const icons = document.head.querySelectorAll<HTMLLinkElement>(
    `link[rel~='icon']:not([${ICON_MARK}])`,
  );
  const href = icons[icons.length - 1]?.getAttribute("href") ?? "";
  const dot =
    "<circle cx='25' cy='7' r='6' fill='%23e5484d' stroke='white' stroke-width='1.5'/>";
  const prefix = "data:image/svg+xml,";
  if (href.startsWith(prefix) && href.includes("</svg>"))
    return href.replace(/<\/svg>\s*$/, `${dot}</svg>`);
  return `${prefix}<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>${dot}</svg>`;
}

function postToServiceWorker(on: boolean): void {
  try {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    void sw.ready
      .then((reg) => reg.active?.postMessage({ type: "isomux-recording", on }))
      .catch(() => {});
  } catch {
    // No service worker here: pushes show as they are.
  }
}

function apply(on: boolean): void {
  const root = document.documentElement;
  if (on && !attached) {
    redactor = compileRedactor(rulesNow());
    root.setAttribute("data-recording", "");
    const style = document.createElement("style");
    style.setAttribute(STYLE_MARK, "");
    style.textContent = BLUR_CSS;
    document.head.append(style);
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.setAttribute(ICON_MARK, "");
    icon.href = markedIcon();
    document.head.append(icon);
    if (!document.querySelector("title")) document.title = "";
    attached = attachWith(document, redactor, TITLE_MARK);
    uninstallReveal = installClickReveal(document);
  } else if (!on && attached) {
    attached.detach();
    attached = null;
    uninstallReveal?.();
    uninstallReveal = null;
    redactor = null;
    root.removeAttribute("data-recording");
    for (const el of document.head.querySelectorAll(
      `[${STYLE_MARK}], [${ICON_MARK}]`,
    ))
      el.remove();
  } else return;
  notify();
}

export function isRecording(): boolean {
  return attached !== null;
}

export function setRecording(on: boolean): void {
  writeFlag(on);
  apply(on);
  postToServiceWorker(on);
}

// The store calls it when the office name, the floors, the elevator panel
// or the member's word list change. The page re-runs from the originals.
export function setRecordingRules(next: RecordingRules): void {
  rules = next;
  if (!attached) return;
  redactor = compileRedactor(next);
  attached.update(redactor);
  notify();
}

let booted = false;

// Boot: runs before createRoot().render, after the ride fragment is read.
export function startRecordingMode(): void {
  const on = readFlag();
  apply(on);
  postToServiceWorker(on);
  if (booted) return;
  booted = true;
  // Another tab's switch.
  window.addEventListener("storage", (e) => {
    if (e.key !== RECORDING_STORAGE_KEY && e.key !== null) return;
    const now = readFlag();
    apply(now);
    postToServiceWorker(now);
  });
}

// The redactor in force, or null while the mode is off.
export function currentRedactor(): Redactor | null {
  return redactor;
}

// Called on every on/off and rule change. Returns the unsubscriber.
export function onRecordingChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRecording(): boolean {
  return useSyncExternalStore(onRecordingChange, isRecording, () => false);
}
