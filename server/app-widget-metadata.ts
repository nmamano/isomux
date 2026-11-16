import { decodeHTML, decodeHTMLAttribute } from "entities";
import type { AppRecord } from "../shared/types.ts";
import { appFaviconSvg } from "./app-favicon.ts";
import { relayToApp, type RelayContext } from "./app-proxy.ts";

const WIDGET_METADATA_TIMEOUT_MS = 2000;
export const WIDGET_METADATA_MAX_BYTES = 512 * 1024;
export interface WidgetMetadata {
  title: string;
  icons: { href: string; type?: string; sizes?: string; media?: string }[];
}

// The icon the app host serves at /favicon.ico; it never relays that path.
// The full app shows it when its HTML declares no usable icon link, and it
// does not depend on whether the app runs. Inline, so the browser fetches
// nothing.
function hostIcon(
  app: Pick<AppRecord, "name">,
): WidgetMetadata["icons"][number] {
  return {
    href: "data:image/svg+xml," + encodeURIComponent(appFaviconSvg(app)),
    type: "image/svg+xml",
  };
}

function fallback(app: AppRecord): WidgetMetadata {
  return {
    title: app.name,
    icons: [hostIcon(app)],
  };
}

// An icon loads with no click, so an https one must come from the app's own
// origin, judged after <base href>: the app's page, which an agent may write,
// could otherwise send data out through the icon's URL (task 16f6b48c). The
// wrapper's CSP adds only that origin to img-src.
function iconUrl(href: string, base: string, origin: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol === "https:" && url.origin === origin) return url.href;
    if (/^data:image\//i.test(url.href)) return url.href;
  } catch {
    /* Invalid app metadata uses the fallback. */
  }
  return null;
}

// The app's metadata, or the fallback when the app gives no usable answer.
export async function readWidgetMetadata(
  ctx: RelayContext,
): Promise<WidgetMetadata> {
  return (await fetchWidgetMetadata(ctx)) ?? fallback(ctx.app);
}

