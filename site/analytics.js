// Google Analytics (GA4), property "isomux.com" (548159438).
//
// Shared by every page on the site - the landing page, /hosted, the generated
// /docs/** pages, and the demo - so the measurement ID lives in exactly one
// place. Loaded the same way as theme-toggle.js: <script defer src="/analytics.js">.
//
// Only fires on the production host, so Vercel preview deployments and local
// dev servers stay out of the real numbers.

// The first-touch signup source. On the first page of a tab's session, keep the
// referring site's host (not when it is isomux.com), the page path and the
// utm_source and utm_campaign tags in sessionStorage, and add them to every
// link to the Hosted app, which keeps them until signup
// (control-plane/web/lib/signup-source.ts). A named function so a test can run
// it with its own location; the production-host gate below calls it.
window.isomuxFirstTouch = function (loc, referrer, storage, doc) {
  var KEY = "isomux-first-touch";
  var touch = null;
  try {
    touch = JSON.parse(storage.getItem(KEY) || "null");
  } catch (e) {
    touch = null;
  }
  if (!touch || typeof touch !== "object") {
    var host = "";
    try {
      host = referrer ? new URL(referrer).hostname.toLowerCase() : "";
    } catch (e) {
      host = "";
    }
    // A page opened from our own site is not where the visit started.
    if (host === "isomux.com" || /\.isomux\.com$/.test(host)) return;
    var query = new URLSearchParams(loc.search);
    touch = {
      ref_host: host,
      landing_path: loc.pathname,
      utm_source: query.get("utm_source") || "",
      utm_campaign: query.get("utm_campaign") || "",
    };
    storage.setItem(KEY, JSON.stringify(touch));
  }
  var links = doc.querySelectorAll('a[href^="https://cloud.isomux.com"]');
  for (var i = 0; i < links.length; i++) {
    var url = new URL(links[i].getAttribute("href"));
    if (url.hostname !== "cloud.isomux.com") continue;
    for (var name in touch) {
      if (typeof touch[name] === "string" && touch[name]) {
        url.searchParams.set(name, touch[name]);
      }
    }
    links[i].setAttribute("href", url.toString());
  }
};

(function () {
  if (
    location.hostname !== "isomux.com" &&
    location.hostname !== "www.isomux.com"
  ) {
    return;
  }

  try {
    window.isomuxFirstTouch(
      location,
      document.referrer,
      sessionStorage,
      document,
    );
  } catch (e) {
    // Storage can be off in a private window; the links then go out untagged.
  }

  // Keep this ID and config aligned with control-plane/web/app/layout.tsx.
  var MEASUREMENT_ID = "G-6QKGF1LV4X";

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  gtag("js", new Date());
  gtag("config", MEASUREMENT_ID, {
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  var tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID;
  document.head.appendChild(tag);
})();
