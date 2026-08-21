import { describe, expect, it } from "bun:test";
import { appAccentHue, appFavicon } from "../app-favicon.ts";

describe("app favicon", () => {
  it("keeps a name's color stable and outside the green range", () => {
    expect(appAccentHue("habits")).toBe(appAccentHue("habits"));
    for (const name of ["habits", "todo", "game-video", "alpha", "beta"]) {
      const hue = appAccentHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(hue < 85 || hue >= 165).toBe(true);
    }
  });

  it("returns an Isomux SVG that browsers may cache", async () => {
    const response = appFavicon({ name: "habits" });
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("&gt;_");
    expect(body).toContain(`hsl(${appAccentHue("habits")} `);
  });

  it("usually separates neighboring app names", () => {
    expect(appAccentHue("habits")).not.toBe(appAccentHue("todo"));
  });
});
