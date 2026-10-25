// The self-hosted isomux.com must answer as Vercel answers today, except where
// this file says it differs on purpose. site-host/parity.json holds live
// Vercel responses (recorded 2026-10-25); the replay sends each request to
// createSiteHandler over a copy of site/ with the docs built into it, and
// compares status, Location, the header set and the body.
//
// On purpose, the site host differs from Vercel in:
// - Cache-Control: one policy (CACHE below), so that Cloudflare can cache pages
//   and can never cache markdown, a 406 or the chat.
// - The CSP: Vercel Web Analytics is gone, so va.vercel-scripts.com is too.
// - Headers the Vercel platform adds (IGNORED below).
// - The rows in DIVERGES, each with its reason.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSiteHandler, serveSite, type SiteHandler } from "./server.ts";

const REPO = resolve(import.meta.dir, "..");
const PARITY = JSON.parse(
  readFileSync(join(REPO, "site-host/parity.json"), "utf8"),
) as { cases: Row[] };
const VERCEL_JSON = JSON.parse(readFileSync(join(REPO, "vercel.json"), "utf8"));

type Row = {
  name: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  status: number;
  headers: Record<string, string>;
  bodyBytes: number;
  bodySha256: string;
};

const PAGE = "public, max-age=0, s-maxage=300, must-revalidate";
const ANALYTICS_CSP = " https://va.vercel-scripts.com";
// Vercel platform headers the site host does not send.
const IGNORED = new Set([
  "server",
  "access-control-allow-origin",
  "content-disposition",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "refresh",
]);
// Headers the site host may add that the recording does not hold.
const OURS_EXTRA = new Set(["etag", "content-length", "date", "last-modified"]);

const NOT_FOUND_HTML = PARITY.cases.find((r) => r.name === "not found page")!;

/**
 * Rows where the site host answers differently on purpose. `headers: false`
 * skips the header-set comparison (the response is of another kind).
 */
const DIVERGES: Record<
  string,
  {
    why: string;
    status: number;
    contentType?: string;
    cacheControl?: string;
    bodySha256?: string;
    body?: (text: string) => void;
    headers: boolean;
  }
> = {
  "redirect self-hosted trailing slash": {
    why: "no route matches; Vercel sends its platform 404, the site host its own 404",
    status: 404,
    headers: true,
  },
  "api chat ts source": {
    why: "Vercel redirects a function's source name to the function; the site host serves the API 404",
    status: 404,
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=60",
    body: (text) => {
      expect(JSON.parse(text).error.code).toBe("not_found");
      expect(text).not.toContain("export default");
    },
    headers: false,
  },
  traversal: {
    why: "Vercel's platform 400; the site host serves the not-found page",
    status: 404,
    contentType: "text/html; charset=utf-8",
    cacheControl: "public, max-age=60",
    bodySha256: NOT_FOUND_HTML.bodySha256,
    headers: false,
  },
  "null byte": {
    why: "Vercel's platform 400; the site host serves the not-found page",
    status: 404,
    contentType: "text/html; charset=utf-8",
    cacheControl: "public, max-age=60",
    bodySha256: NOT_FOUND_HTML.bodySha256,
    headers: false,
  },
  "bad percent": {
    why: "Vercel's platform 400; the site host serves the not-found page",
    status: 404,
    contentType: "text/html; charset=utf-8",
    cacheControl: "public, max-age=60",
    bodySha256: NOT_FOUND_HTML.bodySha256,
    headers: false,
  },
  "vercel insights": {
    why: "Vercel Web Analytics is removed; the path is a Vercel platform path",
    status: 404,
    contentType: "text/html; charset=utf-8",
    cacheControl: "public, max-age=60",
    bodySha256: NOT_FOUND_HTML.bodySha256,
    headers: false,
  },
};

