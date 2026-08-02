// Google Analytics (GA4), property "isomux.com" (548159438).
//
// Shared by every page on the site - the landing page, /hosted, the generated
// /docs/** pages, and the demo - so the measurement ID lives in exactly one
// place. Loaded the same way as theme-toggle.js: <script defer src="/analytics.js">.
//
// Only fires on the production host, so Vercel preview deployments and local
// dev servers stay out of the real numbers.

(function () {
  if (
    location.hostname !== "isomux.com" &&
    location.hostname !== "www.isomux.com"
  ) {
    return;
  }

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
