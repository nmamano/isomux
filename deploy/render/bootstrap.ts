import { timingSafeEqual } from "node:crypto";

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up Isomux</title><style>
body{font:17px system-ui;background:#111827;color:#f3f4f6;margin:0;display:grid;min-height:100vh;place-items:center}
main{max-width:420px;padding:40px}h1{font-size:30px}p{line-height:1.5;color:#cbd5e1}
label{display:block;margin-top:24px}input,button{box-sizing:border-box;width:100%;padding:12px;font:inherit;border-radius:8px;border:1px solid #64748b}
input{margin-top:8px;background:#1f2937;color:white}button{margin-top:28px;background:#a5b4fc;color:#111827;cursor:pointer}
</style><main><h1>Set up your office</h1><p>Enter the setup key from your Render service settings to become this office's first owner.</p>
<form method="post" action="/setup"><label>Your name<input name="name" required maxlength="64" autocomplete="name"></label>
<label>Setup key<input name="key" type="password" required autocomplete="off"></label><button>Create office</button></form></main></html>`;

export function createSetupHandler(options: {
  origin: string;
  key: string;
  hasOwner: () => boolean;
  claim: (name: string, userAgent: string | null) => Promise<string | null>;
  complete: () => void;
}) {
  if (options.key.length < 32)
    throw new Error("Setup key must contain at least 32 characters");
  let claimed = false;
  let inFlight = false;
  let attempts = 0;
  let windowStart = Date.now();
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET")
      return new Response("ok");
    if (options.hasOwner() || claimed)
      return new Response("Office setup is complete", { status: 409 });
    if (path === "/" && request.method === "GET")
      return new Response(page, { headers });
    if (path !== "/setup" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (request.headers.get("origin") !== options.origin)
      return new Response("Bad origin", { status: 403 });
    if (Date.now() - windowStart > 60_000) {
      attempts = 0;
      windowStart = Date.now();
    }
    if (++attempts > 20)
      return new Response("Try again later", { status: 429 });
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      return new Response("Unsupported form", { status: 415 });
    // The actual Bun listener also bounds the body before buffering it.
    const body = await request.text();
    if (body.length > 4096)
      return new Response("Form too large", { status: 413 });
    const form = new URLSearchParams(body);
    const key = Buffer.from(form.get("key") || "");
    const expected = Buffer.from(options.key);
    if (key.length !== expected.length || !timingSafeEqual(key, expected))
      return new Response("Incorrect setup key", { status: 403 });
    if (inFlight) return new Response("Setup is in progress", { status: 409 });
    inFlight = true;
    try {
      const cookie = await options.claim(
        form.get("name") || "",
        request.headers.get("user-agent"),
      );
      if (cookie === null)
        return new Response("Check the owner name", { status: 400 });
      claimed = true;
      // Give the browser its cookie before replacing this listener with the office.
      setTimeout(options.complete, 500);
      return new Response(
        '<!doctype html><meta http-equiv="refresh" content="3;url=/"><title>Office ready</title><p>Your office is starting.</p>',
        {
          headers: { ...headers, "Set-Cookie": cookie },
        },
      );
    } finally {
      inFlight = false;
    }
  };
}
