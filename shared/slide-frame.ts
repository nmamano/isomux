// Slide iframe framing (design: internal-docs/slide-mode-design.md).
//
// Slides are model-generated HTML rendered ONLY inside a sandboxed iframe. The
// SECURITY BOUNDARY is a Content-Security-Policy, NOT sandbox="": sandbox=""
// (no allow-scripts) stops scripts, but a sandboxed document can still fetch
// subresources (img/font/css url()/etc.), which — since slides persist and
// reopen — would be a durable browser-side network primitive for anything a
// prompt-injected answer smuggled into the markup. `default-src 'none'` denies
// every outbound load; only inline styles are allowed (slides are inline-styled
// and our wrapper uses one <style>). extractSlideHtml (server) additionally
// rejects network-capable markup before persistence — defense in depth — but
// this CSP is the boundary we rely on.

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export const SLIDE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "connect-src 'none'",
  "script-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// Wrap a slide fragment in a minimal offline document. The <meta> CSP and the
// <style> here are app-controlled (never model content); the fragment itself is
// inline-styled only.
export function buildSlideSrcDoc(html: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">` +
    `<style>html,body{margin:0;padding:0;width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;background:#0f1117}</style>` +
    `</head><body>${html}</body></html>`
  );
}
