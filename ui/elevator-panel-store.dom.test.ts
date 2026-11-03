// The elevator panel in this browser (task 42be5397): the panel a ride
// brought in the address or through the login page, this office's
// localStorage copy, and the names this browser asked its server for.
//
// What is pinned:
//   - takeArrivingPanel reads the isomux-panel part of the address, strips
//     only that part (also when it is refused), keeps the path, the query and
//     the rest of the hash, and merges the login page's sessionStorage copy,
//     which it deletes.
//   - The stored panel passes the same sanitising as a fragment: a url that is
//     not an origin is dropped, a damaged copy reads as an empty panel.
//   - commitPanel writes what its function returns, from the stored panel.
//   - The name cache keeps only the origins still on the panel, and drops a
//     damaged entry.
//   - The glue: holdArrivingPanel keeps the arriving panel until syncPanel
//     (full_state, floors_updated) merges it once and writes this office's
//     snapshot; rideFragment carries this office and its live floors even
//     before the first sync.

import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const {
  PANEL_NAMES_STORAGE_KEY,
  PANEL_STORAGE_KEY,
  commitPanel,
  holdArrivingPanel,
  readNames,
  readPanel,
  rememberName,
  rideFragment,
  syncPanel,
  takeArrivingPanel,
} = await import("./elevator-panel-store.ts");
const {
  MAX_PANEL_FRAGMENT_CHARS,
  PANEL_HASH_KEY,
  PANEL_SESSION_KEY,
  encodePanelFragment,
  panelButtons,
  readPanelFragment,
  removeFromPanel,
  sanitisePanel,
} = await import("../shared/elevator-panel.ts");
const { MAX_FLOOR_NAME_CHARS } = await import("../shared/floors.ts");

import type { Panel } from "../shared/elevator-panel.ts";

const NOW = 1_800_000_000_000;
const A = "https://a.example.com";
const B = "https://b.example.com";
const C = "https://c.example.com";

const panel = (p: Partial<Panel> = {}): Panel => ({
  visited: p.visited ?? [],
  removed: p.removed ?? [],
  snapshots: p.snapshots ?? [],
});
// A valid panel part, refused for its length alone.
function tooLong(): string {
  const body = {
    v: 1,
    from: A,
    visited: Array.from({ length: 300 }, (_, i) => ({
      url: `https://o${i}.example.com`,
      addedAt: i + 1,
    })),
    removed: [],
    snapshots: [],
  };
  const part = `${PANEL_HASH_KEY}=${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  expect(part.length).toBeGreaterThan(MAX_PANEL_FRAGMENT_CHARS);
  return part;
}
const visited = (p: Panel | undefined) =>
  (p?.visited ?? []).map((x) => x.url).sort();

afterEach(() => {
  // A panel a test held and never synced must not reach the next test.
  syncPanel([], "https://drain.example.com", NOW);
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("takeArrivingPanel", () => {
  it("takes the panel a ride brought, and strips only its part of the address", () => {
    const fragment = encodePanelFragment(
      panel({ visited: [{ url: A, addedAt: 1 }] }),
      A,
    );
    history.replaceState(null, "", `/lobby?x=1#foo=1&${fragment}&bar`);
    const got = takeArrivingPanel(NOW);
    expect(got?.from).toBe(A);
    expect(visited(got?.panel)).toEqual([A]);
    expect(location.pathname).toBe("/lobby");
    expect(location.search).toBe("?x=1");
    expect(location.hash).toBe("#foo=1&bar");
    // Taken once.
    expect(takeArrivingPanel(NOW)).toBeNull();
    expect(location.hash).toBe("#foo=1&bar");
  });

  it("leaves no empty hash behind when the panel was all of it", () => {
    const fragment = encodePanelFragment(panel(), A);
    history.replaceState(null, "", `/lobby?x=1#${fragment}`);
    takeArrivingPanel(NOW);
    expect(location.href).toBe(`${location.origin}/lobby?x=1`);
  });

  it("strips a refused part all the same, and takes nothing from it", () => {
    history.replaceState(null, "", `/#keep=1&${tooLong()}`);
    const got = takeArrivingPanel(NOW);
    expect(visited(got?.panel)).toEqual([]);
    expect(location.hash).toBe("#keep=1");
  });

  it("merges the copy the login page kept, deletes it, and takes the departure office from the address", () => {
    sessionStorage.setItem(
      PANEL_SESSION_KEY,
      encodePanelFragment(panel({ visited: [{ url: B, addedAt: 2 }] }), B),
    );
    const fragment = encodePanelFragment(
      panel({ visited: [{ url: A, addedAt: 1 }] }),
      A,
    );
    history.replaceState(null, "", `/#${fragment}`);
    const got = takeArrivingPanel(NOW);
    expect(visited(got?.panel)).toEqual([A, B]);
    expect(got?.from).toBe(A);
    expect(sessionStorage.getItem(PANEL_SESSION_KEY)).toBeNull();
  });

  it("takes the login page's copy alone after a sign-in, and ignores a copy that is too long", () => {
    sessionStorage.setItem(
      PANEL_SESSION_KEY,
      encodePanelFragment(panel({ visited: [{ url: B, addedAt: 2 }] }), B),
    );
    const got = takeArrivingPanel(NOW);
    expect(got?.from).toBe(B);
    expect(visited(got?.panel)).toEqual([B]);
    expect(sessionStorage.getItem(PANEL_SESSION_KEY)).toBeNull();

    sessionStorage.setItem(PANEL_SESSION_KEY, tooLong());
    expect(visited(takeArrivingPanel(NOW)?.panel)).toEqual([]);
    expect(sessionStorage.getItem(PANEL_SESSION_KEY)).toBeNull();
  });
});

