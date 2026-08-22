import { negotiate } from "./api/_content-negotiation";

export { negotiate } from "./api/_content-negotiation";

function next(headers?: HeadersInit): Response {
  return new Response(null, {
    headers: {
      ...Object.fromEntries(new Headers(headers)),
      "x-middleware-next": "1",
    },
  });
}

function rewrite(destination: URL, headers: HeadersInit): Response {
  return new Response(null, {
    headers: {
      ...Object.fromEntries(new Headers(headers)),
      "x-middleware-rewrite": destination.toString(),
    },
  });
}

function markdownPath(pathname: string): string | null {
  if (pathname === "/") return "/_agent/index.md";
  if (pathname === "/docs" || pathname === "/docs/")
    return "/_agent/docs/index.md";
  const match = pathname.match(/^\/docs\/([^/]+)\/?$/);
  return match ? `/_agent/docs/${match[1]}/index.md` : null;
}

export default function middleware(req: Request): Response {
  const destination = markdownPath(new URL(req.url).pathname);
  if (!destination || (req.method !== "GET" && req.method !== "HEAD"))
    return next();
  const representation = negotiate(req.headers.get("accept"));
  if (representation === null) {
    return new Response(
      "Not acceptable. Request text/html or text/markdown.\n",
      {
        status: 406,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Vary: "Accept, Accept-Encoding",
        },
      },
    );
  }
  if (representation === "text/markdown") {
    return rewrite(new URL(destination, req.url), {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept, Accept-Encoding",
    });
  }
  return next({ Vary: "Accept, Accept-Encoding" });
}

export const config = { matcher: ["/", "/docs/:path*"] };
