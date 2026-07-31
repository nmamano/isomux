// Slide iframe framing (design: internal-docs/slide-mode-design.md).
//
// Slides are model-generated HTML rendered ONLY inside a sandboxed iframe. The
// SECURITY BOUNDARY is a Content-Security-Policy, NOT sandbox="": sandbox=""
// (no allow-scripts) stops scripts, but a sandboxed document can still fetch
// subresources (img/font/css url()/etc.), which - since slides persist and
// reopen - would be a durable browser-side network primitive for anything a
// prompt-injected answer smuggled into the markup. `default-src 'none'` denies
// every outbound load; only inline styles are allowed (slides are inline-styled
// and our wrapper uses one <style>). extractSlideHtml (server) additionally
// rejects network-capable markup before persistence - defense in depth - but
// this CSP is the boundary we rely on.
//
// buildSlideMeasureSrcDoc (below) is an offscreen sizing-only variant used with
// sandbox="allow-same-origin"; because this same CSP blocks scripts and network
// there too, allow-same-origin only grants the parent read access - it never
// lets the model HTML execute or fetch. Full reasoning at that function.

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
// inline-styled only. `heightPx` is the body height the slide is laid out at:
// SLIDE_H by default, or a measured natural height for overfull slides (so the
// whole card scales to fit rather than clipping - see DeckView). overflow is
// hidden so nothing can ever scroll inside the frame.
export function buildSlideSrcDoc(
  html: string,
  heightPx: number = SLIDE_H,
): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">` +
    `<style>html,body{margin:0;padding:0;width:${SLIDE_W}px;height:${heightPx}px;overflow:hidden;background:#0f1117}</style>` +
    `</head><body>${html}</body></html>`
  );
}

// Height to lay a slide out at, given the natural content height measured
// offscreen (null while unmeasured - the frame stays at the canvas height until
// the measurement lands). Content that fits the 720 canvas keeps the canvas;
// taller content is laid out at its own height (+2px so sub-pixel rounding
// between the measurement and display documents can never shave the last line)
// so the whole card scales to fit instead of clipping. Never returns less than
// SLIDE_H - a slide is at least a full card.
export function slideDisplayHeight(naturalHeight: number | null): number {
  if (naturalHeight == null || naturalHeight <= SLIDE_H) return SLIDE_H;
  return Math.ceil(naturalHeight) + 2;
}

// Measurement variant: the SAME app-controlled CSP as the display frame, but
// the body is NOT height-clamped and overflow is NOT hidden, so the content
// flows to its natural height and the parent can read scrollHeight to size the
// display frame. This is rendered ONLY in an offscreen iframe that adds
// sandbox="allow-same-origin" (so the parent can read its DOM). That is safe
// because scripts stay blocked two ways - no allow-scripts in the sandbox AND
// `script-src 'none'` in the CSP - and all network stays blocked by
// `default-src 'none'`, exactly as in the display frame. allow-same-origin
// grants only parent read access to a script-dead, network-dead document; it
// does NOT let the model HTML run code or reach the network. See DeckView's
// MeasureFrame for the full threat-model writeup.
export function buildSlideMeasureSrcDoc(html: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">` +
    `<style>html,body{margin:0;padding:0;width:${SLIDE_W}px;background:#0f1117}</style>` +
    `</head><body>${html}</body></html>`
  );
}
