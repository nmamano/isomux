import type { BrowserDisplay } from "../shared/browser-extension-protocol";

// Only record-derived labels cross this seam. Never include page data.
export function browserDisplay(id: string, name: string): BrowserDisplay {
  return { id, name: name.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, 100) };
}
