import { afterEach, expect, it } from "bun:test";
import {
  readWidgetMetadata,
  applyWidgetMetadata,
  WIDGET_METADATA_MAX_BYTES,
} from "./app-widget-metadata.ts";
import type { RelayContext } from "./app-proxy.ts";

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
  icons: [{ href: "/api/apps/sample/thumbnail?v=12" }],
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

it("checks the default favicon on the same upstream and falls back on failure", async () => {
  let iconWorks = false;
  const paths: string[] = [];
  const ctx = context((req) => {
    paths.push(new URL(req.url).pathname);
    if (new URL(req.url).pathname === "/") return html("<title>App</title>");
    expect(req.method).toBe("GET");
    return new Response(null, {
      status: iconWorks ? 200 : 404,
      headers: { "Content-Type": "image/x-icon" },
    });
  });
  expect((await readWidgetMetadata(ctx)).icons).toEqual(fallback.icons);
  iconWorks = true;
  expect((await readWidgetMetadata(ctx)).icons).toEqual([
    { href: "https://sample.office.example/favicon.ico" },
  ]);
  expect(paths).toEqual(["/", "/favicon.ico", "/", "/favicon.ico"]);
});

it("does not follow redirects or read a stopped app", async () => {
  let calls = 0;
  const ctx = context(() => {
    calls++;
    return Response.redirect("https://external.invalid/");
  });
  expect(await readWidgetMetadata(ctx)).toEqual(fallback);
  expect(calls).toBe(1);
  ctx.supervisor = {
    states: () => new Map([["sample", { state: "stopped" }]]),
  } as unknown as RelayContext["supervisor"];
  expect(await readWidgetMetadata(ctx)).toEqual(fallback);
  expect(calls).toBe(1);
});

it("falls back on non-HTML and oversized bodies", async () => {
  let oversized = false;
  const ctx = context(() =>
    oversized
      ? html("a".repeat(WIDGET_METADATA_MAX_BYTES + 1))
      : new Response("plain"),
  );
  expect(await readWidgetMetadata(ctx)).toEqual(fallback);
  oversized = true;
  expect(await readWidgetMetadata(ctx)).toEqual(fallback);
});

it("bounds a stalled body by the two-second deadline", async () => {
  const ctx = context(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<title>Partial"));
          },
        }),
        { headers: { "Content-Type": "text/html" } },
      ),
  );
  const start = Date.now();
  expect(await readWidgetMetadata(ctx)).toEqual(fallback);
  expect(Date.now() - start).toBeLessThan(3500);
});

for (const limit of ["bytes", "deadline", "favicon"] as const) {
  it(`cancels the upstream stream at the ${limit} boundary`, async () => {
    let cancelled = false;
    const ctx = context((req) => {
      if (limit === "favicon" && new URL(req.url).pathname === "/")
        return html("<title>App</title>");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                limit === "bytes"
                  ? "a".repeat(WIDGET_METADATA_MAX_BYTES + 1)
                  : "data",
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: {
            "Content-Type": limit === "favicon" ? "image/x-icon" : "text/html",
          },
        },
      );
    });
    await readWidgetMetadata(ctx);
    for (let i = 0; i < 50 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(true);
  });
}
