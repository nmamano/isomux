import { decodeHTML, decodeHTMLAttribute } from "entities";
import type { AppRecord } from "../shared/types.ts";
import { relayToApp, type RelayContext } from "./app-proxy.ts";

export const WIDGET_METADATA_TIMEOUT_MS = 2000;
export const WIDGET_METADATA_MAX_BYTES = 512 * 1024;
export interface WidgetMetadata {
  title: string;
  icons: { href: string; type?: string; sizes?: string; media?: string }[];
}

function fallback(app: AppRecord): WidgetMetadata {
  return {
    title: app.name,
    icons: app.thumbnailUpdatedAt === undefined ? [] : [{
      href: `/api/apps/${encodeURIComponent(app.name)}/thumbnail?v=${app.thumbnailUpdatedAt}`,
    }],
  };
}

function iconUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol === "https:" || /^data:image\//i.test(url.href)) return url.href;
  } catch { /* Invalid app metadata uses the fallback. */ }
  return null;
}

// Called only after the wrapper's member/app access check. Fresh requests
// deliberately carry no member cookies, authorization, or app-supplied target.
// The relay checks the running registration and never starts a stopped app.
export async function readWidgetMetadata(ctx: RelayContext): Promise<WidgetMetadata> {
  const initial = fallback(ctx.app);
  const origin = `https://${ctx.host}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIDGET_METADATA_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const request = (path: string, method = "GET") => relayToApp(new Request(origin + path, {
    method,
    headers: { "Accept-Encoding": "identity" },
    signal: controller.signal,
  }), ctx);
  try {
    const response = await request("/");
    if (!response.ok || !/^text\/html(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || response.headers.has("content-encoding")) {
      await response.body?.cancel();
      return initial;
    }
    reader = response.body?.getReader();
    if (!reader) return initial;
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > WIDGET_METADATA_MAX_BYTES) return initial;
      chunks.push(chunk.value);
    }
    if (controller.signal.aborted) return initial;
    let title = "";
    let titleSeen = false;
    let inTitle = false;
    let baseHref: string | null = null;
    const links: { href: string; type?: string; sizes?: string; media?: string }[] = [];
    await new HTMLRewriter()
      .on("title", { element(el) { inTitle = !titleSeen; titleSeen = true; el.onEndTag(() => { inTitle = false; }); }, text(text) { if (inTitle) title += text.text; } })
      .on("base[href]", { element(el) { baseHref ??= decodeHTMLAttribute(el.getAttribute("href")!); } })
      .on("link[href]", { element(el) {
        if (!decodeHTMLAttribute(el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("icon")) return;
        links.push({ href: decodeHTMLAttribute(el.getAttribute("href")!), ...Object.fromEntries(["type", "sizes", "media"].flatMap((key) => {
          const value = el.getAttribute(key); return value === null ? [] : [[key, decodeHTMLAttribute(value)]];
        })) });
      } })
      .transform(new Response(new Blob(chunks.map((chunk) => new Uint8Array(chunk))), { headers: { "Content-Type": "text/html" } })).text();
    let base = origin + "/";
    try { if (baseHref !== null) base = new URL(baseHref, base).href; } catch { /* Use root. */ }
    const icons = links.flatMap((link) => {
      const href = iconUrl(link.href, base);
      return href ? [{ ...link, href }] : [];
    });
    if (links.length === 0) {
      // Browser favicon-link errors are not reliable across engines. Probe
      // only our own upstream, inside the original deadline, without identity.
      const icon = await request("/favicon.ico");
      if (icon.ok && /^(?:image\/|application\/octet-stream)/i.test(icon.headers.get("content-type") ?? "")) {
        icons.push({ href: origin + "/favicon.ico" });
      }
      await icon.body?.cancel();
    }
    if (controller.signal.aborted) return initial;
    return { title: decodeHTML(title).trim() || initial.title, icons: icons.length ? icons : initial.icons };
  } catch {
    return initial;
  } finally {
    controller.abort();
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
  }
}

// Rewrite only the wrapper shell. App text and attributes are escaped by the
// HTML writer, never interpolated as executable markup.
export async function applyWidgetMetadata(html: string, metadata: WidgetMetadata): Promise<string> {
  const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const icons = metadata.icons.map((icon) => `<link rel="icon" ${Object.entries(icon).map(([key, value]) => `${key}="${attribute(value)}"`).join(" ")}>`).join("");
  return new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(metadata.title); } })
    .on("link", { element(el) {
      const rel = decodeHTMLAttribute(el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.some((value) => ["icon", "apple-touch-icon", "manifest"].includes(value))) el.remove();
    } })
    .on('meta[name="apple-mobile-web-app-title"]', { element(el) { el.setAttribute("content", metadata.title); } })
    .on("head", { element(el) { el.append(icons, { html: true }); } })
    .transform(new Response(html)).text();
}
