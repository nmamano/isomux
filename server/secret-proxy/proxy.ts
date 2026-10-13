// The secret proxy (internal-docs/secrets-design.md, section 2.2 and
// appendix D). Agents with a secret in scope send all their HTTPS through it
// with CONNECT.
//
// - A host that no secret lists, a never-listed host, a port other than 443
//   or a name that is not a valid secret host: a plain TCP tunnel that the
//   proxy never reads.
// - A listed host on 443: the proxy ends TLS with an office-CA certificate
//   and reads each request. It swaps a placeholder for the value only in the
//   header that the secret's form names, only when the secret lists this
//   host, and never on TRACE or OPTIONS. A placeholder of a secret that does
//   not list this host gets 403. CONNECT host, SNI and Host must agree on
//   every request, or 421. The request is written again to the same host on
//   443, verified against the system roots. Redirects go back to the client.
//   Every response from the host is scrubbed of every secret value.
//
// The proxy writes no log line with a header, a value or a placeholder: its
// only output is `ProxyEvents`, and `log` takes fixed codes.

import {
  connect as netConnect,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import {
  connect as tlsConnect,
  createSecureContext,
  TLSSocket,
  type SecureContext,
} from "node:tls";
import { Readable, type Duplex } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import {
  isNeverListed,
  isValidSecretHost,
  type SecretForm,
} from "../../shared/secret-hosts.ts";
import {
  bodyFraming,
  ByteReader,
  chunk,
  hasToken,
  headerValues,
  HttpError,
  LAST_CHUNK,
  readBody,
  readHead,
  serializeHead,
  type HeaderList,
} from "./http1.ts";
import { scrubPatterns, scrubText, StreamScrubber } from "./scrub.ts";
import { createLeafIssuer, type LeafIssuer } from "./x509.ts";

export interface ProxySecret {
  // scopeId() of the secret's scope: "office" or "user:<id>".
  scope: string;
  // The member of a member secret; null for an office secret.
  ownerId: string | null;
  name: string;
  value: string;
  hosts: string[];
  form: SecretForm;
  placeholder: string;
}

export interface ProxySnapshot {
  secrets: ProxySecret[];
  caCertPem: string;
  caKeyPem: string;
  // The roots that upstream certificates are verified against.
  rootsPem: string;
  // The server's own company proxy (HTTPS_PROXY), chained for every
  // upstream connection unless `noProxy` matches the host.
  upstreamProxy: { url: string; noProxy: string } | null;
}

// Seams for tests. The production child (main.ts) passes none.
export interface ProxyOptions {
  // "host:port" -> a loopback port that stands in for that host.
  standIns?: Record<string, number>;
  // Roots that replace the snapshot's system roots for upstream checks.
  upstreamRoots?: string;
}

export interface ProxyUse {
  scope: string;
  ownerId: string | null;
  name: string;
  host: string;
  method: string;
  path: string;
}

export interface ProxyEvents {
  use(use: ProxyUse): void;
  // Fixed codes only, never request content.
  log?(code: string): void;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IDLE_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 30 * 1000;

// Headers that belong to one connection, or to the proxy hop.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);
const DECODABLE = new Set(["gzip", "x-gzip", "deflate", "br"]);

// Derived from one snapshot.
interface State {
  snapshot: ProxySnapshot;
  options: ProxyOptions;
  byPlaceholder: Map<string, ProxySecret>;
  listed: Set<string>;
  // Header names that some secret's form names, lower-case.
  namedHeaders: Set<string>;
  patterns: string[];
  issuer: LeafIssuer;
  contexts: Map<string, SecureContext>;
}

function deriveState(snapshot: ProxySnapshot, options: ProxyOptions): State {
  const byPlaceholder = new Map<string, ProxySecret>();
  const listed = new Set<string>();
  const namedHeaders = new Set<string>();
  for (const secret of snapshot.secrets) {
    byPlaceholder.set(secret.placeholder, secret);
    for (const host of secret.hosts) listed.add(host);
    namedHeaders.add(
      secret.form.kind === "authorization"
        ? "authorization"
        : secret.form.header,
    );
  }
  const isTerminable = (host: string) =>
    listed.has(host) && isValidSecretHost(host) && !isNeverListed(host);
  return {
    snapshot,
    options,
    byPlaceholder,
    listed,
    namedHeaders,
    patterns: scrubPatterns(snapshot.secrets.map((s) => s.value)),
    issuer: createLeafIssuer(
      { certPem: snapshot.caCertPem, keyPem: snapshot.caKeyPem },
      isTerminable,
    ),
    contexts: new Map(),
  };
}

// The proxy ends TLS for this host on this port.
function terminates(state: State, host: string, port: number): boolean {
  return (
    port === 443 &&
    state.listed.has(host) &&
    isValidSecretHost(host) &&
    !isNeverListed(host)
  );
}

function contextFor(state: State, host: string): SecureContext {
  let context = state.contexts.get(host);
  if (!context) {
    const leaf = state.issuer.issue(host);
    context = createSecureContext({ cert: leaf.certPem, key: leaf.keyPem });
    state.contexts.set(host, context);
  }
  return context;
}

function parseAuthority(
  authority: string,
): { host: string; port: number } | null {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^:[\]/@\s]+):([0-9]{1,5})$/.exec(
    authority,
  );
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  const host = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1];
  return { host: host.toLowerCase(), port };
}

