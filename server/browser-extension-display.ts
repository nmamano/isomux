import type { BrowserDisplay } from "../shared/browser-extension-protocol";

// Only record-derived labels cross this seam. Never include page data.
export function browserDisplay(id: string, name: string): BrowserDisplay {
  return { id, name: name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 100) };
}
