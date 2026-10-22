import { describe, expect, it } from "bun:test";
import { appFavicon } from "../app-favicon.ts";

// The arm serves this icon only behind the app's sign-in, and a different one
// per app (app-host-dispatch.test.ts). This pins the icon itself.
async function hues(name: string): Promise<Set<number>> {
  const body = await appFavicon({ name }).text();
  return new Set([...body.matchAll(/hsl\((\d+) /g)].map((m) => Number(m[1])));
}

describe("app favicon", () => {
  it("returns a cacheable Isomux SVG", async () => {
    const response = appFavicon({ name: "habits" });
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("&gt;_");
  });

  it("paints each app in one hue outside the office's green range", async () => {
    for (const name of ["habits", "todo", "game-video", "alpha", "beta"]) {
      const [hue, ...others] = await hues(name);
      expect({ name, others }).toEqual({ name, others: [] });
      expect({ name, inRange: hue >= 0 && hue < 360 }).toEqual({
        name,
        inRange: true,
      });
      expect({ name, green: hue >= 85 && hue < 165 }).toEqual({
        name,
        green: false,
      });
    }
  });
});