// The file under site/ each 200 row serves.
const FILES: Record<string, string> = {
  home: "index.html",
  "home HEAD": "index.html",
  "home markdown": "_agent/index.md",
  "home markdown HEAD": "_agent/index.md",
  "home markdown q-lower": "index.html",
  "home browser accept": "index.html",
  "www apex": "index.html",
  "clean page": "about.html",
  "clean page trailing slash": "about.html",
  "clean page HEAD": "about.html",
  "clean page markdown (no middleware)": "about.html",
  "clean page 406 (no middleware)": "about.html",
  "double slash": "about.html",
  encoded: "about.html",
  docs: "docs/index.html",
  "docs slash": "docs/index.html",
  "docs markdown": "_agent/docs/index.md",
  "docs slash markdown": "_agent/docs/index.md",
  "doc page": "docs/hosting/index.html",
  "doc page slash": "docs/hosting/index.html",
  "doc page markdown": "_agent/docs/hosting/index.md",
  "agent md file": "_agent/docs/hosting/index.md",
  "agent index md": "_agent/index.md",
  "security.txt rewrite": "security.txt",
  "security.txt": "security.txt",
  "api-catalog rewrite": "api-catalog.json",
  "api-catalog file": "api-catalog.json",
  demo: "demo/index.html",
  "demo slash": "demo/index.html",
  "demo app": "demo/app.html",
  robots: "robots.txt",
  llms: "llms.txt",
  openapi: "openapi.json",
  sitemap: "sitemap.xml",
  css: "footer.css",
  js: "chatbot.js",
  svg: "favicon.svg",
  ico: "favicon.ico",
  png: "favicon.png",
  jpeg: "add-to-home-screen.jpeg",
  mp4: "office-trimmed.mp4",
  gif: "office.gif",
  "indexnow key": "fbffa404de590d880791f3058b42c157.txt",
  "locale page": "es/index.html",
  "locale page no slash": "es/index.html",
  "locale hosted": "zh/hosted.html",
  "hosted-terms": "hosted-terms.html",
  "hosted-privacy": "hosted-privacy.html",
};

