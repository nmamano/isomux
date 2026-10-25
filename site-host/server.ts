// Self-hosted isomux.com: serves site/ with the routing in vercel.json, the
// routing middleware (middleware.ts) and the functions in api/, so the site
// behaves as on Vercel and a rollback to Vercel stays exact.
//
// Vercel's order, as recorded from live isomux.com in parity.json:
// cleanUrls redirects, vercel.json redirects, the middleware, the files of the
// output directory, the api/ functions, then the rewrites. The headers of
// vercel.json go on every response except a redirect; a rule matches the
// ORIGINAL request path, never the path a rewrite produced (that is how
// /.well-known/api-catalog gets its own Content-Type while the file served is
// /api-catalog.json).
import { createHash } from "node:crypto";
import { chmod, readdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { match, type MatchFunction } from "path-to-regexp-6";

/** The parsed vercel.json and the directory that holds it, api/ and middleware.ts. */
export type SiteOptions = { root: string; vercelJson: unknown };

export type SiteHandler = (request: Request) => Promise<Response>;

// Pages and files: the browser revalidates every time, a shared cache (the
// Cloudflare edge) keeps a copy 5 minutes. A deploy purges the edge.
const CACHED = "public, max-age=0, s-maxage=300, must-revalidate";
// Markdown and the 406 share their URL with the HTML page. Cloudflare does not
// key its cache on Accept, so these must never enter a shared cache; nor must
// the chat, a 405 or a 500.
const NEVER = "no-store";
// Vercel's own HSTS on the responses that vercel.json headers do not reach.
const PLATFORM_HSTS = "max-age=63072000";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/vnd.microsoft.icon",
  ".mp4": "video/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
};

type Params = Record<string, string | string[]>;
type Redirect = {
  source: MatchFunction<Params>;
  destination: string;
  status: 307 | 308;
  host?: string;
};
type HeaderRule = {
  source: MatchFunction<Params>;
  headers: [string, string][];
};
type Rewrite = { source: MatchFunction<Params>; destination: string };
type Config = {
  output: string;
  cleanUrls: boolean;
  redirects: Redirect[];
  headers: HeaderRule[];
  rewrites: Rewrite[];
};
type Middleware = {
  run: (request: Request) => Response | Promise<Response>;
  matchers: MatchFunction<Params>[];
};
type Handler = (request: Request) => Response | Promise<Response>;

function refuse(what: string): never {
  throw new Error(
    `vercel.json: ${what} is not supported by site-host/server.ts`,
  );
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    refuse(`${what} that is not an object`);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) refuse(`the key "${key}" in ${what}`);
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") refuse(`${what} that is not a string`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuse(`${what} that is not a list`);
  return value;
}

// Vercel matches vercel.json sources with path-to-regexp 6, strict and case
// sensitive: "/demo" does not match "/demo/" (recorded in parity.json). The
// middleware matcher follows Next.js instead and allows a trailing slash.
// Raw segments are kept as they came, so a destination gets them still
// percent-encoded.
function pattern(
  source: unknown,
  what: string,
  strict = true,
): MatchFunction<Params> {
  const path = text(source, `${what} source`);
  if (!path.startsWith("/")) refuse(`${what} source "${path}"`);
  try {
    return match<Params>(path, {
      decode: (segment) => segment,
      strict,
      sensitive: strict,
    });
  } catch {
    refuse(`${what} source "${path}"`);
  }
}

// A destination may name the source's parameters (":name", ":name*") and
// nothing else: any other ":" form is refused at boot.
function destination(value: unknown, source: string, what: string): string {
  const target = text(value, `${what} destination`);
  const names = new Set(
    [...source.matchAll(/:(\w+)/g)].map(([, name]) => name),
  );
  const path = target.replace(/^https:\/\/[^/]+/, "");
  if (!path.startsWith("/")) refuse(`${what} destination "${target}"`);
  for (const [token, name] of path.matchAll(/:(\w+)?[*+?]?/g))
    if (!name || !names.has(name))
      refuse(`${what} destination "${target}" (${token})`);
  return target;
}

