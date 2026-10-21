// The built UI's static files: caching and compression (task ee3e0be8).
//
// A phone that opens the office again must not download the bundle again: a
// file with bun's content hash in its name is cached for a year, every other
// file revalidates to a 304, and compressible files go out as brotli or gzip.
// The compressors are injected so a test can count and gate them; the cache
// bound is injected so eviction is reachable with small files.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import { createStaticAssets, type StaticAssetsDeps } from "./static-assets.ts";

let dist: string;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "static-assets-"));
  dist = join(root, "dist");
  mkdirSync(dist);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const JS = "export const greeting = 'hello';\n".repeat(200);

function put(name: string, body: string | Uint8Array, mtimeSec?: number) {
  const path = join(dist, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://office.test${path}`, { headers });
}

// Real zlib behind a counter, with brotli held until the test releases it.
// brotliSettled() resolves once every brotli call made so far has finished and
// the code under test has run its callbacks on the result.
function countingDeps(opts: { holdBrotli?: boolean } = {}) {
  const calls = { gzip: 0, brotli: 0 };
  const pending: Promise<unknown>[] = [];
  let release: () => void = () => {};
  const gate = opts.holdBrotli
    ? new Promise<void>((resolve) => (release = resolve))
    : Promise.resolve();
  const deps: StaticAssetsDeps = {
    gzip: async (bytes) => {
      calls.gzip++;
      return new Uint8Array(gzipSync(bytes));
    },
    brotli: (bytes) => {
      calls.brotli++;
      const done = gate.then(() => new Uint8Array(brotliCompressSync(bytes)));
      pending.push(done);
      return done;
    },
  };
  const brotliSettled = async () => {
    await Promise.all(pending);
    await Bun.sleep(0);
  };
  return { deps, calls, releaseBrotli: () => release(), brotliSettled };
}

async function decoded(res: Response): Promise<string> {
  const body = new Uint8Array(await res.arrayBuffer());
  const encoding = res.headers.get("content-encoding");
  if (encoding === "br") return brotliDecompressSync(body).toString("utf8");
  if (encoding === "gzip") return gunzipSync(body).toString("utf8");
  expect(encoding).toBeNull();
  return new TextDecoder().decode(body);
}

describe("static assets: cache policy", () => {
  it("caches a content-hashed chunk for a year and revalidates every other file", async () => {
    put("index-9r7r4sjc.js", JS);
    put("architecture-7EHR7CIX-9twvct6r.js", JS);
    put("index.js", JS);
    put("sw.js", JS);
    put("xterm.css", "body{}");
    // Hash-shaped names outside the top level are not bun's chunks.
    put("assets/fonts/inter-abcd1234.js", JS);
    // Seven characters is not bun's hash.
    put("index-9r7r4sj.js", JS);
    const assets = createStaticAssets(dist, countingDeps().deps);

    const policy = async (path: string) => {
      const res = await assets.serve(get(path), path);
      expect(res).not.toBeNull();
      const cc = res!.headers.get("cache-control") ?? "";
      return {
        path,
        immutable: cc.includes("immutable") && cc.includes("max-age=31536000"),
        noCache: cc.includes("no-cache"),
        private: cc.includes("private"),
        etag: res!.headers.get("etag") !== null,
      };
    };

    for (const path of [
      "/index-9r7r4sjc.js",
      "/architecture-7EHR7CIX-9twvct6r.js",
    ]) {
      // private: the files sit behind the office's sign-in.
      expect(await policy(path)).toMatchObject({
        path,
        immutable: true,
        noCache: false,
        private: true,
      });
    }
    for (const path of [
      "/index.js",
      "/sw.js",
      "/xterm.css",
      "/assets/fonts/inter-abcd1234.js",
      "/index-9r7r4sj.js",
    ]) {
      expect(await policy(path)).toMatchObject({
        path,
        immutable: false,
        noCache: true,
        etag: true,
      });
    }
  });

  it("answers a matching If-None-Match with a bodyless 304 that keeps the cache headers", async () => {
    put("index.js", JS);
    const assets = createStaticAssets(dist, countingDeps().deps);
    const first = (await assets.serve(get("/index.js"), "/index.js"))!;
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();

    for (const inm of [etag, `"not-it", ${etag}`, "*"]) {
      const res = (await assets.serve(
        get("/index.js", { "If-None-Match": inm, "Accept-Encoding": "gzip" }),
        "/index.js",
      ))!;
      expect({ inm, status: res.status }).toEqual({ inm, status: 304 });
      expect((await res.arrayBuffer()).byteLength).toBe(0);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toContain("no-cache");
      expect(res.headers.get("vary") ?? "").toMatch(/accept-encoding/i);
    }

    const stale = (await assets.serve(
      get("/index.js", { "If-None-Match": '"not-it"' }),
      "/index.js",
    ))!;
    expect(stale.status).toBe(200);
    expect(await decoded(stale)).toBe(JS);
  });

  it("a rebuilt file gets a new ETag and its new bytes, compressed copies included", async () => {
    put("index.js", JS, 1_700_000_000);
    const { deps, brotliSettled } = countingDeps();
    const assets = createStaticAssets(dist, deps);
    const enc = { "Accept-Encoding": "gzip, br" };
    const before = (await assets.serve(get("/index.js", enc), "/index.js"))!;
    const oldEtag = before.headers.get("etag")!;
    expect(await decoded(before)).toBe(JS);
    await brotliSettled();
    // brotli is ready now, so the old bytes sit in both cached encodings.
    const brBefore = (await assets.serve(get("/index.js", enc), "/index.js"))!;
    expect(brBefore.headers.get("content-encoding")).toBe("br");
    await brBefore.arrayBuffer();

    const rebuilt = "export const greeting = 'goodbye';\n".repeat(150);
    put("index.js", rebuilt, 1_700_000_100);

    const revalidate = (await assets.serve(
      get("/index.js", { ...enc, "If-None-Match": oldEtag }),
      "/index.js",
    ))!;
    expect(revalidate.status).toBe(200);
    expect(revalidate.headers.get("etag")).not.toBe(oldEtag);
    expect(await decoded(revalidate)).toBe(rebuilt);

    await brotliSettled();
    for (const accept of ["gzip", "br", "identity"]) {
      const res = (await assets.serve(
        get("/index.js", { "Accept-Encoding": accept }),
        "/index.js",
      ))!;
      expect({ accept, body: await decoded(res) }).toEqual({
        accept,
        body: rebuilt,
      });
    }
  });
});

describe("static assets: compression", () => {
  it("sends brotli once it is ready, gzip until then, and honours q=0", async () => {
    put("index.js", JS);
    const { deps, releaseBrotli, brotliSettled } = countingDeps({
      holdBrotli: true,
    });
    const assets = createStaticAssets(dist, deps);
    const serve = async (accept: string | null) => {
      const headers: Record<string, string> =
        accept === null ? {} : { "Accept-Encoding": accept };
      const res = (await assets.serve(get("/index.js", headers), "/index.js"))!;
      const encoding = res.headers.get("content-encoding");
      const length = res.headers.get("content-length");
      const raw = new Uint8Array(await res.clone().arrayBuffer());
      // Required on an encoded body; checked whenever it is present.
      if (encoding !== null || length !== null) {
        expect({ accept, length }).toEqual({
          accept,
          length: String(raw.byteLength),
        });
      }
      expect(res.headers.get("content-type") ?? "").toMatch(/javascript/);
      expect(res.headers.get("vary") ?? "").toMatch(/accept-encoding/i);
      expect({ accept, body: await decoded(res) }).toEqual({
        accept,
        body: JS,
      });
      return encoding;
    };

    expect(await serve("gzip, deflate, br")).toBe("gzip");
    releaseBrotli();
    await brotliSettled();
    expect(await serve("gzip, deflate, br")).toBe("br");
    expect(await serve("br;q=0, gzip")).toBe("gzip");
    expect(await serve("gzip")).toBe("gzip");
    expect(await serve("identity")).toBeNull();
    expect(await serve(null)).toBeNull();
  });

  it("compresses a hashed chunk and CSS too, and never a font or an image", async () => {
    put("index-9r7r4sjc.js", JS);
    put("xterm.css", ".xterm{color:red}\n".repeat(100));
    put("assets/fonts/inter.woff2", new Uint8Array(4096).fill(7));
    put("icon.png", new Uint8Array(4096).fill(7));
    const { deps, calls } = countingDeps();
    const assets = createStaticAssets(dist, deps);
    const enc = { "Accept-Encoding": "gzip, br" };

    const chunk = (await assets.serve(
      get("/index-9r7r4sjc.js", enc),
      "/index-9r7r4sjc.js",
    ))!;
    expect(chunk.headers.get("content-encoding")).toBe("gzip");
    expect(await decoded(chunk)).toBe(JS);
    const css = (await assets.serve(get("/xterm.css", enc), "/xterm.css"))!;
    expect(css.headers.get("content-encoding")).toBe("gzip");
    expect(css.headers.get("content-type") ?? "").toMatch(/text\/css/);
    await css.arrayBuffer();
    const gzipCallsForText = calls.gzip;
    expect(gzipCallsForText).toBe(2);

    for (const path of ["/assets/fonts/inter.woff2", "/icon.png"]) {
      const res = (await assets.serve(get(path, enc), path))!;
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect(res.headers.get("content-encoding")).toBeNull();
      expect((await res.arrayBuffer()).byteLength).toBe(4096);
    }
    expect(calls.gzip).toBe(gzipCallsForText);
  });

  it("two first requests at once compress the file once", async () => {
    put("index.js", JS);
    const { deps, calls, releaseBrotli, brotliSettled } = countingDeps({
      holdBrotli: true,
    });
    const assets = createStaticAssets(dist, deps);
    const enc = { "Accept-Encoding": "gzip, br" };

    const [a, b] = await Promise.all([
      assets.serve(get("/index.js", enc), "/index.js"),
      assets.serve(get("/index.js", enc), "/index.js"),
    ]);
    expect(await decoded(a!)).toBe(JS);
    expect(await decoded(b!)).toBe(JS);
    expect(calls).toEqual({ gzip: 1, brotli: 1 });

    releaseBrotli();
    await brotliSettled();
    const later = await Promise.all(
      [1, 2, 3].map(() => assets.serve(get("/index.js", enc), "/index.js")),
    );
    for (const res of later) {
      expect(res!.headers.get("content-encoding")).toBe("br");
      expect(await decoded(res!)).toBe(JS);
    }
    expect(calls).toEqual({ gzip: 1, brotli: 1 });
  });

  it("HEAD gets the GET headers and no body", async () => {
    put("index.js", JS);
    const assets = createStaticAssets(dist, countingDeps().deps);
    const enc = { "Accept-Encoding": "gzip" };
    const getRes = (await assets.serve(get("/index.js", enc), "/index.js"))!;
    const head = (await assets.serve(
      new Request("http://office.test/index.js", {
        method: "HEAD",
        headers: enc,
      }),
      "/index.js",
    ))!;
    expect(head.status).toBe(200);
    for (const name of [
      "content-encoding",
      "content-length",
      "content-type",
      "etag",
      "cache-control",
      "vary",
    ]) {
      expect({ name, value: head.headers.get(name) }).toEqual({
        name,
        value: getRes.headers.get(name),
      });
    }
    expect(head.headers.get("content-encoding")).toBe("gzip");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });
});

describe("static assets: lookup", () => {
  it("returns null for a missing file, a directory, and a path outside the dist dir", async () => {
    put("index.js", JS);
    put("assets/fonts/fonts.css", "x{}");
    writeFileSync(join(root, "secret.txt"), "not for the browser");
    const assets = createStaticAssets(dist, countingDeps().deps);
    for (const path of [
      "/missing-abcd1234.js",
      "/nope.css",
      "/assets",
      "/assets/fonts",
      "/../secret.txt",
    ]) {
      expect({ path, res: await assets.serve(get("/x"), path) }).toEqual({
        path,
        res: null,
      });
    }
    // The control: the same lookup finds a file that is there.
    expect((await assets.serve(get("/index.js"), "/index.js"))?.status).toBe(
      200,
    );
  });
});

describe("static assets: memory bound", () => {
  it("evicts the least recently used compressed file over the byte cap", async () => {
    // Fixed-size fake output, so the cap counts whole entries: an entry is
    // about 200 bytes (gzip + brotli), the cap holds two, not three.
    const calls: Record<string, number> = {};
    const fake = (bytes: Uint8Array) => {
      const key = new TextDecoder().decode(bytes);
      calls[key] = (calls[key] ?? 0) + 1;
      return Promise.resolve(new Uint8Array(100));
    };
    const assets = createStaticAssets(dist, {
      gzip: fake,
      brotli: () => Promise.resolve(new Uint8Array(100)),
      maxCacheBytes: 450,
    });
    for (const name of ["a", "b", "c"]) put(`${name}.js`, name);
    const hit = async (name: string) => {
      const res = await assets.serve(
        get(`/${name}.js`, { "Accept-Encoding": "gzip" }),
        `/${name}.js`,
      );
      await res!.arrayBuffer();
      await Bun.sleep(0);
    };

    await hit("a");
    await hit("b");
    await hit("a"); // a is now the most recently used
    await hit("c"); // over the cap: b goes, not a
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
    await hit("a");
    expect(calls.a).toBe(1);
    await hit("b");
    expect(calls.b).toBe(2);
  });
});
