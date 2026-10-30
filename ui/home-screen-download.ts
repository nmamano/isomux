// Downloads on the iPhone Home Screen office (task f8d05b49). There, a link to
// a file opens the iOS file preview inside the window, with no way back, and
// Safari has no session to download it in. So the link's click fetches the
// file and opens the share sheet, which offers Save Image and Save to Files.
// Everywhere else the link downloads as usual.

import { readSafariEnv, type SafariEnv } from "./safari-link.ts";

export interface HomeScreenDownloadDeps {
  env?: SafariEnv;
  fetch?: (url: string) => Promise<Response>;
  // null: this browser has no share API. undefined: navigator's.
  share?: ((data: ShareData) => Promise<void>) | null;
  canShare?: ((data: ShareData) => boolean) | null;
}

// The last file fetched. iOS opens the share sheet only during a tap, and a
// slow fetch can outlast the tap (NotAllowedError); the next tap on the same
// link then shares this file at once. While the fetch runs, `file` is unset
// and a second tap starts nothing.
let cache: { url: string; file?: File } | null = null;

export function resetHomeScreenDownloadCache(): void {
  cache = null;
}

// Called from a download link's click handler.
export function homeScreenDownload(
  e: { preventDefault(): void },
  url: string,
  name: string,
  deps: HomeScreenDownloadDeps = {},
): void {
  const env = deps.env ?? readSafariEnv();
  if (!env.ios || !env.standalone) return;
  e.preventDefault();

  const share =
    deps.share === undefined
      ? navigator.share?.bind(navigator)
      : (deps.share ?? undefined);
  const canShare =
    deps.canShare === undefined
      ? navigator.canShare?.bind(navigator)
      : (deps.canShare ?? undefined);
  if (!share) {
    console.warn("[download] this browser has no share sheet");
    return;
  }

  if (cache?.url === url) {
    // Shared at once from the cache, or the fetch is still running.
    if (cache.file) shareFile(cache.file, share, canShare);
    return;
  }
  const entry: { url: string; file?: File } = { url };
  cache = entry;
  const fetchFile = deps.fetch ?? ((u: string) => fetch(u));
  void fetchFile(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // WebKit leaves a File's type empty unless it is given.
      entry.file = new File([blob], name, { type: blob.type });
      if (cache === entry) shareFile(entry.file, share, canShare);
    })
    .catch((err: unknown) => {
      if (cache === entry) cache = null;
      console.warn("[download] could not fetch the file", err);
    });
}

function shareFile(
  file: File,
  share: (data: ShareData) => Promise<void>,
  canShare: ((data: ShareData) => boolean) | undefined,
): void {
  const data: ShareData = { files: [file] };
  try {
    if (canShare && !canShare(data)) {
      console.warn("[download] the share sheet does not take this file");
      return;
    }
    share(data).catch(warnShareError);
  } catch (err) {
    warnShareError(err);
  }
}

// The member closing the sheet is no error.
function warnShareError(err: unknown): void {
  if (err instanceof DOMException && err.name === "AbortError") return;
  console.warn("[download] the share sheet failed", err);
}