/** The Cache-Control the site host sends for a recorded row. */
function cachePolicy(row: Row): string {
  const type = row.headers["content-type"] ?? "";
  const path = new URL(row.url).pathname;
  if (path === "/api/chat") return "no-store";
  if (type.startsWith("text/markdown")) return "no-store";
  if (row.status === 405 || row.status === 406) return "no-store";
  // api/not-found keeps its own value.
  if (row.headers["cache-control"] === "public, max-age=60")
    return "public, max-age=60";
  if (row.status === 200 || (row.status >= 300 && row.status < 400))
    return PAGE;
  throw new Error(`no cache policy for row ${row.name}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- Fixture: the repository with a private copy of site/, docs built ---

let root = "";
let served = "";
let handlerPromise: Promise<SiteHandler> | undefined;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "site-host-"));
  // Every top-level entry but site/ is the repository's own, so build-docs
  // reads what it reads in CI and writes only into the copy.
  for (const entry of readdirSync(REPO)) {
    if (entry === "site" || entry === ".git") continue;
    symlinkSync(join(REPO, entry), join(root, entry));
  }
  cpSync(join(REPO, "site"), join(root, "site"), { recursive: true });
  const build = Bun.spawnSync({
    cmd: [process.execPath, join(REPO, "scripts/build-docs.ts")],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  // build:demo bundles the UI; routing needs only the two pages it copies.
  mkdirSync(join(root, "site/demo"), { recursive: true });
  copyFileSync(join(REPO, "ui/demo.html"), join(root, "site/demo/index.html"));
  copyFileSync(
    join(REPO, "ui/demo-app.html"),
    join(root, "site/demo/app.html"),
  );
  served = join(root, VERCEL_JSON.outputDirectory);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (root) rmSync(root, { recursive: true, force: true });
});

function site(): Promise<SiteHandler> {
  return (handlerPromise ??= createSiteHandler({
    root,
    vercelJson: VERCEL_JSON,
  }));
}

describe("parity with isomux.com on Vercel", () => {
  const rows = PARITY.cases.map((row, i) => [row.name, row, i] as const);

  it("covers every recorded 200 with a file, and every divergence with a row", () => {
    const names = new Set(PARITY.cases.map((r) => r.name));
    for (const name of [...Object.keys(FILES), ...Object.keys(DIVERGES)])
      expect(names.has(name) ? name : `missing row: ${name}`).toBe(name);
    for (const row of PARITY.cases)
      if (row.status === 200 && !DIVERGES[row.name])
        expect(FILES[row.name] ? row.name : `no file: ${row.name}`).toBe(
          row.name,
        );
  });

  it.each(rows)("%s", async (_name, row, i) => {
    const handle = await site();
    const res = await handle(
      new Request(row.url, {
        method: row.method,
        // One fresh address per row, so the chat rows start with a full quota.
        headers: { ...row.requestHeaders, "x-forwarded-for": `192.0.2.${i}` },
      }),
    );
    const body = new Uint8Array(await res.arrayBuffer());
    const diverges = DIVERGES[row.name];
    const status = diverges?.status ?? row.status;
    expect(res.status).toBe(status);

    const cache = res.headers.get("cache-control");
    if (diverges) {
      expect(cache).not.toBeNull();
      if (diverges.cacheControl) expect(cache).toBe(diverges.cacheControl);
      if (diverges.contentType)
        expect(res.headers.get("content-type")).toBe(diverges.contentType);
      if (diverges.bodySha256) expect(sha256(body)).toBe(diverges.bodySha256);
      diverges.body?.(new TextDecoder().decode(body));
    } else {
      expect(cache).toBe(cachePolicy(row));
    }

    if (!diverges || diverges.headers) {
      const redirect = status >= 300 && status < 400;
      const expected: Record<string, string> = {};
      for (const [name, value] of Object.entries(row.headers)) {
        if (IGNORED.has(name) || name === "cache-control") continue;
        if (redirect && name === "content-type") continue;
        if (diverges && name === "content-type") continue;
        expected[name] =
          name === "content-security-policy"
            ? value.replace(ANALYTICS_CSP, "")
            : value;
      }
      const actual: Record<string, string> = {};
      for (const [name, value] of res.headers) {
        if (OURS_EXTRA.has(name) || name === "cache-control") continue;
        if (diverges && name === "content-type") continue;
        if (redirect && name === "content-type") continue;
        actual[name] = value;
      }
      expect(actual).toEqual(expected);
    }

    if (diverges) return;
    if (row.bodyBytes === 0) {
      expect(body.length).toBe(0);
    } else if (row.status === 200) {
      const file = readFileSync(join(served, FILES[row.name]));
      expect(sha256(body)).toBe(sha256(file));
    } else if (row.status < 300 || row.status >= 400) {
      // Bodies the code writes (not-found, 406, chat errors) match Vercel's.
      expect(sha256(body)).toBe(row.bodySha256);
    }
  });
});

describe("vercel.json strict parse", () => {
  type Config = {
    [key: string]: unknown;
    redirects: Record<string, unknown>[];
  };
  const refusals: [string, (config: Config) => void][] = [
    ["an unknown top-level key", (c) => (c.trailingSlash = false)],
    ["another unknown top-level key", (c) => (c.functions = {})],
    [
      "a has type other than host",
      (c) =>
        (c.redirects[0].has = [{ type: "header", key: "x-a", value: "1" }]),
    ],
    [
      "an unknown rule key",
      (c) => (c.redirects[0].missing = [{ type: "host", value: "a.b" }]),
    ],
    ["a redirect status code", (c) => (c.redirects[0].statusCode = 301)],
  ];
  // The key the refusal must name, per case.
  const named = [
    "trailingSlash",
    "functions",
    "header",
    "missing",
    "statusCode",
  ];

  it("accepts the vercel.json in the repository", async () => {
    expect(typeof (await site())).toBe("function");
  });

  it.each(refusals.map(([label, edit], i) => [label, edit, named[i]] as const))(
    "refuses %s at boot, naming it",
    async (_label, edit, key) => {
      const config = structuredClone(VERCEL_JSON) as Config;
      edit(config);
      const refusal = await createSiteHandler({
        root,
        vercelJson: config,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain(key);
    },
  );
});

describe("files outside the served directory", () => {
  const paths = [
    "/..%2fpackage.json",
    "/%2e%2e%2fpackage.json",
    "/..%5cpackage.json",
    "/docs/..%2f..%2fpackage.json",
    "/api/..%2fmiddleware.ts",
    "/..%2fapi%2fchat.ts",
    "/%2e%2e/vercel.json",
    "/package.json%00.html",
  ];

  it.each(paths)("%s serves the not-found page", async (path) => {
    // The files exist beside site/, so a traversal would find them.
    for (const file of ["package.json", "middleware.ts", "vercel.json"])
      expect(existsSync(join(root, file))).toBe(true);
    const res = await (await site())(new Request(`https://isomux.com${path}`));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.status).toBe(404);
    for (const file of ["package.json", "middleware.ts", "vercel.json"])
      expect(sha256(body)).not.toBe(sha256(readFileSync(join(root, file))));
    expect(new TextDecoder().decode(body)).not.toContain("export default");
  });
});

