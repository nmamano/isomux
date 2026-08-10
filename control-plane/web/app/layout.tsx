import "./globals.css";

export const metadata = {
  title: "Hosted Isomux",
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
        {/* The chrome lives here rather than in a wrapper component, so that no
            page has to give up its own <main> to get it. The bar carries the
            mark and no words: the copy on these pages is fixed, and a brand
            wordmark would be a new one. */}
        <div className="topbar">
          <div className="topbar-inner">
            <span className="brand-mark" />
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
