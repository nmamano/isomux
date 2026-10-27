// The app-view report (task d7ac4f73). A framed app page gets one small
// script, appended at the end of the document, that tells the office wrapper
// which page the member sees, and that reloads the page in place when the
// wrapper asks after a change. Every other answer keeps the app's bytes: a
// direct visit, a non-2xx or non-HTML answer, a compressed body, a charset
// that is not UTF-8, and a page whose CSP (header or meta tag) restricts
// scripts. The protocol is in internal-docs/app-chat-widget-design.md.

import { buildPublicOrigin } from "./auth.ts";

export const APP_VIEW_MESSAGE_TYPE = "isomux:app-view";
export const APP_RELOAD_MESSAGE = "isomux:app-reload";
const POLL_MS = 500;

// True for a page load inside a frame: the only request whose answer may get
// the script.
export function framedDocumentRequest(req: Request): boolean {
  return req.method === "GET" && req.headers.get("Sec-Fetch-Dest") === "iframe";
}

// The script's source, bound to the office origin. It polls instead of
// wrapping the app's history API: a poll sees every way a route changes, and
// leaves the app's own globals alone. It posts only when the path or the title
// changed, and only to the office origin; it reloads only on the office's own
// message from the parent.
export function appViewScript(officeOrigin: string): string {
  const origin = JSON.stringify(officeOrigin);
  return (
    `(function(){var w=window;if(w.parent===w)return;var o=${origin},last=null;` +
    `function report(){var l=w.location,p=l.pathname+l.search+l.hash,t=w.document.title,k=p+"\\n"+t;` +
    `if(k===last)return;last=k;w.parent.postMessage({type:${JSON.stringify(APP_VIEW_MESSAGE_TYPE)},path:p,title:t},o)}` +
    `report();w.setInterval(report,${POLL_MS});` +
    `w.addEventListener("message",function(e){if(e.source===w.parent&&e.origin===o&&e.data===${JSON.stringify(APP_RELOAD_MESSAGE)})w.location.reload()})})();`
  );
}

// A directive that limits scripts, in any enforced policy. Report-Only
// policies block nothing.
function cspLimitsScripts(headers: Headers): boolean {
  const value = headers.get("Content-Security-Policy");
  if (!value) return false;
  return value
    .split(/[,;]/)
    .map((part) => part.trim().split(/\s+/)[0]?.toLowerCase())
    .some(
      (name) =>
        name === "script-src" ||
        name === "script-src-elem" ||
        name === "default-src",
    );
}

function isUtf8Html(contentType: string | null): boolean {
  if (!contentType) return false;
  const [type, ...params] = contentType.split(";");
  if (type.trim().toLowerCase() !== "text/html") return false;
  for (const param of params) {
    const [key, raw = ""] = param.split("=");
    if (key.trim().toLowerCase() !== "charset") continue;
    const charset = raw.trim().replace(/^"|"$/g, "").toLowerCase();
    if (charset !== "utf-8" && charset !== "utf8") return false;
  }
  return true;
}

// The upstream response with the script appended, or the same response when
// any check refuses. Runs on the upstream headers, before the framing policy
// adds its own CSP.
export function injectAppView(response: Response, req: Request): Response {
  const encoding = response.headers.get("Content-Encoding");
  if (
    !framedDocumentRequest(req) ||
    response.status < 200 ||
    response.status > 299 ||
    response.body === null ||
    !isUtf8Html(response.headers.get("Content-Type")) ||
    (encoding !== null && encoding.trim().toLowerCase() !== "identity") ||
    cspLimitsScripts(response.headers)
  )
    return response;
  // The upstream length and validator describe other bytes.
  response.headers.delete("Content-Length");
  response.headers.delete("ETag");
  let metaCsp = false;
  return new HTMLRewriter()
    .on("meta[http-equiv]", {
      element(element) {
        if (
          element.getAttribute("http-equiv")?.trim().toLowerCase() ===
          "content-security-policy"
        )
          metaCsp = true;
      },
    })
    .onDocument({
      end(end) {
        // A meta CSP may not allow it; its report-uri should not hear of us.
        if (metaCsp) return;
        end.append(
          `<script>${appViewScript(buildPublicOrigin().origin)}</script>`,
          {
            html: true,
          },
        );
      },
    })
    .transform(response);
}
