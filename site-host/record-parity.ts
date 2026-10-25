// Records live isomux.com responses into site-host/parity.json, the table
// site-host/server.test.ts replays against the site host.
// Run from the repository root, outside any HTTP proxy:
//   env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy bun site-host/record-parity.ts
// Re-record while isomux.com is still served by Vercel; after the move to the
// VPS a recording only shows the site host itself.
type Case = { name: string; method?: string; url: string; accept?: string };
const H = "https://isomux.com";
const cases: Case[] = [
  { name: "home", url: `${H}/` },
  { name: "home HEAD", method: "HEAD", url: `${H}/` },
  { name: "home markdown", url: `${H}/`, accept: "text/markdown" },
  {
    name: "home markdown HEAD",
    method: "HEAD",
    url: `${H}/`,
    accept: "text/markdown",
  },
  {
    name: "home markdown q-lower",
    url: `${H}/`,
    accept: "text/markdown;q=0.2, text/html;q=0.9",
  },
  { name: "home 406", url: `${H}/`, accept: "application/pdf" },
  {
    name: "home browser accept",
    url: `${H}/`,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
  { name: "home POST", method: "POST", url: `${H}/` },
  { name: "index", url: `${H}/index` },
  { name: "index.html", url: `${H}/index.html` },
  { name: "clean page", url: `${H}/about` },
  { name: "clean page trailing slash", url: `${H}/about/` },
  { name: "html extension", url: `${H}/about.html` },
  { name: "html extension with query", url: `${H}/about.html?a=1` },
  { name: "clean page HEAD", method: "HEAD", url: `${H}/about` },
  {
    name: "clean page markdown (no middleware)",
    url: `${H}/about`,
    accept: "text/markdown",
  },
  {
    name: "clean page 406 (no middleware)",
    url: `${H}/about`,
    accept: "application/pdf",
  },
  { name: "nested page", url: `${H}/use-cases/phone` },
  { name: "docs", url: `${H}/docs` },
  { name: "docs slash", url: `${H}/docs/` },
  { name: "docs markdown", url: `${H}/docs`, accept: "text/markdown" },
  { name: "docs slash markdown", url: `${H}/docs/`, accept: "text/markdown" },
  { name: "doc page", url: `${H}/docs/hosting` },
  { name: "doc page slash", url: `${H}/docs/hosting/` },
  {
    name: "doc page markdown",
    url: `${H}/docs/hosting`,
    accept: "text/markdown",
  },
  { name: "doc page 406", url: `${H}/docs/hosting`, accept: "image/png" },
  { name: "doc page missing", url: `${H}/docs/no-such-page` },
  {
    name: "doc page missing markdown",
    url: `${H}/docs/no-such-page`,
    accept: "text/markdown",
  },
  { name: "doc nested", url: `${H}/docs/hosting/extra` },
  { name: "agent md file", url: `${H}/_agent/docs/hosting/index.md` },
  { name: "agent index md", url: `${H}/_agent/index.md` },
  { name: "redirect self-hosted", url: `${H}/docs/self-hosted` },
  { name: "redirect self-hosted query", url: `${H}/docs/self-hosted?ref=x` },
  {
    name: "redirect self-hosted trailing slash",
    url: `${H}/docs/self-hosted/`,
  },
  {
    name: "redirect agent self-hosted",
    url: `${H}/_agent/docs/self-hosted/index.md`,
  },
  { name: "redirect vps-install", url: `${H}/docs/vps-install` },
  { name: "redirect deployments", url: `${H}/docs/deployments` },
  { name: "redirect use-cases", url: `${H}/use-cases` },
  { name: "redirect use-cases phone", url: `${H}/use-cases/phone` },
  { name: "redirect terms", url: `${H}/terms` },
  { name: "redirect privacy", url: `${H}/privacy` },
  { name: "redirect pricing", url: `${H}/pricing` },
  { name: "redirect pricing HEAD", method: "HEAD", url: `${H}/pricing` },
  { name: "www apex", url: "https://www.isomux.com/" },
  {
    name: "www path query",
    url: "https://www.isomux.com/docs/hosting?x=1&y=2",
  },
  { name: "www redirect source", url: "https://www.isomux.com/terms" },
  { name: "www html", url: "https://www.isomux.com/about.html" },
  { name: "security.txt rewrite", url: `${H}/.well-known/security.txt` },
  { name: "security.txt", url: `${H}/security.txt` },
  { name: "api-catalog rewrite", url: `${H}/.well-known/api-catalog` },
  { name: "api-catalog file", url: `${H}/api-catalog.json` },
  { name: "not found page", url: `${H}/no-such-page` },
  { name: "not found nested", url: `${H}/a/b/c` },
  {
    name: "not found markdown",
    url: `${H}/no-such-page`,
    accept: "text/markdown",
  },
  { name: "not found HEAD", method: "HEAD", url: `${H}/no-such-page` },
  { name: "not found POST", method: "POST", url: `${H}/no-such-page` },
  { name: "not found file ext", url: `${H}/nope.png` },
  { name: "api root", url: `${H}/api` },
  { name: "api unknown", url: `${H}/api/nope` },
  { name: "api underscore file", url: `${H}/api/_content-negotiation` },
  { name: "api not-found direct", url: `${H}/api/not-found` },
  { name: "api chat GET", url: `${H}/api/chat` },
  { name: "api chat OPTIONS", method: "OPTIONS", url: `${H}/api/chat` },
  { name: "api chat ts source", url: `${H}/api/chat.ts` },
  { name: "middleware source", url: `${H}/middleware.ts` },
  { name: "vercel.json", url: `${H}/vercel.json` },
  { name: "demo", url: `${H}/demo` },
  { name: "demo slash", url: `${H}/demo/` },
  { name: "demo app", url: `${H}/demo/app` },
  { name: "robots", url: `${H}/robots.txt` },
  { name: "llms", url: `${H}/llms.txt` },
  { name: "openapi", url: `${H}/openapi.json` },
  { name: "sitemap", url: `${H}/sitemap.xml` },
  { name: "css", url: `${H}/footer.css` },
  { name: "js", url: `${H}/chatbot.js` },
  { name: "svg", url: `${H}/favicon.svg` },
  { name: "ico", url: `${H}/favicon.ico` },
  { name: "png", url: `${H}/favicon.png` },
  { name: "jpeg", url: `${H}/add-to-home-screen.jpeg` },
  { name: "mp4", url: `${H}/office-trimmed.mp4` },
  { name: "gif", url: `${H}/office.gif` },
  { name: "indexnow key", url: `${H}/fbffa404de590d880791f3058b42c157.txt` },
  { name: "locale page", url: `${H}/es/` },
  { name: "locale page no slash", url: `${H}/es` },
  { name: "locale hosted", url: `${H}/zh/hosted` },
  { name: "hosted-terms", url: `${H}/hosted-terms` },
  { name: "hosted-privacy", url: `${H}/hosted-privacy` },
  { name: "double slash", url: `${H}//about` },
  { name: "encoded", url: `${H}/%61bout` },
  { name: "traversal", url: `${H}/..%2f..%2fetc/passwd` },
  { name: "vercel insights", url: `${H}/_vercel/insights/script.js` },
  {
    name: "redirect self-hosted markdown",
    url: `${H}/docs/self-hosted`,
    accept: "text/markdown",
  },
  {
    name: "redirect self-hosted 406",
    url: `${H}/docs/self-hosted`,
    accept: "image/png",
  },
  {
    name: "www docs markdown",
    url: "https://www.isomux.com/docs",
    accept: "text/markdown",
  },
  { name: "redirect pricing query", url: `${H}/pricing?x=1` },
  { name: "redirect vps-install query", url: `${H}/docs/vps-install?x=1` },
  { name: "not found nested encoded query", url: `${H}/a/b%20c?q=1` },
  { name: "api does-not-exist", url: `${H}/api/does-not-exist` },
  { name: "docs POST", method: "POST", url: `${H}/docs` },
  { name: "docs index.html", url: `${H}/docs/index.html` },
  { name: "traversal encoded dots", url: `${H}/%2e%2e/%2e%2e/etc/passwd` },
  { name: "null byte", url: `${H}/about%00.html` },
  { name: "bad percent", url: `${H}/%E0%A4%A` },
  { name: "chat POST no body", method: "POST", url: `${H}/api/chat` },
];
const VOLATILE = new Set([
  "date",
  "age",
  "x-vercel-id",
  "x-vercel-cache",
  "etag",
  "last-modified",
  "content-length",
  "x-matched-path",
  "x-vercel-error",
]);
const out = [];
for (const c of cases) {
  // Uncompressed, as the site host answers: Caddy compresses in front of it,
  // and Vercel drops Accept-Ranges from a compressed response.
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  if (c.accept) headers.accept = c.accept;
  const r = await fetch(c.url, {
    method: c.method ?? "GET",
    headers,
    redirect: "manual",
  });
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (!VOLATILE.has(k)) h[k] = v;
  });
  const body = await r.arrayBuffer();
  const sha = new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(body))
    .digest("hex");
  out.push({
    name: c.name,
    method: c.method ?? "GET",
    url: c.url,
    requestHeaders: headers,
    recordedAt: new Date().toISOString(),
    status: r.status,
    headers: h,
    bodyBytes: body.byteLength,
    bodySha256: sha,
  });
}
const table = {
  source:
    "Live isomux.com on Vercel, recorded by site-host/record-parity.ts (redirect: manual, no proxy, no compression). Headers that change per response or deploy (date, age, etag, last-modified, content-length, x-vercel-*, x-matched-path) are not recorded.",
  recordedAt: new Date().toISOString(),
  cases: out,
};
await Bun.write(
  new URL("parity.json", import.meta.url),
  `${JSON.stringify(table, null, 2)}\n`,
);