// Called only after the wrapper's member/app access check. Fresh requests
// deliberately carry no member cookies, authorization, or app-supplied target.
// The relay checks the running registration and never starts a stopped app.
// Null when the app gives no usable answer: an error, the time limit, a
// status other than 200, a page that is not HTML or is too large.
export async function fetchWidgetMetadata(
  ctx: RelayContext,
): Promise<WidgetMetadata | null> {
  const origin = `https://${ctx.host}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    WIDGET_METADATA_TIMEOUT_MS,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const request = (path: string) =>
    relayToApp(
      new Request(origin + path, {
        headers: { "Accept-Encoding": "identity" },
        signal: controller.signal,
      }),
      ctx,
    );
  try {
    const response = await request("/");
    if (
      !response.ok ||
      !/^text\/html(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      response.headers.has("content-encoding")
    ) {
      await response.body?.cancel();
      return null;
    }
    reader = response.body?.getReader();
    if (!reader) return null;
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > WIDGET_METADATA_MAX_BYTES) return null;
      chunks.push(chunk.value);
    }
    if (controller.signal.aborted) return null;
    let title = "";
    let titleSeen = false;
    let inTitle = false;
    let foreignTitle = false;
    let baseHref: string | null = null;
    const links: {
      href: string;
      type?: string;
      sizes?: string;
      media?: string;
    }[] = [];
    // The page title is document.title: the first <title> outside SVG,
    // MathML and <template>. SVG tooltips are <title> elements too, and a
    // streamed page (Next.js dev) puts its own title after them in the body.
    // Handlers on one element run in registration order.
    await new HTMLRewriter()
      .on("svg title, math title, template title", {
        element() {
          foreignTitle = true;
        },
      })
      .on("title", {
        element(el) {
          const foreign = foreignTitle;
          foreignTitle = false;
          if (foreign) return;
          inTitle = !titleSeen;
          titleSeen = true;
          el.onEndTag(() => {
            inTitle = false;
          });
        },
        text(text) {
          if (inTitle) title += text.text;
        },
      })
      .on("base[href]", {
        element(el) {
          baseHref ??= decodeHTMLAttribute(el.getAttribute("href")!);
        },
      })
      .on("link[href]", {
        element(el) {
          if (
            !decodeHTMLAttribute(el.getAttribute("rel") ?? "")
              .toLowerCase()
              .split(/\s+/)
              .includes("icon")
          )
            return;
          links.push({
            href: decodeHTMLAttribute(el.getAttribute("href")!),
            ...Object.fromEntries(
              ["type", "sizes", "media"].flatMap((key) => {
                const value = el.getAttribute(key);
                return value === null
                  ? []
                  : [[key, decodeHTMLAttribute(value)]];
              }),
            ),
          });
        },
      })
      .transform(
        new Response(new Blob(chunks.map((chunk) => new Uint8Array(chunk))), {
          headers: { "Content-Type": "text/html" },
        }),
      )
      .text();
    let base = origin + "/";
    try {
      if (baseHref !== null) base = new URL(baseHref, base).href;
    } catch {
      /* Use root. */
    }
    const icons = links.flatMap((link) => {
      const href = iconUrl(link.href, base, origin);
      return href ? [{ ...link, href }] : [];
    });
    if (controller.signal.aborted) return null;
    const empty = fallback(ctx.app);
    return {
      title: decodeHTML(title).trim() || empty.title,
      icons: icons.length ? icons : empty.icons,
    };
  } catch {
    return null;
  } finally {
    controller.abort();
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
  }
}

// Each app's metadata, kept so an open does not wait for the app (task
// ac70b38c). A hit answers at once and reads the app again in the
// background; only a usable answer replaces what is kept. The first open of a
// registration waits for the read, as an open did before. The answer carries
// no member credentials, so one entry serves every member.
export interface WidgetMetadataCache {
  // registration: the app's registration generation. A new one, or a new
  // host, starts a new entry.
  get(ctx: RelayContext, registration: number): Promise<WidgetMetadata>;
}

export function createWidgetMetadataCache(
  fetch: (
    ctx: RelayContext,
  ) => Promise<WidgetMetadata | null> = fetchWidgetMetadata,
): WidgetMetadataCache {
  interface Entry {
    // registration, host and the app's createdAt: an app deleted and made
    // again under its name can get the same registration and host.
    key: string;
    value: WidgetMetadata | null;
    // The read in flight for this entry, the first one or a refresh.
    reading: Promise<WidgetMetadata | null> | null;
  }
  const entries = new Map<string, Entry>();
  // One read per entry at a time. Its answer goes only into the entry that
  // started it, and only when usable; it never rejects.
  const read = (entry: Entry, ctx: RelayContext) => {
    const reading = fetch(ctx)
      .catch(() => null)
      .then((value) => {
        if (value) entry.value = value;
        entry.reading = null;
        return value;
      });
    entry.reading = reading;
    return reading;
  };
  return {
    async get(ctx, registration) {
      const key = `${registration}|${ctx.host}|${ctx.app.createdAt}`;
      let entry = entries.get(ctx.app.name);
      if (!entry || entry.key !== key) {
        entry = { key, value: null, reading: null };
        entries.set(ctx.app.name, entry);
      }
      if (entry.value) {
        if (!entry.reading) void read(entry, ctx);
        return entry.value;
      }
      // The first open waits; concurrent first opens share its read. A
      // failed first read keeps the fallback until a read succeeds.
      await (entry.reading ?? read(entry, ctx));
      entry.value ??= fallback(ctx.app);
      return entry.value;
    },
  };
}

export interface AppManifest {
  id: string;
  start_url: string;
  scope: string;
  name: string;
  short_name: string;
  display: "standalone";
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

// The manifest the app's short-link page links, so a browser installs the app
// as its own app: the app's title and its SVG icons (data: URLs only; the app
// host answers a cookieless fetch with 401). Android installs nothing without
// a raster icon, so only there the office PNGs follow. Elsewhere they stay
// out: iOS takes a manifest PNG over its own letter icon, and every app on an
// iPhone would wear the Isomux icon.
export function appManifest(
  app: Pick<AppRecord, "name">,
  metadata: WidgetMetadata,
  { android }: { android: boolean },
): AppManifest {
  const path = `/${app.name}/`;
  const svgs = metadata.icons.filter((icon) =>
    /^data:image\/svg\+xml[;,]/i.test(icon.href),
  );
  return {
    id: path,
    start_url: path,
    scope: path,
    name: metadata.title,
    short_name: metadata.title,
    display: "standalone",
    theme_color: "#0a0e16",
    background_color: "#0a0e16",
    icons: [
      ...(svgs.length ? svgs : [hostIcon(app)]).map((icon) => ({
        src: icon.href,
        sizes: "any",
        type: "image/svg+xml",
      })),
      // ui/manifest.json's PNGs: served without sign-in.
      ...(android
        ? [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "/icons/icon-512-maskable.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ]
        : []),
    ],
  };
}

// Rewrite only the wrapper shell. App text and attributes are escaped by the
// HTML writer, never interpolated as executable markup.
export async function applyWidgetMetadata(
  html: string,
  metadata: WidgetMetadata,
): Promise<string> {
  const attribute = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const icons = metadata.icons
    .map(
      (icon) =>
        `<link rel="icon" ${Object.entries(icon)
          .map(([key, value]) => `${key}="${attribute(value)}"`)
          .join(" ")}>`,
    )
    .join("");
  return new HTMLRewriter()
    .on("head > title", {
      element(el) {
        el.setInnerContent(metadata.title);
      },
    })
    .on("link", {
      element(el) {
        const rel = decodeHTMLAttribute(el.getAttribute("rel") ?? "")
          .toLowerCase()
          .split(/\s+/);
        if (
          rel.some((value) =>
            ["icon", "apple-touch-icon", "manifest"].includes(value),
          )
        )
          el.remove();
      },
    })
    .on('meta[name="apple-mobile-web-app-title"]', {
      element(el) {
        el.setAttribute("content", metadata.title);
      },
    })
    .on("head", {
      element(el) {
        el.append(icons, { html: true });
      },
    })
    .transform(new Response(html))
    .text();
}
