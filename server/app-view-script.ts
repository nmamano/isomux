// The app-view report (task d7ac4f73). A framed app page gets one small
// script, appended at the end of the document, that tells the office wrapper
// which page the member sees, that reloads the page in place when the wrapper
// asks after a change, and that opens the app's own pages in a new tab on
// their widget page (task 469e8886). Every other answer keeps the app's bytes: a
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

// The script's source, bound to the office origin and the app's name. It
// polls instead of wrapping the app's history API: a poll sees every way a
// route changes. It posts only when the path or the title changed, and only to
// the office origin; it reloads only on the office's own message from the
// parent.
//
// It also keeps the chat when the app opens one of its own pages in a new tab
// (task 469e8886): a new-tab link (a target other than _self, _parent, _top or
// a frame of the page, a ctrl, meta or shift click, a middle click) and a
// window.open to a new tab open the app's widget page at that path instead,
// with no handle back to the office tab. So window.open is the one app global
// it wraps; every other call goes to the original. Same app means the same
// protocol and host: blob:, data: and other origins keep their behavior.
export function appViewScript(officeOrigin: string, appName: string): string {
  const origin = JSON.stringify(officeOrigin);
  const name = JSON.stringify(appName);
  return (
    `(function(){var w=window;if(w.parent===w)return;var o=${origin},n=${name},last=null,d=w.document;` +
    `function report(){var l=w.location,p=l.pathname+l.search+l.hash,t=d.title,k=p+"\\n"+t;` +
    `if(k===last)return;last=k;w.parent.postMessage({type:${JSON.stringify(APP_VIEW_MESSAGE_TYPE)},path:p,title:t},o)}` +
    `report();w.setInterval(report,${POLL_MS});` +
    `w.addEventListener("message",function(e){if(e.source===w.parent&&e.origin===o&&e.data===${JSON.stringify(APP_RELOAD_MESSAGE)})w.location.reload()});` +
    // The widget address of a page of this app, or null.
    `function widget(href,base){var u;try{u=new URL(href,base)}catch(x){return null}` +
    `var l=w.location;if(u.protocol!==l.protocol||u.host!==l.host)return null;return o+"/"+n+u.pathname+u.search+u.hash}` +
    // A target that opens a new browsing context: not a keyword that stays in
    // the page, and not the name of one of the page's frames.
    `function newTab(t){var k=t.toLowerCase();if(k===""||k==="_blank")return true;if(k==="_self"||k==="_parent"||k==="_top")return false;` +
    `var f=d.querySelectorAll("iframe[name],frame[name]");for(var i=0;i<f.length;i++)if(f[i].getAttribute("name")===t)return false;return true}` +
    `var open=w.open;function openWidget(u){open.call(w,u,"_blank","noopener")}` +
    `function click(e){if(e.defaultPrevented||e.altKey)return;var aux=e.type==="auxclick";if(e.button!==(aux?1:0))return;` +
    `var path=e.composedPath(),a=null;for(var i=0;i<path.length;i++){var c=path[i];` +
    `if(c&&(c.localName==="a"||c.localName==="area")&&c.getAttribute("href")!==null){a=c;break}}` +
    `if(!a||a.hasAttribute("download"))return;var b=d.querySelector("base[target]");` +
    `var t=a.getAttribute("target")||(b&&b.getAttribute("target"))||"";` +
    `if(!(aux||e.ctrlKey||e.metaKey||e.shiftKey||(t!==""&&newTab(t))))return;` +
    `var u=widget(a.getAttribute("href"),a.baseURI);if(!u)return;e.preventDefault();openWidget(u)}` +
    `w.addEventListener("click",click);w.addEventListener("auxclick",click);` +
    `w.open=function(url,target){if(url!==undefined&&url!==null&&String(url)!==""&&newTab(target===undefined?"":String(target))){` +
    `var u=widget(String(url),d.baseURI);if(u){openWidget(u);return null}}return open.apply(w,arguments)}})();`
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
export function injectAppView(
  response: Response,
  req: Request,
  appName: string,
): Response {
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
          `<script>${appViewScript(buildPublicOrigin().origin, appName)}</script>`,
          {
            html: true,
          },
        );
      },
    })
    .transform(response);
}
