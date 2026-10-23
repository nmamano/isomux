import { afterEach, expect, it } from "bun:test";
import {
  readWidgetMetadata,
  applyWidgetMetadata,
  appManifest,
  WIDGET_METADATA_MAX_BYTES,
} from "./app-widget-metadata.ts";
import type { RelayContext } from "./app-proxy.ts";
import { appFavicon, appFaviconSvg } from "./app-favicon.ts";
import { _testSetAppRegistrationGeneration } from "./app-registry.ts";

let upstream: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
  await upstream?.stop(true);
  upstream = undefined;
});
function context(
  fetch: (req: Request) => Response | Promise<Response>,
  running = true,
): RelayContext {
  upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  const app = {
    name: "sample",
    hostLabel: "sample",
    hostGen: 1,
    port: upstream.port,
    thumbnailUpdatedAt: 12,
  } as RelayContext["app"];
  _testSetAppRegistrationGeneration(app, 1);
  return {
    app,
    host: "sample.office.example",
    apps: [app],
    supervisor: {
      states: () =>
        new Map([["sample", { state: running ? "running" : "stopped" }]]),
    } as unknown as RelayContext["supervisor"],
  };
}
const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });
const fallback = {
  title: "sample",
  icons: [
    {
      href:
        "data:image/svg+xml," +
        encodeURIComponent(await appFavicon({ name: "sample" }).text()),
      type: "image/svg+xml",
    },
  ],
};

it("reads the root without member identity and resolves base and icon attributes", async () => {
  const ctx = context((req) => {
    expect(req.headers.get("cookie")).toBeNull();
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.headers.get("accept-encoding")).toBe("identity");
    return html(
      '<title>A &amp; B</title><base href="/assets/"><link rel="shortcut icon" href="logo.svg?a=1&amp;b=2" type="image/svg+xml" sizes="any">',
    );
  });
  expect(await readWidgetMetadata(ctx)).toEqual({
    title: "A & B",
    icons: [
      {
        href: "https://sample.office.example/assets/logo.svg?a=1&b=2",
        type: "image/svg+xml",
        sizes: "any",
      },
    ],
  });
});

for (const [href, accepted] of [
  ["javascript:alert(1)", false],
  ["http://sample.office.example/icon.png", false],
  ["data:text/html,a", false],
  ["data:image/png;base64,AA==", true],
  ["https://other.example/icon.png", true],
] as const) {
  it(`filters icon protocol ${href.split(":")[0]} (${accepted})`, async () => {
    let calls = 0;
    const ctx = context(() => {
      calls++;
      return html(`<title>App</title><link rel="icon" href="${href}">`);
    });
    expect((await readWidgetMetadata(ctx)).icons).toEqual(
      accepted ? [{ href }] : fallback.icons,
    );
    expect(calls).toBe(1);
  });
}

it("escapes hostile title and icon attributes and removes office identity", async () => {
  const title = '</title><script>alert("x")</script>';
  const ctx = context(() =>
    html(
      '<title>&lt;/title&gt;&lt;script&gt;alert("x")&lt;/script&gt;</title><link rel="icon" href="data:image/png;base64,AA==">',
    ),
  );
  const metadata = await readWidgetMetadata(ctx);
  expect(metadata.title).toBe(title);
  const result = await applyWidgetMetadata(
    '<head><title>office</title><link rel="icon" href="old"><link rel="manifest" href="manifest"><link rel="apple-touch-icon" href="apple"></head>',
    metadata,
  );
  expect(result.includes("<script>")).toBe(false);
  expect(result.includes("&lt;/title&gt;")).toBe(true);
  expect(result.includes('href="old"')).toBe(false);
  expect(result.includes('rel="manifest"')).toBe(false);
  expect(result.includes("apple-touch-icon")).toBe(false);
});

// The icon must be the bytes the app host serves at /favicon.ico.
async function hostIconBody(icons: { href: string; type?: string }[]) {
  expect(icons).toHaveLength(1);
  const [prefix, body] = icons[0].href.split(",");
  expect(prefix).toBe("data:image/svg+xml");
  expect(icons[0].type).toBe("image/svg+xml");
  return decodeURIComponent(body);
}

it("uses the app host's favicon when the app declares no icon link, without asking upstream", async () => {
  const paths: string[] = [];
  const ctx = context((req) => {
    paths.push(new URL(req.url).pathname);
    return html("<title>App</title>");
  });
  expect(await hostIconBody((await readWidgetMetadata(ctx)).icons)).toBe(
    await appFavicon(ctx.app).text(),
  );
  expect(paths).toEqual(["/"]);
});

