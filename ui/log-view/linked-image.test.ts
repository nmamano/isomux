// Which links open in the lightbox (task 3d947224). The browser keeps one zoom
// per host, so an image opened as a page on the office's own host and zoomed
// there zooms the office too. A link to such an image opens in the lightbox;
// every other link keeps its page.

import { describe, expect, it } from "bun:test";
import { linkedImageSrc } from "./linked-image.ts";

const BASE = "http://office.test/rooms/r1?agent=a";

// The URL the lightbox loads, resolved as the browser would.
function opened(href: string): string | null {
  const src = linkedImageSrc(href, BASE);
  return src === null ? null : new URL(src, BASE).href;
}

describe("linkedImageSrc", () => {
  it("opens an image on the office's own host, whatever the case of its extension", () => {
    for (const path of [
      "/api/files/agent-1/shot.png",
      "/api/files/agent-1/photo.JPG",
      "/api/files/agent-1/photo.jpeg",
      "/api/files/agent-1/anim.gif",
      "/api/files/agent-1/pic.webp",
      "/api/files/agent-1/pic.avif",
      "/api/files/agent-1/diagram.svg",
      "/api/files/agent-1/old.bmp",
      "/favicon.ico",
    ])
      expect(opened(path)).toBe(`http://office.test${path}`);
    // An absolute link and a relative one on the same host.
    expect(opened("http://office.test/api/files/a/x.png")).toBe(
      "http://office.test/api/files/a/x.png",
    );
    expect(opened("shot.png")).toBe("http://office.test/rooms/shot.png");
  });

  it("keeps the query the image may need and drops the hash", () => {
    const url = new URL(opened("/api/files/a/x.png?v=2#top")!);
    expect(url.pathname).toBe("/api/files/a/x.png");
    expect(url.searchParams.get("v")).toBe("2");
    expect(url.hash).toBe("");
  });

  it("leaves a link to another host to its page", () => {
    for (const href of [
      "https://other.test/x.png",
      "//other.test/x.png",
      "http://office.test:8080/x.png",
      "https://office.test/x.png",
      "http://app.office.test/x.png",
    ])
      expect(opened(href)).toBeNull();
  });

  it("leaves a link that is not an image to its page", () => {
    for (const href of [
      "/api/files/a/report.pdf",
      "/api/files/a/notes",
      "/api/files/a/x?name=y.png",
      "/api/files/a/x#y.png",
      "/api/files/a/png",
      "/rooms/r1",
      "mailto:someone@example.png",
    ])
      expect(opened(href)).toBeNull();
  });

  it("leaves a download link to the download", () => {
    expect(opened("/api/files/a/x.png?download=x.png")).toBeNull();
    expect(opened("/api/files/a/x.png?v=2&download=Shot%201.png")).toBeNull();
  });

  it("returns null for a link the browser cannot parse", () => {
    expect(opened("http://[")).toBeNull();
  });
});
