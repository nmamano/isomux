// The chat bar's Copy as an HTML file: a snapshot of the chat as the member
// sees it, as one page with its CSS and no script or office link.

import { flushSync } from "react-dom";
import { formatDateTime } from "../../shared/i18n/time.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";

// Clones of the chat's log wrappers whose id is in `entryIds`, in chat order,
// rendered in the export view (useChatTranscript). `setExportView` turns it on
// and off around the clone, in one task, so the browser paints neither.
export function snapshotChatEntries(
  transcript: HTMLElement,
  entryIds: ReadonlySet<string>,
  setExportView: (on: boolean) => void,
): HTMLElement[] {
  flushSync(() => setExportView(true));
  try {
    return Array.from(
      transcript.querySelectorAll<HTMLElement>("[data-log-entry-id]"),
    )
      .filter(
        (el) =>
          entryIds.has(el.getAttribute("data-log-entry-id") ?? "") &&
          !el.parentElement?.closest("[data-log-entry-id]"),
      )
      .map((el) => el.cloneNode(true) as HTMLElement);
  } finally {
    flushSync(() => setExportView(false));
  }
}

export type ChatHtmlOptions = {
  entries: HTMLElement[];
  // The agent's name: the page title and the header.
  title: string;
  exportedAt: number;
  language: string;
  theme: string;
  themeMode: string;
  css: string;
  // An image as a data: URL, or null to leave it out.
  fetchImage?: (src: string) => Promise<string | null>;
};

// What a file cannot use: it runs code, takes input, or loads a page.
const DROPPED =
  "script, iframe, frame, object, embed, input, textarea, select, form, base, link, meta, source, [data-chat-export='omit']";
// Attributes that load or open a URL, besides href and src.
const URL_ATTRS = [
  "srcset",
  "poster",
  "action",
  "formaction",
  "data",
  "background",
  "cite",
];

export async function buildChatHtml(opts: ChatHtmlOptions): Promise<string> {
  const images: Promise<void>[] = [];
  for (const entry of opts.entries) {
    for (const el of Array.from(entry.querySelectorAll(DROPPED))) el.remove();
    for (const el of [entry, ...Array.from(entry.querySelectorAll("*"))]) {
      cleanElement(el);
      if (el.tagName.toLowerCase() === "img")
        images.push(inlineImage(el as HTMLImageElement, opts.fetchImage));
    }
  }
  await Promise.all(images);
  const date = formatDateTime(
    opts.language as SupportedLanguageCode,
    opts.exportedAt,
    "dateTime",
  );
  const body = opts.entries.map((entry) => entry.outerHTML).join("\n");
  return `<!doctype html>
<html lang="${escapeHtml(opts.language)}" data-theme="${escapeHtml(opts.theme)}" data-theme-mode="${escapeHtml(opts.themeMode)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
${opts.css.replace(/<\/style/gi, "<\\/style")}
${PAGE_CSS}
</style>
</head>
<body>
<main data-chat-export-page>
<header data-chat-export-header><strong>${escapeHtml(opts.title)}</strong> · ${escapeHtml(date)}</header>
${body}
</main>
</body>
</html>
`;
}

// The app's page fixes the body to the window; the file scrolls, in one
// column as wide as the chat.
const PAGE_CSS = `
html, body { height: auto; overflow: auto; }
body { margin: 0; background: var(--bg-base); color: var(--text-primary); }
[data-chat-export-page] { max-width: 820px; margin: 0 auto; padding: 16px 20px 40px; }
[data-chat-export-header] { padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--border); color: var(--text-dim); font-size: 13px; }
[data-chat-export-header] strong { color: var(--text-primary); }
`;

function cleanElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) el.removeAttribute(attr.name);
    else if (URL_ATTRS.includes(name)) el.removeAttribute(attr.name);
    else if (name === "style")
      el.setAttribute(attr.name, withoutUrls(attr.value));
    else if (name === "href" || name === "xlink:href") {
      // A link keeps an outside address; anything else keeps only a
      // reference inside the file (SVG markers and icons).
      const keep =
        tag === "a" ? isOutsideLink(attr.value) : attr.value.startsWith("#");
      if (!keep) el.removeAttribute(attr.name);
    } else if (name === "src" && tag !== "img") el.removeAttribute(attr.name);
  }
  if (tag === "a" && el.hasAttribute("href")) {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
  if (tag === "style" && el.textContent)
    el.textContent = withoutUrls(el.textContent);
  if (tag === "button") {
    el.setAttribute("type", "button");
    el.setAttribute("disabled", "");
  }
}

function isOutsideLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href.trim(), location.href);
  } catch {
    return false;
  }
  if (url.protocol === "mailto:") return true;
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin !== location.origin
  );
}

// An image from the office goes into the file as a data: URL, or its name
// takes its place. One already in the file or from outside stays.
async function inlineImage(
  img: HTMLImageElement,
  fetchImage: ChatHtmlOptions["fetchImage"],
): Promise<void> {
  const src = img.getAttribute("src")?.trim() ?? "";
  if (src.startsWith("data:")) return;
  let url: URL | null = null;
  try {
    url = new URL(src, location.href);
  } catch {}
  if (
    src &&
    url &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin !== location.origin
  )
    return;
  const data =
    src && url?.origin === location.origin && fetchImage
      ? await fetchImage(url.href).catch(() => null)
      : null;
  if (data?.startsWith("data:")) {
    img.setAttribute("src", data);
    return;
  }
  const name =
    img.getAttribute("alt") ||
    decodeURIComponent(url?.pathname.split("/").pop() ?? "");
  img.replaceWith(img.ownerDocument.createTextNode(name));
}

// CSS with each url() that is not data: or a reference inside the file taken
// out, so the file loads nothing from the office.
function withoutUrls(css: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
    (match, _quote, value: string) =>
      value.trim().startsWith("data:") || value.trim().startsWith("#")
        ? match
        : "none",
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// CSSRule.type numbers: @import and @font-face point at the office.
const IMPORT_RULE = 3;
const FONT_FACE_RULE = 5;

// The page's own CSS rules, for the file's one <style>. A sheet from another
// origin cannot be read and is left out.
export function collectExportCss(doc: Document): string {
  const out: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const text = rule.cssText;
      if (
        rule.type === IMPORT_RULE ||
        rule.type === FONT_FACE_RULE ||
        /^\s*@(import|font-face)\b/i.test(text)
      )
        continue;
      out.push(withoutUrls(text));
    }
  }
  return out.join("\n");
}

// "<agent>-chat-<YYYY-MM-DD>.html" in local time; "chat-<date>.html" when the
// name keeps no ASCII letter or digit.
export function chatExportFileName(agentName: string, at: number): string {
  const d = new Date(at);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const slug = agentName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug ? `${slug}-` : ""}chat-${date}.html`;
}

// An image larger than this stays out of the file: its name takes its place.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// The image at `src` (on the office) as a data: URL, or null when the office
// does not send an image or it is too large.
export async function fetchImageAsDataUrl(src: string): Promise<string | null> {
  const res = await fetch(src, { credentials: "same-origin" });
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!type.startsWith("image/")) return null;
  if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

export function downloadHtml(fileName: string, html: string): void {
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  // The browser has the file once the click returns; a later revoke leaves it
  // time to start on slow devices.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
