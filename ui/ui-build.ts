// Which UI build this tab runs, and when to tell the member that the server
// serves a newer one (server/ui-build.ts).

const PLACEHOLDER = "__ISOMUX_UI_BUILD__";

// This page's build id, from the meta scripts/build.sh fills in. null when the
// meta is missing or still holds the placeholder.
export function ownUiBuild(): string | null {
  const content = document
    .querySelector('meta[name="isomux-ui-build"]')
    ?.getAttribute("content");
  return content && content !== PLACEHOLDER ? content : null;
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