it("falls back to the app host's favicon, not the thumbnail, when the read fails", async () => {
  const ctx = context(() => new Response("plain"));
  expect(ctx.app.thumbnailUpdatedAt).toBeDefined();
  const metadata = await readWidgetMetadata(ctx);
  expect(metadata.title).toBe("sample");
  expect(await hostIconBody(metadata.icons)).toBe(
    await appFavicon(ctx.app).text(),
  );
});

it("does not follow redirects or read a stopped app", async () => {
  let calls = 0;
  const ctx = context((req) => {
    calls++;
    // A redirect to an HTML page on the same upstream: following it would
    // read this title.
    return new URL(req.url).pathname === "/"
      ? Response.redirect(`http://127.0.0.1:${upstream!.port}/followed`)
      : html("<title>Followed</title>");
  });
  expect(await readWidgetMetadata(ctx)).toEqual(fallback);
  expect(calls).toBe(1);
  ctx.supervisor = {
    states: () => new Map([["sample", { state: "stopped" }]]),
  } as unknown as RelayContext["supervisor"];
  expect(await readWidgetMetadata(ctx)).toEqual(fallback);
  expect(calls).toBe(1);
});

// Each limit returns the fallback and cancels the upstream stream. The
// deadline case waits out the real two seconds once.
for (const limit of ["bytes", "deadline"] as const) {
  it(`falls back and cancels the upstream stream at the ${limit} boundary`, async () => {
    let cancelled = false;
    const ctx = context(() => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                limit === "bytes"
                  ? "a".repeat(WIDGET_METADATA_MAX_BYTES + 1)
                  : "<title>Partial",
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/html" } },
      );
    });
    const start = Date.now();
    expect(await readWidgetMetadata(ctx)).toEqual(fallback);
    expect(Date.now() - start).toBeLessThan(3500);
    for (let i = 0; i < 50 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(true);
  });
}

// The install manifest (task 8a07aa4e). The browser fetches its icons with no
// cookie, and the app host answers such a fetch with 401, so only an inline
// SVG the app declares can stand for the app. Raster data: icons are dropped
// as well: apps declare small favicons, and an install icon needs at least
// 144px. The office's own PNGs are there for Android only, which installs
// nothing without a raster icon: iOS takes a manifest PNG over its own letter
// icon (Safari 15.4 and later), so on an iPhone every app would wear the
// Isomux icon.
const SVG = "data:image/svg+xml," + encodeURIComponent("<svg/>");
const SVG_BASE64 = "data:image/svg+xml;base64,PHN2Zy8+";
const HOST_SVG =
  "data:image/svg+xml," + encodeURIComponent(appFaviconSvg({ name: "sample" }));
for (const [label, icons, kept] of [
  [
    "keeps the app's inline SVGs at any size",
    [
      { href: SVG, type: "image/svg+xml", sizes: "16x16" },
      { href: SVG_BASE64 },
    ],
    [SVG, SVG_BASE64],
  ],
  [
    "drops app-host and raster icons beside an inline SVG",
    [
      { href: "https://sample.office.example/logo.svg" },
      { href: "data:image/png;base64,AA==" },
      { href: SVG },
    ],
    [SVG],
  ],
  [
    "uses the host icon when no app icon is an inline SVG",
    [
      { href: "https://sample.office.example/logo.svg" },
      { href: "data:image/png;base64,AA==" },
    ],
    [HOST_SVG],
  ],
] as const) {
  it(`install manifest ${label}`, () => {
    const manifest = appManifest(
      { name: "sample" },
      { title: "Sample board", icons: [...icons] },
      { android: true },
    );
    expect(manifest).toMatchObject({
      id: "/sample/",
      start_url: "/sample/",
      scope: "/sample/",
      name: "Sample board",
      short_name: "Sample board",
      display: "standalone",
    });
    const svgs = manifest.icons.filter((icon) => icon.type === "image/svg+xml");
    expect(svgs.map((icon) => icon.src)).toEqual([...kept]);
    expect(svgs.every((icon) => icon.sizes === "any")).toBe(true);
    const rest = manifest.icons.filter((icon) => icon.type !== "image/svg+xml");
    expect(rest.length).toBeGreaterThan(0);
    for (const icon of rest) {
      expect(icon.type).toBe("image/png");
      expect(icon.src).toStartWith("/icons/");
    }
  });
}
