// The default name for a browser the member pairs on Integrations > Browser,
// read from the browser the member is on.

export type BrowserGuess = { browser: string; os: string };

// Null when this browser cannot load the extension (Firefox, Safari) or runs
// on a phone or tablet: the member then pairs some other computer.
export function guessBrowserName(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): BrowserGuess | null {
  // iPadOS reports itself as a Mac; the touch points tell them apart.
  if (
    /iPhone|iPad|iPod|Android|Mobile/.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1)
  )
    return null;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : null;
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /CrOS/.test(userAgent)
      ? "ChromeOS"
      : /Macintosh|Mac OS X/.test(userAgent)
        ? "macOS"
        : /Linux/.test(userAgent)
          ? "Linux"
          : null;
  return browser && os ? { browser, os } : null;
}
