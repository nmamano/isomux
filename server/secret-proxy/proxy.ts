// The secret proxy (internal-docs/secrets-design.md, section 2.2 and
// appendix D). Agents with a secret in scope send all their HTTPS through it
// with CONNECT.
//
// - A host that no secret lists, a never-listed host, a port other than 443
//   or a name that is not a valid secret host: a plain TCP tunnel that the
//   proxy never reads.
// - A listed host on 443: the proxy ends TLS with an office-CA certificate
//   and reads each request. It swaps a placeholder for the value only in the
//   header that the secret's form names (or, for a token exchange's query
//   form, in one named query parameter), only when the secret lists this
//   host, and never on TRACE or OPTIONS. A secret with a token exchange
//   sends a token that the proxy gets for it (exchange.ts). A placeholder of a secret that does
//   not list this host gets 403. CONNECT host, SNI and Host must agree on
//   every request, or 421. The request is written again to the same host on
//   443, verified against the system roots. Redirects go back to the client.
//   Every response from the host is scrubbed of every secret value.
// - A client without the proxy password: 407, unless it runs as the office's
//   own OS user (Linux only). Then it gets what a client with the password
//   gets, except that a listed host is a plain tunnel for a browser and a 407
//   for any other client.
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
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable, type Duplex } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import {
  isNeverListed,
  isValidSecretHost,
  type ExchangeSpec,
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
import { peerUid } from "./peer-uid.ts";
import { scrubPatterns, scrubText, StreamScrubber } from "./scrub.ts";
import { createLeafIssuer, type LeafIssuer } from "./x509.ts";
import {
  createTokenCache,
  ExchangeError,
  EXCHANGE_REPLY_CAP,
  EXCHANGE_TIMEOUT_MS,
  exchangeFailureText,
  type ExchangeRequest,
  type TokenCache,
} from "./exchange.ts";

export interface ProxySecret {
  // scopeId() of the secret's scope: "office" or "user:<id>".
  scope: string;
  // The member of a member secret; null for an office secret.
  ownerId: string | null;
  name: string;
  value: string;
  hosts: string[];
  form: SecretForm;
  // The token exchange (exchange.ts): `value` is the client or app secret,
  // and the proxy sends the token it gets for it.
  exchange?: ExchangeSpec;
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
  // The password a client must send in Proxy-Authorization (Basic) on every
  // CONNECT (placeholders.ts, proxyClientToken).
  clientToken: string;
}

// Seams for tests. The production child (main.ts) passes none.
export interface ProxyOptions {
  // "host:port" -> a loopback port that stands in for that host.
  standIns?: Record<string, number>;
  // Roots that replace the snapshot's system roots for upstream checks.
  upstreamRoots?: string;
  // The OS user of a client (peer-uid.ts, peerUid).
  peerUid?: (socket: Socket) => Promise<number | null>;
  // The clock of the token cache (exchange.ts): lifetimes, refresh margin,
  // failure backoff and the 401 rule.
  now?: () => number;
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
  // Query parameter names that some secret's query form names, as typed.
  namedParams: Set<string>;
  patterns: string[];
  issuer: LeafIssuer;
  contexts: Map<string, SecureContext>;
}

function deriveState(snapshot: ProxySnapshot, options: ProxyOptions): State {
  const byPlaceholder = new Map<string, ProxySecret>();
  const listed = new Set<string>();
  const namedHeaders = new Set<string>();
  const namedParams = new Set<string>();
  for (const secret of snapshot.secrets) {
    byPlaceholder.set(secret.placeholder, secret);
    for (const host of secret.hosts) listed.add(host);
    if (secret.form.kind === "authorization") namedHeaders.add("authorization");
    else if (secret.form.kind === "header")
      namedHeaders.add(secret.form.header);
    // A query form without an exchange never reaches the proxy (the store
    // refuses it); it is skipped here too, so a raw value never goes in a
    // web address.
    else if (secret.exchange) namedParams.add(secret.form.param);
  }
  const isTerminable = (host: string) =>
    listed.has(host) && isValidSecretHost(host) && !isNeverListed(host);
  return {
    snapshot,
    options,
    byPlaceholder,
    listed,
    namedHeaders,
    namedParams,
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

function errorResponse(
  status: number,
  text: string,
  extra: HeaderList = [],
): Buffer {
  const reasons: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    405: "Method Not Allowed",
    407: "Proxy Authentication Required",
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
      ...extra,
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
  | {
      kind: "forward";
      headers: HeaderList;
      // The request target's path and query, with a query swap done.
      path: string;
      used: ProxySecret[];
    }
  | { kind: "forbidden"; secret: ProxySecret }
  // A request the proxy refuses with 400 and this text. The text names a
  // secret or a parameter name, never the target.
  | { kind: "refused"; text: string };

function decodeBasic(token: string): { user: string; pass: string } | null {
  if (!BASE64.test(token)) return null;
  const decoded = Buffer.from(token, "base64").toString("latin1");
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

function formNames(secret: ProxySecret, header: string): boolean {
  if (secret.form.kind === "authorization") return header === "authorization";
  return secret.form.kind === "header" && secret.form.header === header;
}

// The value that replaces a placeholder: the stored value, or for a secret
// with a token exchange its token.
type ValueOf = (secret: ProxySecret) => string;

// Swaps placeholders in the headers that their secrets' forms name, and in
// the query parameter a query form names.
function swapPlaceholders(
  state: State,
  host: string,
  method: string,
  headers: HeaderList,
  path: string,
  valueOf: ValueOf,
): SwapResult {
  const inject = method !== "TRACE" && method !== "OPTIONS";
  const used: ProxySecret[] = [];
  const out: HeaderList = [];
  // Returns the replacement for `candidate`, or null to leave it, or a
  // forbidden secret. Inside Basic only a secret without an exchange is
  // swapped: a token is a bearer credential, never a user or password.
  const resolve = (
    header: string,
    candidate: string,
    inBasic = false,
  ): string | null | { forbidden: ProxySecret } => {
    const secret = state.byPlaceholder.get(candidate);
    if (!secret || !formNames(secret, header)) return null;
    if (inBasic && secret.exchange) return null;
    if (!secret.hosts.includes(host)) return { forbidden: secret };
    if (!inject) return null;
    used.push(secret);
    return valueOf(secret);
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
            const user = resolve(lower, basic.user, true);
            const pass = resolve(lower, basic.pass, true);
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
  const query = swapQuery(state, host, inject, path, valueOf);
  if (query.kind !== "forward") return query;
  used.push(...query.used);
  return { kind: "forward", headers: out, path: query.path, used };
}

function percentDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

// The query swap: a pair whose raw name is a query form's parameter and
// whose raw value is the placeholder of a query-form secret with that
// parameter. Nothing is decoded for the swap. A pair that matches only after
// percent-decoding, or another pair of the same decoded name next to a
// swapped one, is refused: the agent learns why, and the service never
// chooses between two values.
function swapQuery(
  state: State,
  host: string,
  inject: boolean,
  path: string,
  valueOf: ValueOf,
):
  | { kind: "forward"; path: string; used: ProxySecret[] }
  | { kind: "forbidden"; secret: ProxySecret }
  | { kind: "refused"; text: string } {
  const unchanged = { kind: "forward" as const, path, used: [] };
  if (state.namedParams.size === 0) return unchanged;
  const mark = path.indexOf("?");
  if (mark === -1) return unchanged;
  const pairs = path
    .slice(mark + 1)
    .split("&")
    .map((part) => {
      const equals = part.indexOf("=");
      const name = equals === -1 ? part : part.slice(0, equals);
      const value = equals === -1 ? null : part.slice(equals + 1);
      return {
        name,
        value,
        decodedName: percentDecode(name),
        decodedValue: value === null ? null : percentDecode(value),
      };
    });
  const querySecret = (param: string | null, placeholder: string | null) => {
    if (param === null || placeholder === null) return null;
    if (!state.namedParams.has(param)) return null;
    const secret = state.byPlaceholder.get(placeholder);
    return secret?.exchange &&
      secret.form.kind === "query" &&
      secret.form.param === param
      ? secret
      : null;
  };
  const swaps: { index: number; secret: ProxySecret }[] = [];
  for (const [index, pair] of pairs.entries()) {
    const raw = querySecret(pair.name, pair.value);
    if (raw) {
      swaps.push({ index, secret: raw });
      continue;
    }
    const decoded = querySecret(pair.decodedName, pair.decodedValue);
    if (decoded)
      return {
        kind: "refused",
        text: `the placeholder for ${decoded.name} must not be percent-encoded`,
      };
  }
  if (swaps.length === 0) return unchanged;
  for (const { index, secret } of swaps) {
    const param = (secret.form as { param: string }).param;
    if (
      pairs.some((pair, other) => other !== index && pair.decodedName === param)
    )
      return { kind: "refused", text: `more than one ${param} parameter` };
  }
  for (const { secret } of swaps)
    if (!secret.hosts.includes(host)) return { kind: "forbidden", secret };
  if (!inject) return unchanged;
  const parts = pairs.map((pair) =>
    pair.value === null ? pair.name : `${pair.name}=${pair.value}`,
  );
  for (const { index, secret } of swaps)
    parts[index] =
      `${pairs[index].name}=${encodeURIComponent(valueOf(secret))}`;
  return {
    kind: "forward",
    path: `${path.slice(0, mark + 1)}${parts.join("&")}`,
    used: swaps.map(({ secret }) => secret),
  };
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
  exchanges: TokenCache,
  patternsOf: (state: State) => string[],
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

      // First with the stored values, and an exchange secret's placeholder
      // left as it is: its stored value is the app secret, which never goes
      // to the API host. When a secret with a token exchange is used, its
      // tokens come next (a fetch at most once per secret, and only for a
      // request that sends one), and the swap runs again with them on the
      // same snapshot.
      let swap = swapPlaceholders(
        state,
        host,
        method,
        head.headers,
        where.path,
        (secret) => (secret.exchange ? secret.placeholder : secret.value),
      );
      if (swap.kind === "forbidden")
        return fail(
          403,
          `the secret ${swap.secret.name} may not be sent to ${host}`,
        );
      if (swap.kind === "refused") return fail(400, swap.text);
      const tokens = new Map<ProxySecret, string>();
      for (const secret of new Set(swap.used)) {
        if (!secret.exchange) continue;
        const reply = await exchanges.token(secret);
        if (!reply.ok)
          return fail(502, exchangeFailureText(secret.name, reply.reason));
        tokens.set(secret, reply.token);
      }
      if (tokens.size > 0) {
        swap = swapPlaceholders(
          state,
          host,
          method,
          head.headers,
          where.path,
          (secret) => {
            if (!secret.exchange) return secret.value;
            const token = tokens.get(secret);
            if (token === undefined) throw new Error("no token");
            return token;
          },
        );
        // The same snapshot and request give the same result.
        if (swap.kind !== "forward") throw new Error("swap changed");
      }

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
        serializeHead(`${method} ${swap.path} HTTP/1.1`, forwarded),
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

      // This request's own tokens are in the set whatever the cache did
      // since the swap.
      const patterns =
        tokens.size === 0
          ? patternsOf(state)
          : [
              ...new Set([
                ...patternsOf(state),
                ...scrubPatterns(tokens.values()),
              ]),
            ].sort((a, b) => b.length - a.length);
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
      // A token the service refuses is fetched again (exchange.ts says when).
      if (status === 401)
        for (const [secret, token] of tokens)
          exchanges.unauthorized(secret, token);
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

// One token exchange: an HTTP/1.1 POST to the token address through the same
// path as a forwarded request (company proxy, stand-ins, roots). A redirect
// is never followed; the reply is read up to EXCHANGE_REPLY_CAP. Throws a
// failure reason, never an error with content.
async function sendExchange(
  state: State,
  request: ExchangeRequest,
): Promise<{ status: number; body: string }> {
  let socket: TLSSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExchangeError("timeout")),
      EXCHANGE_TIMEOUT_MS,
    );
  });
  const run = async () => {
    try {
      socket = await openTls(state, request.host);
    } catch {
      throw new ExchangeError("unreachable");
    }
    const body = Buffer.from(request.body, "utf8");
    const reader = new ByteReader(socket);
    try {
      socket.write(
        Buffer.concat([
          serializeHead(`POST ${request.path} HTTP/1.1`, [
            ["Host", request.host],
            ...request.headers,
            ["Accept-Encoding", "identity"],
            ["Content-Length", String(body.length)],
            ["Connection", "close"],
          ]),
          body,
        ]),
      );
      let head = await readHead(reader);
      while (head && /^HTTP\/1\.[01] 1[0-9][0-9]( |$)/.test(head.startLine))
        head = await readHead(reader);
      if (!head) throw new ExchangeError("unreachable");
      const status = Number(head.startLine.split(" ")[1]);
      if (!Number.isInteger(status)) throw new ExchangeError("unreachable");
      if (status < 200 || status >= 300) return { status, body: "" };
      const coding = headerValues(head.headers, "content-encoding")
        .join(",")
        .trim()
        .toLowerCase();
      if (coding && coding !== "identity") return { status, body: "" };
      const pieces: Buffer[] = [];
      let size = 0;
      for await (const piece of readBody(
        reader,
        bodyFraming(head.headers, { strict: false }),
      )) {
        size += piece.length;
        if (size > EXCHANGE_REPLY_CAP) return { status, body: "" };
        pieces.push(piece);
      }
      return { status, body: Buffer.concat(pieces).toString("utf8") };
    } catch (error) {
      throw error instanceof ExchangeError
        ? error
        : new ExchangeError("unreachable");
    }
  };
  // A run that loses the race to the timeout still settles later: its
  // rejection must not go unhandled.
  const running = run();
  running.catch(() => {});
  try {
    return await Promise.race([running, timedOut]);
  } finally {
    clearTimeout(timer);
    (socket as TLSSocket | null)?.destroy();
  }
}

// --- the listener ---

const digest = (text: string) => createHash("sha256").update(text).digest();

// One Proxy-Authorization header, Basic, whose password is the office's
// client token. The user name is not checked.
function authorized(headers: HeaderList, token: string): boolean {
  const values = headerValues(headers, "proxy-authorization");
  if (values.length !== 1) return false;
  const [scheme, encoded = ""] = values[0].trim().split(/\s+/, 2);
  if (scheme.toLowerCase() !== "basic") return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return timingSafeEqual(digest(decoded.slice(colon + 1)), digest(token));
}

// One User-Agent header, as browsers send it.
function browser(headers: HeaderList): boolean {
  const values = headerValues(headers, "user-agent");
  return values.length === 1 && values[0].startsWith("Mozilla/");
}

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
  const exchanges = createTokenCache({
    now: options.now ?? Date.now,
    send: (request) => sendExchange(state, request),
    onExchange: (secret, request) =>
      events.use({
        scope: secret.scope,
        ownerId: secret.ownerId,
        name: secret.name,
        host: request.host,
        method: "POST",
        path: request.path.split("?")[0],
      }),
  });
  // The scrub patterns: every value, and every live token. Made again only
  // when the snapshot or the live tokens change; a request takes its set
  // when its response starts.
  let patternMemo: {
    state: State;
    version: number;
    patterns: string[];
  } | null = null;
  const patternsOf = (current: State): string[] => {
    const version = exchanges.version();
    if (patternMemo?.state !== current || patternMemo.version !== version) {
      const tokens = exchanges.liveTokens();
      patternMemo = {
        state: current,
        version,
        patterns:
          tokens.length === 0
            ? current.patterns
            : scrubPatterns([
                ...current.snapshot.secrets.map((s) => s.value),
                ...tokens,
              ]),
      };
    }
    return patternMemo.patterns;
  };

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
    // Before anything else: another OS user on the box reaches this port too,
    // and must get neither a tunnel nor the company proxy's login. A client
    // without the password (a wrong one counts as none) is served only when
    // it runs as the office's own OS user, which only Linux can tell. Headless
    // Chrome needs that: it drops the password from HTTPS_PROXY. No log line
    // on the 407: git sends its first CONNECT without the password on purpose.
    const challenge = () =>
      void socket.end(
        errorResponse(
          407,
          "the secret proxy needs the password in HTTPS_PROXY",
          [["Proxy-Authenticate", 'Basic realm="isomux"']],
        ),
      );
    const withPassword = authorized(head.headers, state.snapshot.clientToken);
    if (!withPassword) {
      let uid: number | null;
      try {
        uid = await (options.peerUid ?? peerUid)(socket);
      } catch {
        uid = null;
      }
      if (uid === null || uid !== process.getuid?.()) return challenge();
      if (socket.destroyed) return;
    }
    const start = /^([^ ]+) ([^ ]+) HTTP\/1\.[01]$/.exec(head.startLine);
    if (!start) return refuse(400, "invalid request line");
    if (start[1] !== "CONNECT")
      return refuse(405, "the secret proxy accepts only CONNECT");
    const authority = parseAuthority(start[2]);
    if (!authority) return refuse(400, "invalid CONNECT target");
    const { host, port } = authority;
    const current = state;
    let secretHost = terminates(current, host, port);
    // Without the password, only a browser gets a plain tunnel to a secret's
    // host: browser engines ignore SSL_CERT_FILE and would refuse the office
    // CA. Any other client gets the 407, so git sends the password and gets
    // the swap.
    if (secretHost && !withPassword) {
      if (!browser(head.headers)) return challenge();
      secretHost = false;
    }

    if (!secretHost) {
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
        exchanges,
        patternsOf,
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
