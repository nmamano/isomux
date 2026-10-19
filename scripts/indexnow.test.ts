import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATIC_PATHS, main as buildDocs } from "./build-docs.ts";
import {
  INDEXNOW_KEY,
  SITE_HOST,
  builtFileFor,
  changedUrls,
  pickBaseSha,
  pingIndexNow,
  type Deployment,
} from "./indexnow.ts";

const ORIGIN = `https://${SITE_HOST}`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A built site: `files` maps a path under the site dir to its bytes, and
// `paths` is the sitemap, written in the shape scripts/build-docs.ts writes.
function site(files: Record<string, string>, paths: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "indexnow-site-"));
  dirs.push(dir);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  const entries = paths.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`);
  writeFileSync(
    join(dir, "sitemap.xml"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...entries,
      "</urlset>",
      "",
    ].join("\n"),
  );
  return dir;
}

const sorted = (urls: string[]) => [...urls].sort();
const abs = (...paths: string[]) => sorted(paths.map((p) => ORIGIN + p));

describe("builtFileFor", () => {
  it("resolves a sitemap path the way cleanUrls serves it", () => {
    const dir = site(
      {
        "index.html": "",
        "about.html": "",
        "es/index.html": "",
        "es/hosted.html": "",
        "docs/index.html": "",
        "docs/agents/index.html": "",
      },
      [],
    );
    const cases: [string, string][] = [
      ["/", "index.html"],
      ["/about", "about.html"],
      ["/es", "es/index.html"],
      ["/es/hosted", "es/hosted.html"],
      ["/docs", "docs/index.html"],
      ["/docs/agents", "docs/agents/index.html"],
    ];
    for (const [path, file] of cases) {
      expect([path, builtFileFor(dir, path)]).toEqual([path, join(dir, file)]);
    }
    expect(builtFileFor(dir, "/demo")).toBeNull();
  });
});

describe("changedUrls", () => {
  it("sends changed, new and removed pages, and skips unchanged and unbuilt ones", () => {
    const base = site(
      {
        "index.html": "landing v1",
        "about.html": "about",
        "docs/agents/index.html": "agents v1",
        "docs/old/index.html": "old page",
      },
      ["/", "/demo", "/about", "/docs/agents", "/docs/old"],
    );
    const head = site(
      {
        "index.html": "landing v1",
        "about.html": "about",
        "docs/agents/index.html": "agents v2",
        "docs/new/index.html": "new page",
      },
      ["/", "/demo", "/about", "/docs/agents", "/docs/new"],
    );
    // /docs/agents changed bytes, /docs/new is new, /docs/old left the
    // sitemap. / and /about are identical; /demo is built in neither.
    expect(sorted(changedUrls(head, base))).toEqual(
      abs("/docs/agents", "/docs/new", "/docs/old"),
    );
  });

  it("sends nothing when the two builds are identical", () => {
    const files = { "index.html": "landing", "docs/agents/index.html": "a" };
    const paths = ["/", "/demo", "/docs/agents"];
    expect(changedUrls(site(files, paths), site(files, paths))).toEqual([]);
  });

  it("sends every built sitemap page when there is no base build", () => {
    const head = site(
      { "index.html": "landing", "docs/agents/index.html": "a" },
      ["/", "/demo", "/docs/agents"],
    );
    expect(sorted(changedUrls(head, null))).toEqual(abs("/", "/docs/agents"));
  });

  it("resolves every URL of the real sitemap except /demo", () => {
    // The fixtures above use a few path shapes; this catches a sitemap path
    // that builtFileFor cannot resolve and so would never be sent.
    buildDocs();
    const locs = [
      ...readFileSync("site/sitemap.xml", "utf8").matchAll(
        /<loc>([^<]+)<\/loc>/g,
      ),
    ].map((m) => m[1]);
    // More than the static pages alone, so the doc pages are in the check.
    expect(locs.length).toBeGreaterThan(STATIC_PATHS.length);
    const sent = new Set(changedUrls("site", null));
    const missing = locs.filter(
      (loc) => loc !== `${ORIGIN}/demo` && !sent.has(loc),
    );
    expect(missing).toEqual([]);
  });
});

describe("pickBaseSha", () => {
  const dep = (
    id: number,
    sha: string,
    createdAt: string,
    over: Partial<Deployment> = {},
  ): Deployment => ({
    id,
    sha,
    environment: "Production",
    createdAt,
    succeeded: true,
    ...over,
  });

  it("picks the newest earlier successful Production deployment", () => {
    const deployments = [
      dep(7, "later", "2026-10-19T09:00:00Z"),
      dep(6, "current", "2026-10-19T08:00:00Z"),
      dep(5, "preview", "2026-10-19T07:00:00Z", { environment: "Preview" }),
      dep(4, "failed", "2026-10-19T06:00:00Z", { succeeded: false }),
      dep(3, "base", "2026-10-19T05:00:00Z"),
      dep(2, "older", "2026-10-19T04:00:00Z"),
    ];
    expect(pickBaseSha(deployments, 6)).toBe("base");
    // The API's order is not a contract: the pick goes by createdAt.
    expect(pickBaseSha([...deployments].reverse(), 6)).toBe("base");
  });

  it("returns null when no earlier deployment qualifies", () => {
    const deployments = [
      dep(6, "current", "2026-10-19T08:00:00Z"),
      dep(5, "preview", "2026-10-19T07:00:00Z", { environment: "Preview" }),
      dep(4, "failed", "2026-10-19T06:00:00Z", { succeeded: false }),
    ];
    expect(pickBaseSha(deployments, 6)).toBeNull();
  });
});

describe("pingIndexNow", () => {
  type Call = { url: string; init: RequestInit };
  function fakeFetch(status: number, body = "") {
    const calls: Call[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(body, { status });
    }) as typeof fetch;
    return { calls, impl };
  }

  it("posts the URL list with the host, key and key location", async () => {
    const urls = [`${ORIGIN}/`, `${ORIGIN}/docs/agents`];
    const { calls, impl } = fakeFetch(200);
    await pingIndexNow(urls, impl);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.indexnow.org/indexnow");
    expect(calls[0].init.method).toBe("POST");
    expect(
      new Headers(calls[0].init.headers).get("content-type")?.split(";")[0],
    ).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      host: SITE_HOST,
      key: INDEXNOW_KEY,
      keyLocation: `${ORIGIN}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    });
  });

  it("accepts 202, IndexNow's answer while the key is not yet validated", async () => {
    const { calls, impl } = fakeFetch(202);
    await pingIndexNow([`${ORIGIN}/`], impl);
    expect(calls.length).toBe(1);
  });

  it("sends no request for an empty list", async () => {
    const { calls, impl } = fakeFetch(200);
    await pingIndexNow([], impl);
    expect(calls.length).toBe(0);
  });

  it("throws on a rejected submission, naming the status", async () => {
    const { calls, impl } = fakeFetch(422, "URLs don't belong to the host");
    await expect(pingIndexNow([`${ORIGIN}/`], impl)).rejects.toThrow(/422/);
    expect(calls.length).toBe(1);
  });
});

it("the key file under site/ holds exactly the key", () => {
  const file = join(import.meta.dir, "..", "site", `${INDEXNOW_KEY}.txt`);
  expect(readFileSync(file, "utf8")).toBe(INDEXNOW_KEY);
});