function errorResponse(status: number, text: string): Buffer {
  const reasons: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    405: "Method Not Allowed",
    421: "Misdirected Request",
    431: "Request Header Fields Too Large",
    501: "Not Implemented",
    502: "Bad Gateway",
    505: "HTTP Version Not Supported",
  };
  const body = Buffer.from(`${text}\n`, "utf8");
  return Buffer.concat([
    serializeHead(`HTTP/1.1 ${status} ${reasons[status] ?? "Error"}`, [
      ["Content-Type", "text/plain; charset=utf-8"],
      ["Content-Length", String(body.length)],
      ["Connection", "close"],
    ]),
    body,
  ]);
}

// Writes and waits while the socket's buffer is full, so a slow reader slows
// the other side down instead of growing this process's memory. Resolves
// early when the socket closes.
function send(socket: Duplex, data: Buffer): Promise<void> {
  if (socket.write(data) || socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      socket.off("drain", done);
      socket.off("close", done);
      resolve();
    };
    socket.on("drain", done);
    socket.on("close", done);
  });
}

function once<T extends unknown[]>(fn: (...args: T) => void) {
  let done = false;
  return (...args: T) => {
    if (done) return;
    done = true;
    fn(...args);
  };
}

// --- upstream connections ---

function noProxyMatches(noProxy: string, host: string, port: number) {
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const [name, entryPort] = entry.startsWith("[")
      ? [entry.slice(1, entry.indexOf("]")), entry.split("]:")[1]]
      : entry.split(":");
    if (entryPort && Number(entryPort) !== port) continue;
    const bare = name.replace(/^\*?\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

function waitConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// A TCP connection to host:port: the test stand-in, the company proxy's
// tunnel, or a direct connection. `early` holds bytes the company proxy sent
// after its 200, which belong to the tunnel.
async function openTcp(
  state: State,
  host: string,
  port: number,
): Promise<{ socket: Socket; early: Buffer }> {
  const stand = state.options.standIns?.[`${host}:${port}`];
  if (stand !== undefined) {
    const socket = netConnect(stand, "127.0.0.1");
    await waitConnect(socket);
    return { socket, early: Buffer.alloc(0) };
  }
  const chain = state.snapshot.upstreamProxy;
  if (chain && !noProxyMatches(chain.noProxy, host, port)) {
    const url = new URL(chain.url);
    const socket = netConnect(
      Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      url.hostname.replace(/^\[|\]$/g, ""),
    );
    await waitConnect(socket);
    const authority =
      isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
    const headers: HeaderList = [["Host", authority]];
    if (url.username || url.password) {
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      headers.push([
        "Proxy-Authorization",
        `Basic ${Buffer.from(credentials).toString("base64")}`,
      ]);
    }
    socket.write(serializeHead(`CONNECT ${authority} HTTP/1.1`, headers));
    const reader = new ByteReader(socket);
    const head = await readHead(reader);
    const status = head ? Number(head.startLine.split(" ")[1]) : 0;
    if (status !== 200) {
      socket.destroy();
      throw new Error("company proxy refused the tunnel");
    }
    return { socket, early: reader.detach() };
  }
  const socket = netConnect(port, host);
  await waitConnect(socket);
  return { socket, early: Buffer.alloc(0) };
}

async function openTls(state: State, host: string): Promise<TLSSocket> {
  const { socket, early } = await openTcp(state, host, 443);
  if (early.length > 0) {
    socket.destroy();
    throw new Error("unexpected bytes before TLS");
  }
  const tls = tlsConnect({
    socket,
    servername: host,
    ca: state.options.upstreamRoots ?? state.snapshot.rootsPem,
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });
  // The company proxy's reader left the socket paused.
  socket.resume();
  await new Promise<void>((resolve, reject) => {
    tls.once("secureConnect", () => resolve());
    tls.once("error", reject);
  });
  return tls;
}

// --- requests on a terminated connection ---

type SwapResult =
  | { kind: "forward"; headers: HeaderList; used: ProxySecret[] }
  | { kind: "forbidden"; secret: ProxySecret };

function decodeBasic(token: string): { user: string; pass: string } | null {
  if (!BASE64.test(token)) return null;
  const decoded = Buffer.from(token, "base64").toString("latin1");
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

function formNames(secret: ProxySecret, header: string): boolean {
  return secret.form.kind === "authorization"
    ? header === "authorization"
    : secret.form.header === header;
}

// Swaps placeholders in the headers that their secrets' forms name.
function swapPlaceholders(
  state: State,
  host: string,
  method: string,
  headers: HeaderList,
): SwapResult {
  const inject = method !== "TRACE" && method !== "OPTIONS";
  const used: ProxySecret[] = [];
  const out: HeaderList = [];
  // Returns the replacement for `candidate`, or null to leave it, or a
  // forbidden secret.
  const resolve = (
    header: string,
    candidate: string,
  ): string | null | { forbidden: ProxySecret } => {
    const secret = state.byPlaceholder.get(candidate);
    if (!secret || !formNames(secret, header)) return null;
    if (!secret.hosts.includes(host)) return { forbidden: secret };
    if (!inject) return null;
    used.push(secret);
    return secret.value;
  };
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!state.namedHeaders.has(lower)) {
      out.push([name, value]);
      continue;
    }
    let next = value;
    const whole = resolve(lower, value);
    if (whole && typeof whole === "object")
      return { kind: "forbidden", secret: whole.forbidden };
    if (typeof whole === "string") next = whole;
    else if (lower === "authorization") {
      const match = /^([^ ]+) +(.+)$/.exec(value);
      if (match && TOKEN.test(match[1])) {
        const [, scheme, token] = match;
        if (scheme.toLowerCase() === "basic") {
          const basic = decodeBasic(token);
          if (basic) {
            const user = resolve(lower, basic.user);
            const pass = resolve(lower, basic.pass);
            for (const r of [user, pass])
              if (r && typeof r === "object")
                return { kind: "forbidden", secret: r.forbidden };
            if (typeof user === "string" || typeof pass === "string") {
              const u = typeof user === "string" ? user : basic.user;
              const p = typeof pass === "string" ? pass : basic.pass;
              next = `${scheme} ${Buffer.from(`${u}:${p}`, "latin1").toString("base64")}`;
            }
          }
        } else {
          const r = resolve(lower, token);
          if (r && typeof r === "object")
            return { kind: "forbidden", secret: r.forbidden };
          if (typeof r === "string") next = `${scheme} ${r}`;
        }
      }
    }
    out.push([name, next]);
  }
  return { kind: "forward", headers: out, used };
}

// Accept-Encoding for the upstream: identity when a value was sent (so a
// reflection is not hidden in a compressed body), else only the codings the
// scrub can decode.
function acceptEncoding(value: string | undefined, swapped: boolean) {
  if (swapped) return "identity";
  if (value === undefined) return undefined;
  const kept = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => {
      const coding = part.split(";")[0].trim().toLowerCase();
      return DECODABLE.has(coding) || coding === "identity";
    });
  return kept.length > 0 ? kept.join(", ") : "identity";
}

