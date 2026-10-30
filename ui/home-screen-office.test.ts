// The way back to the office from an app page in the iPhone Home Screen
// office (ui/home-screen-office.ts, task 79beacd9).
//
// Pins: the office stores the page it shows (path, query and hash), and the
// app page links back only to a path on its own origin. The stored value is a
// link target, so anything that a browser could read as another host or a
// script must give no link. A storage that throws (private mode, a blocked
// storage) gives no link and does not break the page.
//
// Pure T0: no DOM, no server, no LLM.

import { describe, expect, it } from "bun:test";
import {
  OFFICE_RETURN_KEY,
  OFFICE_WINDOW_KEY,
  homeScreenOfficeReturn,
  officeReturnHref,
  rememberOfficePage,
  trackOfficePage,
} from "./home-screen-office.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

const throwing = {
  getItem: (): string | null => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: (): void => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("rememberOfficePage", () => {
  it("stores the path, query and hash of the office page", () => {
    const storage = memoryStorage();
    rememberOfficePage(storage, {
      pathname: "/agents/agent-1",
      search: "?pager=abc",
      hash: "#end",
    });
    expect(storage.items.get(OFFICE_RETURN_KEY)).toBe(
      "/agents/agent-1?pager=abc#end",
    );
    // A later page replaces the earlier one.
    rememberOfficePage(storage, { pathname: "/apps", search: "", hash: "" });
    expect(storage.items.get(OFFICE_RETURN_KEY)).toBe("/apps");
    expect(officeReturnHref(storage)).toBe("/apps");
  });

  it("does not throw when the storage refuses the write", () => {
    rememberOfficePage(throwing, { pathname: "/apps", search: "", hash: "" });
  });
});

// ui/index.tsx calls this once on the office page. pagehide fires when the
// member taps an app link: the stored page is then the one they left from,
// not the one the office opened on.
describe("trackOfficePage", () => {
  function fakeWindow(storage: () => Storage, local: () => Storage = storage) {
    const listeners = new Map<string, (() => void)[]>();
    const win = {
      location: { pathname: "/", search: "", hash: "" } as Location,
      get sessionStorage() {
        return storage();
      },
      get localStorage() {
        return local();
      },
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    } as unknown as Window;
    const fire = (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    };
    return { win, fire, listeners };
  }

  it("stores the office page now and again when the member leaves it", () => {
    const storage = memoryStorage();
    const { win, fire } = fakeWindow(() => storage as unknown as Storage);
    win.location.pathname = "/apps";
    trackOfficePage(win);
    expect(storage.items.get(OFFICE_RETURN_KEY)).toBe("/apps");
    // The office routes in place: by the time the member taps an app link,
    // it shows another page.
    win.location.pathname = "/agents/one";
    win.location.search = "?x=1";
    expect(storage.items.get(OFFICE_RETURN_KEY)).toBe("/apps");
    fire("pagehide");
    expect(storage.items.get(OFFICE_RETURN_KEY)).toBe("/agents/one?x=1");
  });

  it("marks the window's localStorage as the office's", () => {
    const session = memoryStorage();
    const local = memoryStorage();
    const { win } = fakeWindow(
      () => session as unknown as Storage,
      () => local as unknown as Storage,
    );
    trackOfficePage(win);
    expect(local.items.has(OFFICE_WINDOW_KEY)).toBe(true);
    expect(session.items.has(OFFICE_WINDOW_KEY)).toBe(false);
  });

  // Reading window.sessionStorage throws where storage is blocked.
  it("does not throw when the window has no storage", () => {
    let reads = 0;
    const { win, fire, listeners } = fakeWindow(() => {
      reads++;
      throw new DOMException("blocked", "SecurityError");
    });
    trackOfficePage(win);
    fire("pagehide");
    expect(listeners.get("pagehide")).toHaveLength(1);
    // The mark, the page now and the page it leaves.
    expect(reads).toBe(3);
  });
});

describe("officeReturnHref", () => {
  it("returns a stored office path as it is", () => {
    for (const path of [
      "/",
      "/apps",
      "/apps?x=1#y",
      "/agents/agent-1",
      "/inbox/asks?ask=a%20b",
    ])
      expect(
        officeReturnHref(memoryStorage({ [OFFICE_RETURN_KEY]: path })),
      ).toBe(path);
  });

  it("gives no link when nothing is stored", () => {
    expect(officeReturnHref(memoryStorage())).toBeNull();
  });

  // A browser strips tab and newline anywhere in a URL, so "/\t/host" is
  // "//host": a link to another host.
  it("gives no link for a value that leaves the office origin or is no path", () => {
    for (const value of [
      "",
      "apps",
      "//evil.example/",
      "/\\evil.example/",
      "\\\\evil.example/",
      "/\t/evil.example/",
      "/\n/evil.example/",
      " //evil.example/",
      "https://evil.example/",
      "javascript:alert(1)",
      "data:text/html,x",
    ])
      expect(
        officeReturnHref(memoryStorage({ [OFFICE_RETURN_KEY]: value })),
      ).toBeNull();
  });

  it("gives no link when the storage throws", () => {
    expect(officeReturnHref(throwing)).toBeNull();
  });
});

// Nil, 2026-10-30: an app page that iOS opened as a new page in the Home
// Screen office had an empty sessionStorage, so it showed no install entry
// and no Back link. The office's localStorage mark still says where it runs.
describe("homeScreenOfficeReturn", () => {
  const marked = () => memoryStorage({ [OFFICE_WINDOW_KEY]: "1" });
  it("prefers the stored office page", () => {
    expect(
      homeScreenOfficeReturn(
        memoryStorage({ [OFFICE_RETURN_KEY]: "/apps" }),
        marked(),
      ),
    ).toBe("/apps");
  });

  it("goes to the office home when only the mark is there", () => {
    expect(homeScreenOfficeReturn(memoryStorage(), marked())).toBe("/");
    // A stored value that is no office path does not hide the mark.
    expect(
      homeScreenOfficeReturn(
        memoryStorage({ [OFFICE_RETURN_KEY]: "//evil.example/" }),
        marked(),
      ),
    ).toBe("/");
  });

  it("gives nothing in an app's own Home Screen app, or when storage throws", () => {
    expect(homeScreenOfficeReturn(memoryStorage(), memoryStorage())).toBeNull();
    expect(homeScreenOfficeReturn(throwing, throwing)).toBeNull();
  });
});
