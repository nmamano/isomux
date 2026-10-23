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

function iconUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol === "https:" || /^data:image\//i.test(url.href))
      return url.href;
  } catch {
    /* Invalid app metadata uses the fallback. */
  }
  return null;
}

// Called only after the wrapper's member/app access check. Fresh requests
// deliberately carry no member cookies, authorization, or app-supplied target.
// The relay checks the running registration and never starts a stopped app.
export async function readWidgetMetadata(
  ctx: RelayContext,
): Promise<WidgetMetadata> {
  const initial = fallback(ctx.app);
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
    const links: {
      href: string;
      type?: string;
      sizes?: string;
      media?: string;
    }[] = [];
    await new HTMLRewriter()
      .on("title", {
        element(el) {
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
      const href = iconUrl(link.href, base);
      return href ? [{ ...link, href }] : [];
    });
    if (controller.signal.aborted) return initial;
    return {
      title: decodeHTML(title).trim() || initial.title,
      icons: icons.length ? icons : initial.icons,
    };
  } catch {
    return initial;
  } finally {
    controller.abort();
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
  }
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
    .on("title", {
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
