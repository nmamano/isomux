import { negotiate } from "./_content-negotiation";

export const config = { runtime: "edge" };

const MARKDOWN_404 = `# Isomux: page not found

The requested path does not exist.

- [Documentation](https://isomux.com/docs)
- [Machine-readable site guide](https://isomux.com/llms.txt)
- [OpenAPI specification](https://isomux.com/openapi.json)
- [Sitemap](https://isomux.com/sitemap.xml)
`;

const HTML_404 = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Page not found | Isomux</title></head>
<body><main><h1>Isomux: page not found</h1><p>The requested path does not exist.</p><ul><li><a href="/docs">Documentation</a></li><li><a href="/llms.txt">Machine-readable site guide</a></li><li><a href="/openapi.json">OpenAPI specification</a></li><li><a href="/sitemap.xml">Sitemap</a></li></ul></main></body>
</html>
`;

export default function handler(req: Request): Response {
  const url = new URL(req.url);
  const requestedPath = url.searchParams.get("path");
  const pathname = requestedPath === null ? url.pathname : `/${requestedPath}`;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  const wantsMarkdown =
    !isApi && negotiate(req.headers.get("accept")) === "text/markdown";
  const headers: Record<string, string> = isApi
    ? { "Content-Type": "application/json; charset=utf-8" }
    : {
        "Content-Type": wantsMarkdown
          ? "text/markdown; charset=utf-8"
          : "text/html; charset=utf-8",
        Vary: "Accept, Accept-Encoding",
      };
  const body = isApi
    ? JSON.stringify({
        error: {
          code: "not_found",
          message: `No API endpoint exists at ${pathname}.`,
          resolution:
            "Read https://isomux.com/openapi.json for supported endpoints.",
        },
      })
    : wantsMarkdown
      ? MARKDOWN_404
      : HTML_404;
  return new Response(req.method === "HEAD" ? null : body, {
    status: 404,
    headers: { ...headers, "Cache-Control": "public, max-age=60" },
  });
}
