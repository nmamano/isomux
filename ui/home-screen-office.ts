// The way back to the office from an app page in the iPhone Home Screen
// office (task 79beacd9). The office writes the page it shows to this
// window's sessionStorage, and an app page that later opens in the same
// window links back to it. An app's own Home Screen install never shows the
// office, so it has no entry.

export const OFFICE_RETURN_KEY = "isomux:office-return";

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
  win: Pick<Window, "sessionStorage" | "location" | "addEventListener">,
): void {
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
