// Static files of the built UI (ui/dist): caching and compression, so a phone
// downloads the bundle once per build instead of on every open.
//
// A chunk name that carries bun's content hash never changes content, so it is
// cached for a year. Every other file (index.js, CSS, fonts) is revalidated
// with an ETag and answers 304 when it did not change. Compressible files are
// sent as brotli or gzip; the compressed bytes are kept in memory per file and
// replaced when the file changes on disk. The server compresses for every
// office, with or without Caddy in front: Caddy passes an encoded response
// through as it is.

import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

export interface StaticAssetsDeps {
  gzip?: (bytes: Uint8Array) => Promise<Uint8Array>;
  brotli?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** Total bytes the compression cache may hold before it evicts. */
  maxCacheBytes?: number;
}

export interface StaticAssets {
  /** The response for a file under distDir, or null when there is no such file. */
  serve(req: Request, pathname: string): Promise<Response | null>;
}

// A sanity bound: the build does not clean ui/dist, so chunk names of old
// builds pile up, and each one an old tab asks for gets an entry.
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

const IMMUTABLE = "private, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".html",
  ".txt",
  ".map",
]);

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

async function defaultGzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await gzipAsync(bytes, { level: 6 }));
}

// Quality 11 takes about 10 s for the 3 MB entry, on a zlib worker thread, once
// per build. Requests get gzip until it is done.
async function defaultBrotli(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await brotliAsync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
      },
    }),
  );
}

/** True for a chunk name with bun's content hash, such as /index-9r7r4sjc.js. */
export function isHashedAsset(pathname: string): boolean {
  return /^\/[^/]+-[a-z0-9]{8}\.js$/.test(pathname);
}

// The encodings the client accepts, from Accept-Encoding. A q of 0 refuses.
function acceptedEncodings(req: Request): Set<string> {
  const accepted = new Set<string>();
  for (const part of (req.headers.get("accept-encoding") ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q !== undefined && !(Number(q.slice(2)) > 0)) continue;
    accepted.add(name);
  }
  return accepted;
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

interface CacheEntry {
  key: string;
  // Resolves to the gzip bytes, or null when the file changed during the read
  // and nothing was cached.
  gzip: Promise<Uint8Array | null>;
  brotli: Uint8Array | null;
  bytes: number;
}

export function createStaticAssets(
  distDir: string,
  deps: StaticAssetsDeps = {},
): StaticAssets {
  const root = resolve(distDir);
  const compressGzip = deps.gzip ?? defaultGzip;
  const compressBrotli = deps.brotli ?? defaultBrotli;
  const maxBytes = deps.maxCacheBytes ?? MAX_CACHE_BYTES;
  // Map order is use order: the first entry is the least recently used.
  const cache = new Map<string, CacheEntry>();
  let cachedBytes = 0;

  const drop = (path: string, entry: CacheEntry) => {
    if (cache.get(path) !== entry) return;
    cache.delete(path);
    cachedBytes -= entry.bytes;
  };

  const account = (path: string, entry: CacheEntry, added: number) => {
    if (cache.get(path) !== entry) return;
    entry.bytes += added;
    cachedBytes += added;
    for (const [oldPath, old] of cache) {
      if (cachedBytes <= maxBytes) break;
      drop(oldPath, old);
    }
  };

  // The cached entry for this version of the file, made on first use. Runs
  // with no await between the lookup and the insert, so concurrent first
  // requests share one entry and compress once.
  const entryFor = (path: string, key: string): CacheEntry => {
    const hit = cache.get(path);
    if (hit && hit.key === key) {
      cache.delete(path);
      cache.set(path, hit);
      return hit;
    }
    if (hit) drop(path, hit);
    const entry: CacheEntry = {
      key,
      gzip: Promise.resolve(null),
      brotli: null,
      bytes: 0,
    };
    cache.set(path, entry);
    entry.gzip = (async () => {
      const bytes = await Bun.file(path).bytes();
      // A build can rewrite the file during the read: cache only bytes read
      // between two stats that agree.
      const after = await stat(path).catch(() => null);
      if (!after || versionKey(after) !== key) {
        drop(path, entry);
        return null;
      }
      void compressBrotli(bytes).then(
        (br) => {
          if (cache.get(path) !== entry) return;
          entry.brotli = br;
          account(path, entry, br.byteLength);
        },
        (err) => console.error(`[static] brotli failed for ${path}:`, err),
      );
      const gz = await compressGzip(bytes);
      account(path, entry, gz.byteLength);
      return gz;
    })();
    entry.gzip.catch(() => drop(path, entry));
    return entry;
  };

  return {
    async serve(req, pathname) {
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(root + sep)) return null;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return null;

      const key = versionKey(info);
      const etag = `W/"${key}"`;
      const compressible = COMPRESSIBLE.has(extname(path).toLowerCase());
      const headers: Record<string, string> = {
        // Bun's type from the extension, as Bun.file responses had before.
        "Content-Type": Bun.file(path).type,
        "Cache-Control": isHashedAsset(pathname) ? IMMUTABLE : REVALIDATE,
        ETag: etag,
      };
      if (compressible) headers.Vary = "Accept-Encoding";

      if (etagMatches(req.headers.get("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers });
      }

      const head = req.method === "HEAD";
      const accepted = acceptedEncodings(req);
      if (compressible && (accepted.has("br") || accepted.has("gzip"))) {
        const entry = entryFor(path, key);
        const encoded: [string, Uint8Array | null] =
          entry.brotli && accepted.has("br")
            ? ["br", entry.brotli]
            : accepted.has("gzip")
              ? ["gzip", await entry.gzip.catch(() => null)]
              : ["br", null];
        const [encoding, body] = encoded;
        if (body) {
          headers["Content-Encoding"] = encoding;
          headers["Content-Length"] = String(body.byteLength);
          // The compressors return plain ArrayBuffer-backed arrays.
          const bytes = body as Uint8Array<ArrayBuffer>;
          return new Response(head ? null : bytes, { headers });
        }
      }
      return new Response(head ? null : Bun.file(path), { headers });
    },
  };
}

function versionKey(info: { size: number; mtimeMs: number }): string {
  return `${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}`;
}