function parse(vercelJson: unknown): Config {
  const config = record(vercelJson, "vercel.json");
  keys(
    config,
    [
      "$schema",
      "buildCommand",
      "outputDirectory",
      "cleanUrls",
      "redirects",
      "headers",
      "rewrites",
    ],
    "vercel.json",
  );
  const output = text(config.outputDirectory, "outputDirectory");
  if (config.cleanUrls !== undefined && typeof config.cleanUrls !== "boolean")
    refuse("cleanUrls that is not true or false");
  const redirects = list(config.redirects, "redirects").map((entry) => {
    const redirect = record(entry, "a redirect");
    keys(redirect, ["source", "destination", "permanent", "has"], "a redirect");
    if (typeof redirect.permanent !== "boolean")
      refuse("a redirect without permanent: true or false");
    const has = list(redirect.has, "has");
    if (has.length > 1) refuse("a redirect with more than one has condition");
    let host: string | undefined;
    if (has.length === 1) {
      const condition = record(has[0], "a has condition");
      if (condition.type !== "host")
        refuse(`has type "${String(condition.type)}"`);
      keys(condition, ["type", "value"], "a has condition");
      host = text(condition.value, "a has host value");
    }
    const source = text(redirect.source, "redirect source");
    return {
      source: pattern(source, "redirect"),
      destination: destination(redirect.destination, source, "redirect"),
      status: redirect.permanent ? 308 : 307,
      host,
    } satisfies Redirect;
  });
  const headers = list(config.headers, "headers").map((entry) => {
    const rule = record(entry, "a headers rule");
    keys(rule, ["source", "headers"], "a headers rule");
    return {
      source: pattern(rule.source, "headers"),
      headers: list(rule.headers, "headers").map((header) => {
        const pair = record(header, "a header");
        keys(pair, ["key", "value"], "a header");
        return [text(pair.key, "header key"), text(pair.value, "header value")];
      }),
    } satisfies HeaderRule;
  });
  const rewrites = list(config.rewrites, "rewrites").map((entry) => {
    const rewrite = record(entry, "a rewrite");
    keys(rewrite, ["source", "destination"], "a rewrite");
    const source = text(rewrite.source, "rewrite source");
    const target = destination(rewrite.destination, source, "rewrite");
    if (target.startsWith("https://")) refuse(`rewrite to "${target}"`);
    return { source: pattern(source, "rewrite"), destination: target };
  });
  return {
    output,
    cleanUrls: config.cleanUrls === true,
    redirects,
    headers,
    rewrites,
  };
}

/** Puts the matched parameters into a destination; a repeated one joins with "/". */
function fill(target: string, params: Params): string {
  return target.replace(/:(\w+)[*+?]?/g, (_, name: string) => {
    const value = params[name];
    return Array.isArray(value) ? value.join("/") : (value ?? "");
  });
}

/** Adds the request's query to a destination, before its fragment. */
function withQuery(target: string, search: string): string {
  if (!search) return target;
  const hash = target.indexOf("#");
  const [base, fragment] =
    hash < 0 ? [target, ""] : [target.slice(0, hash), target.slice(hash)];
  const joined = base.includes("?")
    ? `${base}&${search.slice(1)}`
    : `${base}${search}`;
  return joined + fragment;
}

function redirect(location: string, status: number, method: string): Response {
  return new Response(method === "HEAD" ? null : "Redirecting...", {
    status,
    headers: {
      "Content-Type": "text/plain",
      Location: location,
      "Strict-Transport-Security": PLATFORM_HSTS,
      "Cache-Control": CACHED,
    },
  });
}

/**
 * For a path that names an .html file or an index: the file it names and its
 * cleanUrls form, with one leading slash (so that "//host/x.html" can never
 * become a redirect to another host). Else null.
 */
function cleanPath(pathname: string): { file: string; clean: string } | null {
  const stripped = pathname.replace(/\.html$/, "");
  if (stripped === pathname && !/\/index$/.test(pathname)) return null;
  const clean = stripped.replace(/\/index$/, "").replace(/^\/+/, "/") || "/";
  return { file: `${stripped}.html`, clean };
}

/** The decoded path, or null when it cannot name a file safely. */
function safePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded.split("/").some((segment) => segment === "..")) return null;
  return decoded;
}

/**
 * The first and last byte of a single "bytes=" range, null to send the whole
 * file (no Range header, several ranges, or a form this server does not
 * read), or "unsatisfiable" when the range starts past the end.
 */
