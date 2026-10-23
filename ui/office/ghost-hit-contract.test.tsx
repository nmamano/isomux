// A ghost's box is bigger than the ghost: clicks on its transparent padding
// must fall through to the desk under it, and only painted pixels take them.
// The browser's hit test itself needs a browser; this pins the declarations
// that give it, as the scene renders them.
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GhostBody } from "./Ghost.tsx";

// The opening tag of the first element `pattern` matches, or a failure.
function tag(html: string, pattern: RegExp): string {
  const found = html.match(pattern)?.[0];
  expect(found).toBeDefined();
  return found!;
}

describe("ghost hit area", () => {
  const html = renderToStaticMarkup(
    <GhostBody
      left={0}
      top={0}
      size={40}
      variant="glow-halo"
      color="#7c9cf5"
      username="peer"
      device={null}
      userId="peer"
      dimmed={false}
      onClick={() => {}}
    />,
  );

  it("leaves the clickable wrapper and its svg transparent, and the painted ghost interactive", () => {
    expect(tag(html, /^<div[^>]*>/)).toContain("pointer-events:none");
    expect(tag(html, /<svg[^>]*>/)).toContain("pointer-events:none");
    expect(tag(html, /<svg[^>]*>\s*<g[^>]*>/)).toContain(
      "pointer-events:visiblePainted",
    );
  });

  it("keeps the decorative glow out of the painted hit area", () => {
    // The two halo ellipses of the glow-halo variant.
    for (const rx of ["62", "48"])
      expect(tag(html, new RegExp(`<ellipse[^>]*rx="${rx}"[^>]*>`))).toContain(
        'pointer-events="none"',
      );
  });
});