describe("the stored panel", () => {
  it("drops every url that is not an origin, as for a ride", () => {
    localStorage.setItem(
      PANEL_STORAGE_KEY,
      JSON.stringify({
        visited: [
          { url: "javascript:alert(1)", addedAt: 1 },
          { url: `${A}/lobby`, addedAt: 1 },
          { url: A, addedAt: 2 },
        ],
        removed: [{ url: "https://user:pw@b.example.com", at: 3 }],
        snapshots: [{ origin: A, rev: 2, floors: ["data:text/html,x", C] }],
      }),
    );
    expect(readPanel(NOW)).toEqual(
      panel({
        visited: [{ url: A, addedAt: 2 }],
        snapshots: [{ origin: A, rev: 2, floors: [C] }],
      }),
    );
  });

  it("reads a damaged copy as an empty panel, and a commit replaces it", () => {
    localStorage.setItem(PANEL_STORAGE_KEY, "{not json");
    expect(readPanel(NOW)).toEqual(panel());
    const seen: Panel[] = [];
    const written = commitPanel((p) => {
      seen.push(p);
      return panel({ visited: [{ url: A, addedAt: 1 }] });
    }, NOW);
    expect(seen).toEqual([panel()]);
    expect(visited(written)).toEqual([A]);
    expect(visited(readPanel(NOW))).toEqual([A]);
  });

  it("gives each commit the panel the one before wrote", () => {
    commitPanel(() => panel({ visited: [{ url: A, addedAt: 1 }] }), NOW);
    const written = commitPanel(
      (p) => ({ ...p, visited: [...p.visited, { url: B, addedAt: 2 }] }),
      NOW,
    );
    expect(visited(written)).toEqual([A, B]);
    expect(visited(readPanel(NOW))).toEqual([A, B]);
  });
});

describe("the name cache", () => {
  it("keeps a name or a failed lookup with its time, only for origins still on the panel", () => {
    rememberName(A, "Atlas", [A, B], NOW);
    rememberName(B, null, [A, B], NOW + 1);
    expect(readNames()).toEqual({
      [A]: { name: "Atlas", at: NOW },
      [B]: { name: null, at: NOW + 1 },
    });
    rememberName(C, "Cove", [A, C], NOW + 2);
    expect(Object.keys(readNames()).sort()).toEqual([A, C]);
  });

  it("drops a damaged entry, and reads a damaged store as empty", () => {
    localStorage.setItem(
      PANEL_NAMES_STORAGE_KEY,
      JSON.stringify({
        [A]: { name: "Atlas", at: 1 },
        [B]: { name: 5, at: 1 },
        [C]: { name: "y".repeat(MAX_FLOOR_NAME_CHARS * 4), at: 1 },
        "javascript:alert(1)": { name: "x", at: 1 },
        "https://d.example.com": { name: "Dock", at: "soon" },
      }),
    );
    const names = readNames();
    expect(names[A]).toEqual({ name: "Atlas", at: 1 });
    expect(names[B]).toBeUndefined();
    expect((names[C]?.name ?? "").length).toBeLessThanOrEqual(
      MAX_FLOOR_NAME_CHARS,
    );
    expect(names["javascript:alert(1)"]).toBeUndefined();
    expect(names["https://d.example.com"]).toBeUndefined();
    localStorage.setItem(PANEL_NAMES_STORAGE_KEY, "[1,2");
    expect(readNames()).toEqual({});
  });
});

describe("the glue", () => {
  const HERE = "http://here.example.org:4000";
  const floor = (url: string) => ({
    id: `id-${url}`,
    url,
    name: null,
    addedAt: 1,
  });

  it("holds the arriving panel until this office's floors arrive, then merges it once", () => {
    const fragment = encodePanelFragment(
      panel({ visited: [{ url: B, addedAt: 1 }] }),
      A,
    );
    history.replaceState(null, "", `/#${fragment}`);
    holdArrivingPanel(NOW);
    expect(location.hash).toBe("");
    expect(readPanel(NOW)).toEqual(panel());

    syncPanel([floor(C)], HERE, NOW);
    const first = readPanel(NOW);
    expect(visited(first)).toEqual([A, B, HERE].sort());
    expect(first.snapshots).toEqual([{ origin: HERE, rev: NOW, floors: [C] }]);

    // The member removes the office they came from; the next floors_updated
    // must not bring it back.
    commitPanel((p) => removeFromPanel(p, A, NOW + 1), NOW + 1);
    syncPanel([], HERE, NOW + 2);
    const later = readPanel(NOW + 2);
    expect(visited(later)).toEqual([B, HERE].sort());
    expect(later.snapshots).toEqual([
      { origin: HERE, rev: NOW + 2, floors: [] },
    ]);
  });

  it("carries this office and its live floors on a ride, even before the first sync", () => {
    const fragment = rideFragment(HERE, [floor(C)], NOW);
    const read = readPanelFragment(fragment);
    expect(read?.from).toBe(HERE);
    const carried = sanitisePanel(read?.panel, NOW);
    expect(visited(carried)).toEqual([HERE]);
    expect(panelButtons(carried, B, []).map((b) => b.url)).toEqual([
      HERE,
      C,
      B,
    ]);
  });
});