function byteRange(
  header: string | null,
  size: number,
): [number, number] | null | "unsatisfiable" {
  const found = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!found || (found[1] === "" && found[2] === "")) return null;
  if (found[1] === "") {
    const length = Number(found[2]);
    if (length === 0 || size === 0) return "unsatisfiable";
    return [Math.max(0, size - length), size - 1];
  }
  const start = Number(found[1]);
  if (start >= size) return "unsatisfiable";
  const last = found[2] === "" ? size - 1 : Number(found[2]);
  // RFC 9110: an invalid range is ignored, so the whole file goes out.
  if (last < start) return null;
  return [start, Math.min(last, size - 1)];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function loadMiddleware(root: string): Promise<Middleware | undefined> {
  const path = join(root, "middleware.ts");
  if (!(await isFile(path))) return undefined;
  const module = (await import(path)) as {
    default: Middleware["run"];
    config?: { matcher?: string[] };
  };
  const matchers = (module.config?.matcher ?? ["/:path*"]).map((source) =>
    pattern(source, "middleware matcher", false),
  );
  return { run: module.default, matchers };
}

// Each api/<name>.ts is the function at /api/<name>. Files that start with "_"
// are helpers and tests, as on Vercel.
async function loadFunctions(root: string): Promise<Map<string, Handler>> {
  const functions = new Map<string, Handler>();
  for (const file of await readdir(join(root, "api"))) {
    if (file.startsWith("_") || !file.endsWith(".ts")) continue;
    const module = (await import(join(root, "api", file))) as {
      default: Handler;
    };
    functions.set(file.slice(0, -3), module.default);
  }
  return functions;
}

/**
 * Builds the request handler. Rejects when vercel.json uses a key, a `has`
 * type or a pattern form this server does not implement.
 */
