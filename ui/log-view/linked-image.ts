import type { LightboxImage } from "./attachment-download.tsx";

// A link to an image on the office's own host opens in the in-app lightbox,
// not as a page (task 3d947224): the browser keeps one zoom per host, so
// zooming the image as a page zooms the office too. An image in chat text
// opens there as well, so seeing it bigger needs no page either.

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;

/** The image URL a link points to, path-relative, when it is an image on the
 * office's own host and not a download; else null. */
export function linkedImageSrc(
  href: string,
  base: string = location.href,
): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  if (!IMAGE_PATH.test(url.pathname)) return null;
  if (url.searchParams.has("download")) return null;
  return url.pathname + url.search;
}

export interface ClickLike {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

// The name the lightbox download saves under: the file name in the path.
function fileName(src: string, base: string, alt: string): string {
  const segment = new URL(src, base).pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(segment) || alt;
  } catch {
    return segment || alt;
  }
}

/** The image a plain click opens in the lightbox: an image link, or an image
 * in chat text that is not in a link. Null for every other click. */
export function lightboxForClick(
  e: ClickLike,
  base: string = location.href,
): LightboxImage | null {
  if (
    e.button !== 0 ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey ||
    e.altKey ||
    e.defaultPrevented
  )
    return null;
  const target = e.target;
  if (!(target instanceof Element)) return null;
  // A link decides for everything in it, an image too.
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (link) {
    if (link.hasAttribute("download")) return null;
    const src = linkedImageSrc(link.href, base);
    return src === null ? null : { src, name: fileName(src, base, "") };
  }
  const img = target.closest<HTMLImageElement>(".md-content img");
  const raw = img?.getAttribute("src");
  if (!img || !raw) return null;
  return { src: raw, name: fileName(raw, base, img.alt) };
}