describe("redirects stay on isomux.com", () => {
  // A path that starts with two slashes is a protocol-relative URL when it
  // comes back in Location: //evil.example/x sends the visitor to evil.example.
  const paths = [
    "//evil.example/x.html",
    "/\\evil.example/x.html",
    "//evil.example/index",
    "///evil.example/a.html",
    "//about.html",
    "//docs/index.html",
  ];

  it.each(paths)("%s", async (path) => {
    const handle = await site();
    // The cleanUrls redirect is live: a plain .html path redirects on site.
    const plain = await handle(new Request("https://isomux.com/about.html"));
    expect(plain.status).toBe(308);
    expect(plain.headers.get("location")).toBe("/about");

    const res = await handle(new Request(`https://isomux.com${path}`));
    await res.arrayBuffer();
    const location = res.headers.get("location");
    if (location !== null)
      expect(new URL(location, "https://isomux.com/").host).toBe("isomux.com");
  });
});

describe("cleanUrls redirects", () => {
  // Vercel builds them from the files of the output directory.
  it("redirects only a .html path whose file exists", async () => {
    const handle = await site();
    const named = await handle(new Request("https://isomux.com/about.html"));
    expect(named.status).toBe(308);
    expect(existsSync(join(served, "no-such-page.html"))).toBe(false);
    const missing = await handle(
      new Request("https://isomux.com/no-such-page.html"),
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("location")).toBeNull();
  });
});