export async function createSiteHandler(
  options: SiteOptions,
): Promise<SiteHandler> {
  const config = parse(options.vercelJson);
  const root = resolve(options.root);
  const output = resolve(root, config.output);
  const middleware = await loadMiddleware(root);
  const functions = await loadFunctions(root);
  const etags = new Map<string, { mtime: number; etag: string }>();

  /** The path inside the output directory that a request path names, if safe. */
  function insideOutput(pathname: string): string | null {
    const path = safePath(pathname);
    if (path === null) return null;
    const target = resolve(output, `.${path}`);
    if (target !== output && !target.startsWith(output + sep)) return null;
    return target;
  }

  async function outputFile(pathname: string): Promise<string | null> {
    const target = insideOutput(pathname);
    return target !== null && (await isFile(target)) ? target : null;
  }

  async function findFile(pathname: string): Promise<string | null> {
    const path = safePath(pathname);
    const target = insideOutput(pathname);
    if (path === null || target === null) return null;
    const candidates = path.endsWith("/")
      ? [join(target, "index.html")]
      : [target, `${target}.html`, join(target, "index.html")];
    if (config.cleanUrls && path.endsWith("/") && path !== "/")
      candidates.unshift(`${target.replace(/\/+$/, "")}.html`);
    for (const candidate of candidates)
      if (await isFile(candidate)) return candidate;
    return null;
  }

  async function serveFile(request: Request, path: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405 });
    const info = await stat(path);
    const body = await readFile(path);
    let cached = etags.get(path);
    if (!cached || cached.mtime !== info.mtimeMs) {
      cached = {
        mtime: info.mtimeMs,
        etag: `"${createHash("sha1").update(body).digest("hex")}"`,
      };
      etags.set(path, cached);
    }
    const headers = new Headers({
      "Content-Type":
        CONTENT_TYPES[extname(path).toLowerCase()] ??
        "application/octet-stream",
      ETag: cached.etag,
      "Accept-Ranges": "bytes",
    });
    if (request.headers.get("if-none-match") === cached.etag)
      return new Response(null, { status: 304, headers });
    // A video player (Safari's in particular) asks for byte ranges.
    const range = byteRange(request.headers.get("range"), body.length);
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${body.length}`);
      return new Response(null, { status: 416, headers });
    }
    const [start, end] = range ?? [0, body.length - 1];
    const part = range ? body.subarray(start, end + 1) : body;
    if (range)
      headers.set("Content-Range", `bytes ${start}-${end}/${body.length}`);
    headers.set("Content-Length", String(part.length));
    return new Response(request.method === "HEAD" ? null : part, {
      status: range ? 206 : 200,
      headers,
    });
  }

  /** A file of the output directory, then an api/ function, else null. */
  async function serve(request: Request, url: URL): Promise<Response | null> {
    const name = /^\/api\/([^/]+)$/.exec(url.pathname)?.[1];
    if (name !== undefined) {
      const run = functions.get(name);
      return run ? run(new Request(url, request)) : null;
    }
    const file = await findFile(url.pathname);
    return file ? serveFile(request, file) : null;
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Bun builds the URL from the Host header.
    const host = url.hostname;

    // Vercel builds these redirects from the files of the output directory,
    // so only an existing file redirects.
    const named = config.cleanUrls ? cleanPath(url.pathname) : null;
    if (named !== null && (await outputFile(named.file)) !== null)
      return redirect(withQuery(named.clean, url.search), 308, request.method);
    for (const rule of config.redirects) {
      if (rule.host !== undefined && rule.host !== host) continue;
      const found = rule.source(url.pathname);
      if (!found) continue;
      const location = withQuery(
        fill(rule.destination, found.params),
        url.search,
      );
      return redirect(location, rule.status, request.method);
    }

    const response = await respond(request, url);
    const headers = new Headers(response.headers);
    for (const rule of config.headers)
      if (rule.source(url.pathname))
        for (const [key, value] of rule.headers) headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /** The middleware, then a file or a function, then the rewrites. */
  async function respond(request: Request, url: URL): Promise<Response> {
    let target = url;
    let middlewareHeaders = new Headers();
    if (middleware?.matchers.some((matcher) => matcher(url.pathname))) {
      const result = await middleware.run(request);
      const rewrite = result.headers.get("x-middleware-rewrite");
      if (rewrite === null && result.headers.get("x-middleware-next") === null)
        return result;
      middlewareHeaders = new Headers(result.headers);
      middlewareHeaders.delete("x-middleware-rewrite");
      middlewareHeaders.delete("x-middleware-next");
      if (rewrite !== null) target = new URL(rewrite, url);
    }

    let response = await serve(request, target);
    if (response === null)
      for (const rule of config.rewrites) {
        const found = rule.source(target.pathname);
        if (!found) continue;
        const rewritten = new URL(fill(rule.destination, found.params), url);
        for (const [key, value] of target.searchParams)
          if (!rewritten.searchParams.has(key))
            rewritten.searchParams.append(key, value);
        response = await serve(request, rewritten);
        if (response !== null) break;
      }
    response ??= new Response("Not found.\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    const headers = new Headers(response.headers);
    for (const [key, value] of middlewareHeaders) headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return async (request) => {
    let response: Response;
    try {
      response = await route(request);
    } catch {
      response = new Response("The site could not serve this request.\n", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    response.headers.set("Cache-Control", cacheControl(request, response));
    return response;
  };
}

// Every response names its caching. A function keeps its own value (the
// not-found page) unless the body is Markdown or the function is the chat.
function cacheControl(request: Request, response: Response): string {
  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith("text/markdown")) return NEVER;
  if (new URL(request.url).pathname === "/api/chat") return NEVER;
  if ([206, 405, 406, 416].includes(response.status) || response.status >= 500)
    return NEVER;
  return response.headers.get("cache-control") ?? CACHED;
}

/** Serves the handler on a TCP port or a Unix socket. */
export function serveSite(
  handler: SiteHandler,
  listen: { port: number; hostname: string } | { unix: string },
): ReturnType<typeof Bun.serve> {
  return Bun.serve({ ...listen, fetch: handler });
}

// The container runs `bun site-host/server.ts [--socket <path>]`: TCP on
// 127.0.0.1:3000 for its health check, and the Unix socket that Caddy uses.
// One handler serves both, so the chat limit is one per process.
if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const handler = await createSiteHandler({
    root,
    vercelJson: JSON.parse(await readFile(join(root, "vercel.json"), "utf8")),
  });
  const servers = [serveSite(handler, { port: 3000, hostname: "127.0.0.1" })];
  const flag = process.argv.indexOf("--socket");
  if (flag > 0) {
    const socket = process.argv[flag + 1];
    await rm(socket, { force: true });
    servers.push(serveSite(handler, { unix: socket }));
    // Caddy runs as another user; the socket serves only the public site.
    await chmod(socket, 0o666);
  }
  console.log(`isomux.com site host: ${servers.map((s) => s.url).join(", ")}`);
  const stop = () => {
    void Promise.all(servers.map((server) => server.stop())).then(() =>
      process.exit(0),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
