import type { AppRecord } from "../shared/types.ts";

export const APP_FAVICON_PATH = "/favicon.ico";

// Keep app tabs in the Isomux family without making every tab the same green.
// The name is stable across process and browser restarts, so its color is too.
export function appAccentHue(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 280;
  return hue < 85 ? hue : hue + 80;
}

export function appFavicon(app: Pick<AppRecord, "name">): Response {
  const hue = appAccentHue(app.name);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><polygon points="2,10 16,18 16,30 2,22" fill="hsl(${hue} 55% 35%)"/><polygon points="30,10 16,18 16,30 30,22" fill="hsl(${hue} 50% 25%)"/><polygon points="16,8 24,12.5 16,17 8,12.5" fill="#0d1117"/><text x="16" y="14.5" text-anchor="middle" font-size="6" font-family="monospace" font-weight="bold" fill="#f4f4f5">&gt;_</text><polygon points="16,2 2,10 8,12.5 16,8" fill="hsl(${hue} 70% 55%)"/><polygon points="16,2 30,10 24,12.5 16,8" fill="hsl(${hue} 80% 65%)"/><polygon points="2,10 16,18 16,17 8,12.5" fill="hsl(${hue} 65% 48%)"/><polygon points="30,10 16,18 16,17 24,12.5" fill="hsl(${hue} 75% 58%)"/></svg>`;
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