function requestTarget(
  target: string,
  method: string,
  host: string,
): { path: string } | "mismatch" | "invalid" {
  if (target.startsWith("/")) return { path: target };
  if (target === "*" && method === "OPTIONS") return { path: "*" };
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:") return "mismatch";
  if (url.hostname.toLowerCase() !== host) return "mismatch";
  if (url.port && url.port !== "443") return "mismatch";
  if (url.username || url.password) return "invalid";
  return { path: `${url.pathname}${url.search}` };
}

// The Host field names the CONNECT host: same name, case aside, with no port
// or port 443. A trailing dot is a different name.
function hostMatches(value: string, host: string): boolean {
  const lower = value.toLowerCase();
  return lower === host || lower === `${host}:443`;
}

async function* decoded(
  body: AsyncGenerator<Buffer>,
  coding: string | null,
): AsyncGenerator<Buffer> {
  if (!coding) {
    yield* body;
    return;
  }
  const decoder =
    coding === "br"
      ? createBrotliDecompress()
      : coding === "deflate"
        ? createInflate()
        : createGunzip();
  const source = Readable.from(body);
  source.on("error", (error) => decoder.destroy(error));
  source.pipe(decoder);
  for await (const piece of decoder) yield piece as Buffer;
}

interface Upstream {
  socket: TLSSocket;
  reader: ByteReader;
}

