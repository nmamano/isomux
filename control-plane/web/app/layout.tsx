import "./globals.css";
import type { Metadata } from "next";
import Script from "next/script";
import { TopBar } from "../components/top-bar";
import { SignupSourceCapture } from "./signup-source-capture";

const analyticsBootstrap = `
  (function () {
    // Unknown routes fail closed. Add a route here before it can report.
    var normalizedPath = location.pathname === "/signup" ? "/signup" : null;
    if (location.hostname !== "cloud.isomux.com" || normalizedPath === null) {
      return;
    }

    // Keep this ID and config aligned with site/analytics.js.
    var measurementId = "G-6QKGF1LV4X";
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    window.gtag("config", measurementId, {
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      send_page_view: false,
    });
    window.gtag("event", "page_view", {
      page_location: "https://cloud.isomux.com" + normalizedPath,
      page_referrer: "",
    });

    var tag = document.createElement("script");
    tag.async = true;
    tag.src = "https://www.googletagmanager.com/gtag/js?id=" + measurementId;
    document.head.appendChild(tag);
  })();
`;

export const metadata: Metadata = {
  title: "Hosted Isomux",
  // Each page names its own path as canonical, so a query-string variant such
  // as /?landing_path=/hosted is not a duplicate of the page in Search Console.
  // Next resolves "./" against the request pathname, never the query string.
  // The base is explicit because Next's fallback is not the custom domain.
  metadataBase: new URL("https://cloud.isomux.com"),
  alternates: { canonical: "./" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* The landing page's two families, requested the same way it requests
            them. If the request fails the system stack in globals.css takes
            over, which is the fallback the landing already relies on. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Script id="google-analytics" strategy="afterInteractive">
          {analyticsBootstrap}
        </Script>
        <SignupSourceCapture />
        {/* The chrome lives here rather than in a wrapper component, so that no
            page has to give up its own <main> to get it. The bar carries the
            mark and the "Isomux" wordmark, the nav and the account once the
            visitor is known to be signed in, and the language switch; the
            operator pages get the brand alone. See components/top-bar.tsx.

            `lang="en"` above is the STATIC default and cannot be anything else:
            reading the request here would make every route dynamic, and `/` and
            `/signin` are prerendered under `dynamic = "error"` so that a CDN can
            hold them. Each page declares its own language instead, through
            `DocumentLanguage`, which moves the attribute to match the text; the
            server-rendered pages also mark their translated region with `lang`
            for a reader with no JavaScript. */}
        <TopBar />
        {children}
      </body>
    </html>
  );
}
