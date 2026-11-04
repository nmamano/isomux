// Which UI build this tab runs, and when to tell the member that the server
// serves a newer one (server/ui-build.ts).

// scripts/build.sh replaces this placeholder in index.js with the build id.
// The id comes from the running code, not from the page's meta: a restored tab
// can pair an old cached page with the current index.js.
const BUILD = "__ISOMUX_UI_BUILD__";

// This tab's build id. null in a bundle that was never stamped (dev, tests,
// the demo). Checked by its shape, never against the placeholder: the
// minifier would fold that compare, and the stamp would replace both sides.
export function ownUiBuild(): string | null {
  return /^[0-9a-f]{16}$/.test(BUILD) ? BUILD : null;
}

// Derived, never latched: when the server serves this tab's build again, the
// notice goes away.
export function showUiBuildNotice(
  own: string | null,
  server: string | null,
  dismissed: string | null,
): boolean {
  return (
    own !== null && server !== null && own !== server && server !== dismissed
  );
}