async function serveTerminated(
  getState: () => State,
  events: ProxyEvents,
  client: TLSSocket,
  host: string,
  misdirected: () => boolean,
): Promise<void> {
  const reader = new ByteReader(client);
  let upstream: Upstream | null = null;
  const closeUpstream = () => {
    upstream?.socket.destroy();
    upstream = null;
  };
  const fail = (status: number, text: string) => {
    events.log?.(`request_refused_${status}`);
    client.end(errorResponse(status, text));
    closeUpstream();
  };
  client.setTimeout(IDLE_MS, () => client.destroy());
  // A client that goes away takes its upstream connection with it, also in
  // the middle of a stalled upload or download.
  client.on("close", () => closeUpstream());
  // Set once response bytes went to the client: an error after that can
  // only close the connection.
  let responding = false;

  try {
    for (;;) {
      const head = await readHead(reader);
      if (!head) break;
      const state = getState();
      const start = /^([^ ]+) ([^ ]+) (HTTP\/[0-9.]+)$/.exec(head.startLine);
      if (!start || !TOKEN.test(start[1]))
        return fail(400, "invalid request line");
      const [, method, target, version] = start;
      if (version !== "HTTP/1.1")
        return fail(505, "the secret proxy speaks HTTP/1.1 only");
      if (misdirected())
        return fail(421, "the TLS server name does not match the CONNECT host");
      const hosts = headerValues(head.headers, "host");
      if (hosts.length !== 1)
        return fail(400, "a request needs one Host field");
      if (!hostMatches(hosts[0], host))
        return fail(421, "the Host field does not match the CONNECT host");
      if (method === "CONNECT")
        return fail(501, "CONNECT inside a tunnel is not supported");
      const where = requestTarget(target, method, host);
      if (where === "invalid") return fail(400, "invalid request target");
      if (where === "mismatch")
        return fail(421, "the request target does not match the CONNECT host");
      if (
        headerValues(head.headers, "upgrade").length > 0 ||
        hasToken(head.headers, "connection", "upgrade")
      )
        return fail(501, "protocol upgrades are not supported for this host");
      for (const name of state.namedHeaders)
        if (headerValues(head.headers, name).length > 1)
          return fail(400, `more than one ${name} field`);
      const framing = bodyFraming(head.headers, { strict: true });

      const swap = swapPlaceholders(state, host, method, head.headers);
      if (swap.kind === "forbidden")
        return fail(
          403,
          `the secret ${swap.secret.name} may not be sent to ${host}`,
        );

      // The forwarded head: the client's fields in their order, without the
      // hop-by-hop ones, Host from the CONNECT host, and our own framing.
      const dropped = new Set(HOP_BY_HOP);
      for (const value of headerValues(head.headers, "connection"))
        for (const token of value.split(","))
          dropped.add(token.trim().toLowerCase());
      const forwarded: HeaderList = [];
      const swapped = swap.used.length > 0;
      const encoding = acceptEncoding(
        headerValues(head.headers, "accept-encoding")[0],
        swapped,
      );
      let encodingPlaced = false;
      for (const [name, value] of swap.headers) {
        const lower = name.toLowerCase();
        if (lower === "host") forwarded.push([name, host]);
        else if (lower === "accept-encoding") {
          if (!encodingPlaced && encoding !== undefined)
            forwarded.push([name, encoding]);
          encodingPlaced = true;
        } else if (!dropped.has(lower)) forwarded.push([name, value]);
      }
      if (!encodingPlaced && swapped)
        forwarded.push(["Accept-Encoding", "identity"]);
      if (framing.kind === "length")
        forwarded.push(["Content-Length", String(framing.length)]);
      if (framing.kind === "chunked")
        forwarded.push(["Transfer-Encoding", "chunked"]);
      const clientCloses = hasToken(head.headers, "connection", "close");

      if (!upstream || upstream.reader.isEnded) {
        closeUpstream();
        try {
          const socket = await openTls(state, host);
          socket.setTimeout(IDLE_MS, () => socket.destroy());
          upstream = { socket, reader: new ByteReader(socket) };
        } catch {
          return fail(502, `could not reach ${host}`);
        }
      }
      const up: Upstream = upstream;
      up.socket.write(
        serializeHead(`${method} ${where.path} HTTP/1.1`, forwarded),
      );
      for (const secret of swap.used)
        events.use({
          scope: secret.scope,
          ownerId: secret.ownerId,
          name: secret.name,
          host,
          method,
          path: where.path.split("?")[0],
        });

      // The request body and the response run together, so a 100 Continue
      // reaches the client while it waits to send its body.
      const sendBody = (async () => {
        for await (const piece of readBody(reader, framing))
          await send(
            up.socket,
            framing.kind === "chunked" ? chunk(piece) : piece,
          );
        if (framing.kind === "chunked") await send(up.socket, LAST_CHUNK);
      })();
      sendBody.catch(() => {});

      const patterns = state.patterns;
      let response = await readHead(up.reader);
      for (;;) {
        if (!response) throw new Error("upstream closed");
        const code = Number(response.startLine.split(" ")[1]);
        if (!(code >= 100 && code < 200)) break;
        if (code === 101) throw new Error("upstream switched protocols");
        responding = true;
        client.write(
          serializeHead(
            scrubText(response.startLine, patterns),
            response.headers.map(([n, v]) => [n, scrubText(v, patterns)]),
          ),
        );
        response = await readHead(up.reader);
      }
      const status = Number(response.startLine.split(" ")[1]);
      if (!Number.isInteger(status)) throw new Error("bad status line");
      const noBody = method === "HEAD" || status === 204 || status === 304;
      const responseFraming = bodyFraming(response.headers, {
        strict: false,
        noBody,
      });
      const codings = headerValues(response.headers, "content-encoding")
        .join(",")
        .split(",")
        .map((c) => c.trim().toLowerCase())
        .filter((c) => c && c !== "identity");
      if (
        !noBody &&
        (codings.length > 1 ||
          (codings.length === 1 && !DECODABLE.has(codings[0])))
      ) {
        await sendBody.catch(() => {});
        return fail(
          502,
          "the response uses a content coding the secret proxy cannot scrub",
        );
      }
      const coding = noBody ? null : (codings[0] ?? null);
      const upstreamCloses =
        responseFraming.kind === "close" ||
        hasToken(response.headers, "connection", "close");
      const closeAfter = upstreamCloses || clientCloses;

      const outHeaders: HeaderList = [];
      for (const [name, value] of response.headers) {
        const lower = name.toLowerCase();
        if (lower === "content-length" && noBody) {
          outHeaders.push([name, value]);
          continue;
        }
        if (HOP_BY_HOP.has(lower)) continue;
        if (lower === "content-encoding" && coding) continue;
        outHeaders.push([name, scrubText(value, patterns)]);
      }
      if (!noBody) outHeaders.push(["Transfer-Encoding", "chunked"]);
      if (closeAfter) outHeaders.push(["Connection", "close"]);
      responding = true;
      client.write(
        serializeHead(scrubText(response.startLine, patterns), outHeaders),
      );
      if (!noBody) {
        const scrubber = new StreamScrubber(patterns);
        for await (const piece of decoded(
          readBody(up.reader, responseFraming),
          coding,
        )) {
          const clean = scrubber.push(piece);
          if (clean.length) await send(client, chunk(clean));
          if (client.destroyed) throw new Error("client closed");
        }
        const rest = scrubber.end();
        if (rest.length) await send(client, chunk(rest));
        await send(client, LAST_CHUNK);
      }
      await sendBody.catch(() => {});
      responding = false;
      if (upstreamCloses) closeUpstream();
      if (closeAfter) {
        client.end();
        return;
      }
    }
    client.end();
  } catch (error) {
    if (error instanceof HttpError && !responding) {
      fail(error.status, error.reason);
      return;
    }
    events.log?.("terminated_connection_failed");
    client.destroy();
  } finally {
    closeUpstream();
  }
}

