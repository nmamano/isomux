// The certificate forwarder: what the old provisioner hostname runs after the
// provisioner moves. Customer offices call that hostname for renewal and
// status from their enrollment file, and DNS cannot repoint it. This passes
// exactly those two calls to the new provisioner and nothing else.
//
// It holds no credentials. The office's own bearer travels through unchanged
// and the new provisioner checks it, so this hop adds no new trust. It reads
// no state and logs no request. It imports nothing from control-plane/, so the
// image is this one file (control-plane/README.md, "The certificate
// forwarder").

export const RENEW_PATH = "/internal/certificates/renew";
export const STATUS_PATH = "/internal/certificates/status";
/** The seam's own bound: MAX_CSR_BYTES plus 4 KiB of JSON. */
export const MAX_BODY_BYTES = 32 * 1024 + 4096;
const MAX_DRAIN_BYTES = 1024 * 1024;
/** Under the office helper's curl --max-time (600 s renew, 60 s status), so
 * the helper gets an answer it retries instead of its own timeout. */
export const UPSTREAM_TIMEOUT_MS = {
  [RENEW_PATH]: 570_000,
  [STATUS_PATH]: 50_000,
} as const;
/** Marks a call that came through here. Not a credential: the provisioner
 * only logs it, so a sender that fakes it mislabels its own calls. */
export const FORWARDED_HEADER = "isomux-forwarded";
export const RETRY_AFTER_SECONDS = "30";

/** Names a provisioner credential lives under. Fly gives app secrets to every
 * machine of the app, so the forwarder refuses to start until they are unset. */
const CREDENTIAL_NAMES = [
  /^CONTROL_PLANE_/,
  /^STRIPE_/,
  /^CONTABO_/,
  /^ISOMUX_CF_/,
  /^ISOMUX_ACME_/,
  /^PROBE_CANARY$/,
];

export function credentialNamesIn(
  env: Record<string, string | undefined>,
): string[] {
  return Object.keys(env)
    .filter((name) => CREDENTIAL_NAMES.some((pattern) => pattern.test(name)))
    .sort();
}

/** The new provisioner's origin: HTTPS, no path, query, fragment or user. */
export function parseTarget(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("ISOMUX_FORWARD_TO must be an https:// origin");
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    value !== url.origin
  ) {
    throw new Error("ISOMUX_FORWARD_TO must be an https:// origin");
  }
  return url;
}

const notFound = () => new Response("not found\n", { status: 404 });
const unavailable = (status: number) =>
  new Response("certificate service unavailable\n", {
    status,
    headers: { "retry-after": RETRY_AFTER_SECONDS },
  });

/**
 * Reads the whole body, keeping at most MAX_BODY_BYTES. A body is read to its
 * end even when it is refused: an unread rest would be parsed as the next
 * request on a connection a proxy reuses. Past MAX_DRAIN_BYTES the caller is
 * not an office, and its connection is left as it is.
 */
async function readBody(
  req: Request,
): Promise<{ bytes: Uint8Array<ArrayBuffer> } | { tooLarge: true }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  const reader = req.body?.getReader();
  if (declared > MAX_DRAIN_BYTES) {
    await reader?.cancel();
    return { tooLarge: true };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size <= MAX_BODY_BYTES) chunks.push(part.value);
    else if (size > MAX_DRAIN_BYTES) {
      await reader.cancel();
      return { tooLarge: true };
    }
  }
  if (size > MAX_BODY_BYTES) return { tooLarge: true };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

export interface ForwarderOptions {
  /** The new provisioner's origin. parseTarget makes it HTTPS in production;
   * tests pass a local origin. */
  target: URL;
  port?: number;
  hostname?: string;
  /** Test seam for the upstream bounds. */
  timeoutMs?: Partial<Record<keyof typeof UPSTREAM_TIMEOUT_MS, number>>;
}

/** Asks the new provisioner. Every failure, including one while its answer
 * is still arriving, becomes a fixed retryable answer. */
async function askProvisioner(
  opts: ForwarderOptions,
  path: typeof RENEW_PATH | typeof STATUS_PATH,
  headers: Record<string, string>,
  body: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  const init = {
    method: "POST",
    headers,
    body,
    redirect: "manual" as const,
    signal: AbortSignal.timeout(
      opts.timeoutMs?.[path] ?? UPSTREAM_TIMEOUT_MS[path],
    ),
    // Bun's fetch ends any call at 300 s on its own (measured 2026-10-06,
    // Bun 1.3.11), under the renew bound above. Off, so the signal is the one
    // bound. Bun reads it; its types do not declare it.
    timeout: false,
  };
  try {
    const answer = await fetch(new URL(path, opts.target), init);
    // The provisioner never redirects these calls. Following one would send
    // the office bearer somewhere this hop was not configured to reach.
    if (answer.status >= 300 && answer.status < 400) {
      await answer.body?.cancel();
      return unavailable(502);
    }
    const out = new Headers();
    const answerType = answer.headers.get("content-type");
    if (answerType !== null) out.set("content-type", answerType);
    return new Response(await answer.arrayBuffer(), {
      status: answer.status,
      headers: out,
    });
  } catch (error) {
    return unavailable((error as Error)?.name === "TimeoutError" ? 504 : 503);
  }
}

async function forward(req: Request, opts: ForwarderOptions) {
  const url = new URL(req.url);
  const path = url.pathname;
  const read = await readBody(req);
  if (
    req.method !== "POST" ||
    (path !== RENEW_PATH && path !== STATUS_PATH) ||
    url.search !== ""
  ) {
    return notFound();
  }
  if ("tooLarge" in read)
    return new Response("request too large\n", { status: 413 });
  const headers: Record<string, string> = { [FORWARDED_HEADER]: "1" };
  const authorization = req.headers.get("authorization");
  if (authorization !== null) headers.authorization = authorization;
  const contentType = req.headers.get("content-type");
  if (contentType !== null) headers["content-type"] = contentType;
  return askProvisioner(opts, path, headers, read.bytes);
}

// Bun's own error answer logs the request URL, so nothing may reach it. No
// failure is known to get here (a request cut off half sent does not, measured
// 2026-10-06); this is the backstop.
const failed = () => new Response("bad request\n", { status: 400 });

export function startForwarder(opts: ForwarderOptions) {
  return Bun.serve({
    port: opts.port ?? 8080,
    hostname: opts.hostname ?? "::",
    async fetch(req) {
      try {
        return await forward(req, opts);
      } catch {
        return failed();
      }
    },
  });
}

if (import.meta.main) {
  const held = credentialNamesIn(process.env);
  if (held.length > 0) {
    console.error(
      `refusing to start: the environment holds provisioner credentials (${held.join(", ")}); unset them from the Fly app first`,
    );
    process.exit(1);
  }
  let target: URL;
  try {
    target = parseTarget(process.env.ISOMUX_FORWARD_TO);
  } catch (error) {
    console.error(`refusing to start: ${(error as Error).message}`);
    process.exit(1);
  }
  const server = startForwarder({
    target,
    port: Number(process.env.PORT ?? "") || undefined,
  });
  console.log(
    `certificate forwarder on port ${server.port}, to ${target.origin}`,
  );
}
