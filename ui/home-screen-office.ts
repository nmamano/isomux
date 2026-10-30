// The way back to the office from an app page in the iPhone Home Screen
// office (task 79beacd9). The office writes the page it shows to this
// window's sessionStorage, and an app page that later opens in the same
// window links back to it, or to the office home when only the localStorage
// mark below is there. An app's own Home Screen install never shows the
// office, so it has no entry.

export const OFFICE_RETURN_KEY = "isomux:office-return";

// The office also marks the localStorage of its window. On iOS each Home
// Screen web app has its own storage, and adding an app to the Home Screen
// copies cookies, never localStorage: the mark is on every page of the
// office's window and never in an app's own Home Screen app. sessionStorage
// alone does not reach an app page that iOS opens from a target="_blank" link
// as a new page (Nil, 2026-10-30). Elsewhere an installed app shares the
// browser's storage, so only iOS reads the mark.
export const OFFICE_WINDOW_KEY = "isomux:office-window";

// Any origin will do: a stored value is only accepted when it stays on it.
const BASE = "https://office.invalid";

export function rememberOfficePage(
  storage: Pick<Storage, "setItem">,
  location: Pick<Location, "pathname" | "search" | "hash">,
): void {
  try {
    storage.setItem(
      OFFICE_RETURN_KEY,
      location.pathname + location.search + location.hash,
    );
  } catch {
    // Storage off or full: the app page shows no way back.
  }
}

// Called once by the office page: its page now, and the page it leaves.
export function trackOfficePage(
  win: Pick<
    Window,
    "sessionStorage" | "localStorage" | "location" | "addEventListener"
  >,
): void {
  try {
    win.localStorage.setItem(OFFICE_WINDOW_KEY, "1");
  } catch {
    // Storage off or full: an app page in this window may not know it.
  }
  const remember = () => {
    let storage: Storage;
    try {
      storage = win.sessionStorage;
    } catch {
      return;
    }
    rememberOfficePage(storage, win.location);
  };
  remember();
  win.addEventListener("pagehide", remember);
}

// The stored office page, only when it is a path on this origin. The URL
// parser removes tabs and newlines, so "/\t/host" is a link to another host:
// the parse decides, not a prefix check.
export function officeReturnHref(
  storage: Pick<Storage, "getItem">,
): string | null {
  let stored: string | null;
  try {
    stored = storage.getItem(OFFICE_RETURN_KEY);
  } catch {
    return null;
  }
  if (stored === null || !stored.startsWith("/")) return null;
  try {
    if (new URL(stored, BASE).origin !== BASE) return null;
  } catch {
    return null;
  }
  return stored;
}

// On iOS: the stored office page, or the office home when this Home Screen
// app ran the office but this page has no stored page. null in an app's own
// Home Screen app.
export function homeScreenOfficeReturn(
  session: Pick<Storage, "getItem">,
  local: Pick<Storage, "getItem">,
): string | null {
  const stored = officeReturnHref(session);
  if (stored !== null) return stored;
  try {
    return local.getItem(OFFICE_WINDOW_KEY) !== null ? "/" : null;
  } catch {
    return null;
  }
}