// --- the listener ---

export interface SecretProxy {
  update(snapshot: ProxySnapshot): void;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

export function createSecretProxy(
  initial: ProxySnapshot,
  events: ProxyEvents,
  options: ProxyOptions = {},
): SecretProxy {
  let state = deriveState(initial, options);
  const sockets = new Set<Socket>();

  async function handle(socket: Socket) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const reader = new ByteReader(socket);
    const refuse = (status: number, text: string) => {
      events.log?.(`connect_refused_${status}`);
      socket.end(errorResponse(status, text));
    };
    let head;
    try {
      head = await readHead(reader);
    } catch (error) {
      if (error instanceof HttpError) refuse(error.status, error.reason);
      else socket.destroy();
      return;
    }
    if (!head) return void socket.end();
    const start = /^([^ ]+) ([^ ]+) HTTP\/1\.[01]$/.exec(head.startLine);
    if (!start) return refuse(400, "invalid request line");
    if (start[1] !== "CONNECT")
      return refuse(405, "the secret proxy accepts only CONNECT");
    const authority = parseAuthority(start[2]);
    if (!authority) return refuse(400, "invalid CONNECT target");
    const { host, port } = authority;
    const current = state;

    if (!terminates(current, host, port)) {
      let upstream: { socket: Socket; early: Buffer };
      try {
        upstream = await openTcp(current, host, port);
      } catch {
        return refuse(502, `could not reach ${host}`);
      }
      const early = reader.detach();
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (upstream.early.length) socket.write(upstream.early);
      if (early.length) upstream.socket.write(early);
      const end = once(() => {
        socket.destroy();
        upstream.socket.destroy();
      });
      upstream.socket.on("error", end);
      upstream.socket.on("close", end);
      socket.on("close", end);
      socket.pipe(upstream.socket);
      upstream.socket.pipe(socket);
      socket.resume();
      upstream.socket.resume();
      return;
    }

    // A client sends TLS only after the 200. Bytes before it would have to be
    // put back under the TLS layer; refuse them instead.
    const early = reader.detach();
    if (early.length > 0)
      return refuse(400, "data was sent before the tunnel was open");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let misdirected = true;
    let context: SecureContext;
    try {
      context = contextFor(current, host);
    } catch {
      events.log?.("leaf_refused");
      return void socket.destroy();
    }
    const tls = new TLSSocket(socket, {
      isServer: true,
      secureContext: context,
      ALPNProtocols: ["http/1.1"],
      SNICallback: (
        name: string,
        done: (e: Error | null, c?: SecureContext) => void,
      ) => {
        const lower = name.toLowerCase();
        if (lower === host) {
          misdirected = false;
          return done(null, context);
        }
        try {
          // Another listed name: finish the handshake so that every
          // request can get a 421. Any other name: no certificate.
          done(null, contextFor(state, lower));
        } catch {
          events.log?.("leaf_refused");
          done(new Error("no certificate for this name"));
        }
      },
    });
    tls.on("error", () => tls.destroy());
    tls.once("secure", () => {
      void serveTerminated(
        () => state,
        events,
        tls,
        host,
        () => misdirected,
      );
    });
  }

  let server: Server | null = null;
  return {
    update(snapshot) {
      state = deriveState(snapshot, options);
    },
    listen(port) {
      return new Promise((resolve, reject) => {
        server = createServer((socket) => void handle(socket));
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const address = server!.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        if (!server) return resolve();
        server.close(() => resolve());
      });
    },
  };
}