describe("byte ranges", () => {
  const VIDEO = "/office-trimmed.mp4";
  const get = async (range: string) =>
    (await site())(
      new Request(`https://isomux.com${VIDEO}`, { headers: { range } }),
    );
  const whole = () => readFileSync(join(served, VIDEO));

  it("serves one range with 206 and its Content-Range, never cached", async () => {
    const res = await get("bytes=10-19");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes 10-19/${whole().length}`,
    );
    expect(res.headers.get("content-length")).toBe("10");
    expect(sha256(body)).toBe(sha256(whole().subarray(10, 20)));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("serves a suffix range: the last bytes", async () => {
    const size = whole().length;
    const res = await get("bytes=-10");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes ${size - 10}-${size - 1}/${size}`,
    );
    expect(sha256(body)).toBe(sha256(whole().subarray(size - 10)));
  });

  it("answers 416 with the size to a range past the end", async () => {
    const size = whole().length;
    const res = await get(`bytes=${size}-`);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${size}`);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // RFC 9110 14.2: a server may ignore Range; an invalid one (last before
  // first) or several ranges get the whole file.
  it.each(["bytes=0-1,5-6", "bytes=20-10", "items=0-1"])(
    "sends the whole file for %s",
    async (range) => {
      const res = await get(range);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBeNull();
      expect(sha256(body)).toBe(sha256(whole()));
      expect(res.headers.get("cache-control")).toBe(PAGE);
    },
  );
});

describe("conditional requests", () => {
  it("answers 304 with no body to a matching If-None-Match", async () => {
    const handle = await site();
    const first = await handle(new Request("https://isomux.com/about"));
    await first.arrayBuffer();
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    const again = await handle(
      new Request("https://isomux.com/about", {
        headers: { "if-none-match": etag! },
      }),
    );
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe(PAGE);
    const other = await handle(
      new Request("https://isomux.com/about", {
        headers: { "if-none-match": '"not-this-one"' },
      }),
    );
    expect(other.status).toBe(200);
  });
});

describe("chat through the site host", () => {
  it("streams the answer with no-store", async () => {
    globalThis.fetch = (async (url: string) =>
      String(url) === "https://api.anthropic.com/v1/messages"
        ? new Response(
            `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi." } })}\n\n`,
          )
        : new Response(null, { status: 204 })) as unknown as typeof fetch;
    try {
      const res = await (
        await site()
      )(
        new Request("https://isomux.com/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "192.0.2.250",
          },
          body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain('"text":"Hi."');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("answers 500 with a body and no-store when a function throws", async () => {
    const boom = mkdtempSync(join(tmpdir(), "site-host-boom-"));
    try {
      mkdirSync(join(boom, "site"));
      writeFileSync(join(boom, "site/index.html"), "<p>home</p>");
      mkdirSync(join(boom, "api"));
      writeFileSync(
        join(boom, "api/boom.ts"),
        'export default function () { throw new Error("boom"); }\n',
      );
      const handle = await createSiteHandler({
        root: boom,
        vercelJson: { outputDirectory: "site", cleanUrls: true },
      });
      // The fixture serves its page, so the 500 below comes from the function.
      expect((await handle(new Request("https://isomux.com/"))).status).toBe(
        200,
      );
      const res = await handle(new Request("https://isomux.com/api/boom"));
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.text()).length).toBeGreaterThan(0);
    } finally {
      rmSync(boom, { recursive: true, force: true });
    }
  });
});

describe("serveSite", () => {
  it("serves on a Unix socket, takes the host from Host and the visitor from X-Forwarded-For", async () => {
    const handle = await site();
    const socket = join(root, "site.sock");
    const server = serveSite(handle, { unix: socket });
    try {
      const get = (url: string, headers: Record<string, string> = {}) =>
        fetch(url, { unix: socket, redirect: "manual", headers } as never);
      const home = await get("http://isomux.com/");
      expect(home.status).toBe(200);
      expect(sha256(new Uint8Array(await home.arrayBuffer()))).toBe(
        sha256(readFileSync(join(served, "index.html"))),
      );
      const www = await get("http://www.isomux.com/docs/hosting?x=1");
      expect(www.status).toBe(308);
      expect(www.headers.get("location")).toBe(
        "https://isomux.com/docs/hosting?x=1",
      );

      // Caddy sets X-Forwarded-For; the limit counts the visitor it names.
      const post = (ip: string) =>
        fetch("http://isomux.com/api/chat", {
          unix: socket,
          method: "POST",
          headers: { "x-forwarded-for": ip },
          body: "{",
        } as never);
      for (let n = 0; n < 5; n++)
        expect((await post("192.0.2.251")).status).toBe(400);
      expect((await post("192.0.2.251")).status).toBe(429);
      expect((await post("192.0.2.252")).status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  it("serves on a TCP port", async () => {
    const server = serveSite(await site(), { port: 0, hostname: "127.0.0.1" });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/robots.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(
        readFileSync(join(served, "robots.txt"), "utf8"),
      );
    } finally {
      await server.stop(true);
    }
  });
});
