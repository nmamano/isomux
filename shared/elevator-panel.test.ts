// The elevator panel model (task 42be5397): what a ride carries and what each
// office keeps and shows. Pure: no DOM, no storage.
//
// What is pinned:
//   - Every url that arrives, from a fragment or from storage, passes
//     normaliseFloorUrl and must already be its own origin; times are clamped
//     to now; removals expire after REMOVAL_TTL_MS; every list has a cap.
//   - Merge: a visit never moves (the first visit after the last removal
//     wins), a removal hides older visits, a later visit brings an office
//     back, the newer snapshot of an office replaces the older one whole, and
//     the result does not depend on the order of the merges.
//   - Rule A: a snapshot lives only while its office is a visible visit.
//   - arrive: adds the departure office and this office, never bumps, and
//     writes this office's snapshot from its live floors over anything that
//     came in, even a forged future time.
//   - panelButtons: one list in every office, each office followed by its
//     floors; this office and its own floors are never hidden or cut.
//   - The fragment: round trip, only our key stripped, refusals, the size cap
//     and the drop order (snapshots, then removals, then visits).

import { describe, expect, it } from "bun:test";
import {
  MAX_PANEL_BUTTONS,
  MAX_PANEL_FRAGMENT_CHARS,
  MAX_PANEL_REMOVALS,
  MAX_SNAPSHOTS,
  PANEL_HASH_KEY,
  REMOVAL_TTL_MS,
  arrive,
  encodePanelFragment,
  mergePanels,
  panelButtons,
  readPanelFragment,
  removeFromPanel,
  sanitisePanel,
  type Panel,
  type PanelSnapshot,
} from "./elevator-panel.ts";
import { MAX_FLOORS, type Floor } from "./floors.ts";

// Well inside REMOVAL_TTL_MS of time 0, so the small times of the fixtures
// below never expire; the TTL test has a clock of its own.
const NOW = 1_000_000_000;
const A = "https://a.example.com";
const B = "https://b.example.com";
const C = "https://c.example.com";
const D = "https://d.example.com";
const E = "https://e.example.com";
const F1 = "https://f1.example.com";
const F2 = "https://f2.example.com";
const F3 = "https://f3.example.com";
const G1 = "https://g1.example.com";
const HERE = "http://here.example.org:4000";

const panel = (p: Partial<Panel> = {}): Panel => ({
  visited: p.visited ?? [],
  removed: p.removed ?? [],
  snapshots: p.snapshots ?? [],
});
const v = (url: string, addedAt: number) => ({ url, addedAt });
const r = (url: string, at: number) => ({ url, at });
const s = (origin: string, rev: number, floors: string[]): PanelSnapshot => ({
  origin,
  rev,
  floors,
});
const floor = (url: string, id = `id-${url}`): Floor => ({
  id,
  url,
  name: null,
  addedAt: 1,
});

// The panel with each list in a fixed order, so two panels compare by content.
function sorted(p: Panel): Panel {
  return {
    visited: [...p.visited].sort((x, y) => x.url.localeCompare(y.url)),
    removed: [...p.removed].sort((x, y) => x.url.localeCompare(y.url)),
    snapshots: [...p.snapshots].sort((x, y) =>
      x.origin.localeCompare(y.origin),
    ),
  };
}
const visitsSorted = (list: Panel["visited"]) =>
  sorted(panel({ visited: list })).visited;
const visitOf = (p: Panel, url: string) => p.visited.find((x) => x.url === url);
const snapshotOf = (p: Panel, origin: string) =>
  p.snapshots.find((x) => x.origin === origin);
const urls = (p: Panel, here: string, own: Floor[] = []) =>
  panelButtons(p, here, own).map((b) => b.url);

describe("sanitisePanel", () => {
  it("drops every url that is not already an http(s) origin, in each list", () => {
    const bad = [
      "javascript:alert(1)",
      "https://user:pw@x.example.com",
      "https://a.example.com/lobby",
      "a.example.com",
      "HTTPS://A.EXAMPLE.COM",
      "ftp://files.example.com",
      "",
      42,
      null,
    ];
    const raw = {
      visited: [v(A, 1), v(B, 2), ...bad.map((url) => ({ url, addedAt: 3 }))],
      removed: [r(C, 4), ...bad.map((url) => ({ url, at: 5 }))],
      snapshots: [
        s(A, 6, [F1, ...(bad as string[]), F2]),
        ...bad.map((origin) => ({ origin, rev: 7, floors: [F3] })),
      ],
    };
    expect(sorted(sanitisePanel(raw, NOW))).toEqual(
      sorted(
        panel({
          visited: [v(A, 1), v(B, 2)],
          removed: [r(C, 4)],
          snapshots: [s(A, 6, [F1, F2])],
        }),
      ),
    );
  });

  it("reads anything that is not a panel as an empty panel", () => {
    for (const raw of [
      null,
      undefined,
      "panel",
      42,
      [],
      { visited: "x", removed: 1, snapshots: null },
      { visited: [null, 1, "x"], removed: [[]], snapshots: [{ origin: A }] },
    ]) {
      expect(sanitisePanel(raw, NOW)).toEqual(panel());
    }
  });

  it("drops a time that is not a finite number or is negative, and clamps a future one to now", () => {
    const raw = {
      visited: [
        v(A, Number.NaN),
        v(B, Number.POSITIVE_INFINITY),
        v(C, -1),
        { url: D, addedAt: "5" },
        v(E, NOW + 1_000_000),
        v(F1, 10),
      ],
      removed: [r(F2, Number.NaN), r(F3, NOW + 5)],
      snapshots: [s(F1, NOW + 9, [G1])],
    };
    const out = sanitisePanel(raw, NOW);
    expect(sorted(out)).toEqual(
      sorted(
        panel({
          visited: [v(E, NOW), v(F1, 10)],
          removed: [r(F3, NOW)],
          snapshots: [s(F1, NOW, [G1])],
        }),
      ),
    );
  });

  it("forgets a removal after REMOVAL_TTL_MS, and the office it hid stays hidden only until then", () => {
    const later = 3 * REMOVAL_TTL_MS;
    const raw = panel({
      visited: [v(A, 1), v(B, 1)],
      removed: [
        r(A, later - REMOVAL_TTL_MS - 1),
        r(B, later - REMOVAL_TTL_MS + 1),
      ],
    });
    // A's removal is past the TTL: dropped. Its visit was older than the
    // removal, so a copy that still holds it brings A back: accepted.
    const out = sanitisePanel(raw, later);
    expect(out.removed).toEqual([r(B, later - REMOVAL_TTL_MS + 1)]);
    expect(visitOf(out, A)).toEqual(v(A, 1));
    expect(visitOf(out, B)).toBeUndefined();
  });

  it("collapses duplicates: the first visit, the latest removal, the newest snapshot whole", () => {
    const raw = panel({
      visited: [v(A, 9), v(A, 3), v(B, 4)],
      removed: [r(C, 2), r(C, 7)],
      snapshots: [s(A, 5, [F1, F2]), s(A, 8, [F3]), s(A, 6, [G1])],
    });
    expect(sorted(sanitisePanel(raw, NOW))).toEqual(
      sorted(
        panel({
          visited: [v(A, 3), v(B, 4)],
          removed: [r(C, 7)],
          snapshots: [s(A, 8, [F3])],
        }),
      ),
    );
  });

  it("keeps a visit only when it is not older than the latest removal, and keeps the removal", () => {
    // B: removed after its visit: hidden. A: visited after its removal:
    // shown, at the first visit after the removal. C: visited in the same
    // millisecond as its removal (a forged future removal clamped to the
    // arrival time): shown. Every removal stays, to travel.
    const raw = panel({
      visited: [v(A, 5), v(A, 20), v(A, 30), v(B, 5), v(C, 10)],
      removed: [r(A, 10), r(B, 10), r(C, 10)],
    });
    const out = sanitisePanel(raw, NOW);
    expect(sorted(out).visited).toEqual([v(A, 20), v(C, 10)]);
    expect(sorted(out).removed).toEqual([r(A, 10), r(B, 10), r(C, 10)]);
  });

  it("drops a snapshot whose office is not a visible visit (rule A)", () => {
    const raw = panel({
      visited: [v(A, 1), v(B, 1)],
      removed: [r(B, 2)],
      snapshots: [s(A, 3, [F1]), s(B, 3, [F2]), s(C, 3, [F3])],
    });
    // B is hidden, C was never visited (a crafted snapshot).
    expect(sanitisePanel(raw, NOW).snapshots).toEqual([s(A, 3, [F1])]);
  });

  it("caps visits, removals, snapshots and the floors of one snapshot, dropping the oldest", () => {
    const origin = (i: number) => `https://o${i}.example.com`;
    const n = (k: number) => Array.from({ length: k }, (_, i) => i);
    const raw = panel({
      visited: n(MAX_PANEL_BUTTONS + 5).map((i) => v(origin(i), i + 1)),
      removed: n(MAX_PANEL_REMOVALS + 5).map((i) =>
        r(`https://gone${i}.example.com`, i + 1),
      ),
      snapshots: n(MAX_SNAPSHOTS + 5).map((i) =>
        s(
          origin(MAX_PANEL_BUTTONS + 4 - i),
          1000 + i,
          i === 0
            ? n(MAX_FLOORS + 5).map((k) => `https://fl${k}.example.com`)
            : [],
        ),
      ),
    });
    const out = sanitisePanel(raw, NOW);
    expect(out.visited).toHaveLength(MAX_PANEL_BUTTONS);
    expect(visitOf(out, origin(4))).toBeUndefined();
    expect(visitOf(out, origin(5))).toBeDefined();
    expect(out.removed).toHaveLength(MAX_PANEL_REMOVALS);
    expect(out.removed.some((x) => x.at === 5)).toBe(false);
    expect(out.removed.some((x) => x.at === 6)).toBe(true);
    expect(out.snapshots).toHaveLength(MAX_SNAPSHOTS);
    // The oldest revs (1000..1004) are gone, the snapshot with the long floor
    // list among them; the newest stay.
    expect(Math.min(...out.snapshots.map((x) => x.rev))).toBe(1005);

    const one = sanitisePanel(
      panel({
        visited: [v(A, 1)],
        snapshots: [
          s(
            A,
            2,
            n(MAX_FLOORS + 5).map((k) => `https://fl${k}.example.com`),
          ),
        ],
      }),
      NOW,
    );
    expect(one.snapshots[0].floors).toHaveLength(MAX_FLOORS);
    expect(one.snapshots[0].floors[0]).toBe("https://fl0.example.com");
  });
});

describe("mergePanels", () => {
  it("never moves a visit: the earlier one wins", () => {
    const out = mergePanels(
      panel({ visited: [v(A, 5), v(B, 7)] }),
      panel({ visited: [v(A, 9), v(C, 8)] }),
      NOW,
    );
    expect(sorted(out).visited).toEqual(
      visitsSorted([v(A, 5), v(B, 7), v(C, 8)]),
    );
  });

  it("hides a visit older than a removal from the other copy, and shows one newer than it", () => {
    const out = mergePanels(
      panel({ visited: [v(A, 5), v(B, 5)] }),
      panel({ removed: [r(A, 10), r(B, 3)] }),
      NOW,
    );
    expect(visitOf(out, A)).toBeUndefined();
    expect(visitOf(out, B)).toEqual(v(B, 5));
    expect(urls(out, HERE)).not.toContain(A);
  });

  it("brings back an office visited again after its removal, whichever copy holds the old visit", () => {
    // Copy 1 saw A at 5 only. Copy 2 saw the removal at 10 and the visit at
    // 20. The visit at 5 must not hide the visit at 20.
    const old = panel({ visited: [v(A, 5)] });
    const again = panel({ visited: [v(A, 20)], removed: [r(A, 10)] });
    for (const out of [
      mergePanels(old, again, NOW),
      mergePanels(again, old, NOW),
      mergePanels(sanitisePanel(old, NOW), sanitisePanel(again, NOW), NOW),
    ]) {
      expect(visitOf(out, A)).toEqual(v(A, 20));
      expect(urls(out, HERE)).toContain(A);
    }
  });

  it("gives one panel whatever the order of the merges", () => {
    const copies = [
      panel({ visited: [v(A, 5), v(B, 6)], snapshots: [s(A, 5, [F1])] }),
      panel({
        visited: [v(A, 20), v(C, 21)],
        removed: [r(A, 10)],
        snapshots: [s(A, 20, [F2]), s(C, 21, [F3])],
      }),
      panel({ removed: [r(A, 10), r(B, 15)] }),
      panel({ visited: [v(D, 1)], removed: [r(C, 2)] }),
    ];
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ];
    // Each copy as an office keeps it: sanitised.
    const kept = copies.map((p) => sanitisePanel(p, NOW));
    const results = orders.map((order) =>
      sorted(
        order
          .map((i) => kept[i])
          .reduce((acc, p) => mergePanels(acc, p, NOW), panel()),
      ),
    );
    for (const out of results.slice(1)) expect(out).toEqual(results[0]);
    expect(visitOf(results[0], A)).toEqual(v(A, 20));
    expect(visitOf(results[0], B)).toBeUndefined();
    expect(snapshotOf(results[0], A)).toEqual(s(A, 20, [F2]));
  });

  it("replaces an office's snapshot whole with the newer rev", () => {
    const out = mergePanels(
      panel({ visited: [v(A, 1)], snapshots: [s(A, 5, [F1, F2])] }),
      panel({ visited: [v(A, 1)], snapshots: [s(A, 9, [F3])] }),
      NOW,
    );
    expect(out.snapshots).toEqual([s(A, 9, [F3])]);
  });

  it("drops a snapshot from before a removal, and takes one back only with a later visit (rule A)", () => {
    const removed = removeFromPanel(
      panel({ visited: [v(A, 1)], snapshots: [s(A, 2, [F1])] }),
      A,
      100,
    );
    expect(removed.snapshots).toEqual([]);
    // An old copy still carries A's snapshot: it stays gone, and so does A.
    const stale = panel({ visited: [v(A, 1)], snapshots: [s(A, 50, [F1])] });
    const merged = mergePanels(removed, stale, NOW);
    expect(merged.snapshots).toEqual([]);
    expect(urls(merged, HERE)).not.toContain(F1);
    // A copy that visited A after the removal brings A and its snapshot back.
    const back = mergePanels(
      merged,
      panel({ visited: [v(A, 200)], snapshots: [s(A, 200, [F2])] }),
      NOW,
    );
    expect(visitOf(back, A)).toEqual(v(A, 200));
    expect(back.snapshots).toEqual([s(A, 200, [F2])]);
  });

  it("clamps the times of both copies to now", () => {
    const out = mergePanels(
      panel({ visited: [v(A, NOW + 50)] }),
      panel({ removed: [r(B, NOW + 50)] }),
      NOW,
    );
    expect(out.visited).toEqual([v(A, NOW)]);
    expect(out.removed).toEqual([r(B, NOW)]);
  });
});

describe("arrive", () => {
  it("adds the departure office and this office, and writes this office's snapshot", () => {
    const out = arrive(panel(), {
      from: A,
      here: HERE,
      ownFloors: [F1, F2],
      now: NOW,
    });
    expect(sorted(out).visited).toEqual(
      visitsSorted([v(A, NOW), v(HERE, NOW)]),
    );
    expect(out.snapshots).toEqual([s(HERE, NOW, [F1, F2])]);
  });

  it("never bumps an office that is there, and re-adds one that was removed", () => {
    const out = arrive(
      panel({
        visited: [v(A, 5), v(HERE, 6)],
        removed: [r(B, 10)],
      }),
      { from: B, here: HERE, ownFloors: [], now: NOW },
    );
    expect(sorted(out).visited).toEqual(
      visitsSorted([v(A, 5), v(B, NOW), v(HERE, 6)]),
    );
    // B's removal stays, to travel: a copy that holds B's old visit must not
    // bring the old place back.
    expect(out.removed).toEqual([r(B, 10)]);
  });

  it("keeps the floors this office has now, even over a snapshot of it with a forged future rev", () => {
    const forged = sanitisePanel(
      panel({
        visited: [v(HERE, 1)],
        snapshots: [s(HERE, NOW + 99_999, [E])],
      }),
      NOW,
    );
    const out = arrive(forged, {
      from: null,
      here: HERE,
      ownFloors: [G1],
      now: NOW,
    });
    expect(snapshotOf(out, HERE)).toEqual(s(HERE, NOW, [G1]));
  });

  it("shows this office and the departure office after a forged future removal of both", () => {
    const forged = sanitisePanel(
      panel({
        visited: [v(HERE, 1), v(A, 1)],
        removed: [r(HERE, NOW + 99_999), r(A, NOW + 99_999)],
      }),
      NOW,
    );
    const out = arrive(forged, {
      from: A,
      here: HERE,
      ownFloors: [G1],
      now: NOW,
    });
    expect(visitOf(out, HERE)).toBeDefined();
    expect(visitOf(out, A)).toBeDefined();
    expect(snapshotOf(out, HERE)).toEqual(s(HERE, NOW, [G1]));
    // The ride onward carries both, so the next office shows them too.
    const next = arrive(
      sanitisePanel(
        readPanelFragment(encodePanelFragment(out, HERE))!.panel,
        NOW + 1,
      ),
      { from: HERE, here: B, ownFloors: [], now: NOW + 1 },
    );
    expect(urls(next, B)).toEqual(expect.arrayContaining([HERE, A, G1, B]));
  });

  it("with no departure office (floors_updated) adds only this office", () => {
    const out = arrive(panel(), {
      from: null,
      here: HERE,
      ownFloors: [F1],
      now: NOW,
    });
    expect(out.visited).toEqual([v(HERE, NOW)]);
  });
});

describe("panelButtons", () => {
  // A was visited first, then B, then this office (C), then D. Each visited
  // office is followed by its floors; this office by its live floors, never
  // by the stale snapshot of itself.
  const trip = panel({
    visited: [v(A, 1), v(B, 2), v(C, 3), v(D, 4)],
    snapshots: [
      s(A, 1, [F1, F2]),
      s(B, 2, [F3]),
      s(C, 3, ["https://stale.example.com"]),
      s(D, 4, []),
    ],
  });

  it("lists each visited office in visit order, each followed by its floors", () => {
    const buttons = panelButtons(trip, C, [floor(G1)]);
    expect(buttons.map((b) => [b.url, b.kind])).toEqual([
      [A, "visited"],
      [F1, "snapshot"],
      [F2, "snapshot"],
      [B, "visited"],
      [F3, "snapshot"],
      [C, "here"],
      [G1, "floor"],
      [D, "visited"],
    ]);
    expect(buttons[6].floor).toEqual(floor(G1));
  });

  it("is the same list in every office the panel rode through", () => {
    // In office A, A's floors are live and C's come from C's snapshot.
    const atA = mergePanels(
      trip,
      panel({ visited: [v(C, 3)], snapshots: [s(C, 5, [G1])] }),
      NOW,
    );
    expect(urls(atA, A, [floor(F1), floor(F2)])).toEqual(
      urls(trip, C, [floor(G1)]),
    );
  });

  it("orders visits made at the same time by url", () => {
    const p = panel({ visited: [v(E, 2), v(B, 2), v(A, 1)] });
    expect(urls(p, A)).toEqual([A, B, E]);
  });

  it("shows an office once, at its first place, as this office's floor when it is one", () => {
    const p = panel({
      visited: [v(G1, 1), v(A, 2), v(C, 3)],
      snapshots: [s(A, 2, [G1, F1])],
    });
    const buttons = panelButtons(p, C, [floor(G1)]);
    expect(buttons.map((b) => b.url)).toEqual([G1, A, F1, C]);
    expect(buttons[0].kind).toBe("floor");
    expect(buttons[0].floor?.id).toBe(`id-${G1}`);
  });

  it("hides a removed office and its floors, and a removed floor of another office", () => {
    const p = sanitisePanel(
      panel({
        visited: [v(A, 1), v(B, 2), v(C, 3)],
        removed: [r(B, 5), r(F1, 5)],
        snapshots: [s(A, 1, [F1, F2]), s(B, 2, [F3])],
      }),
      NOW,
    );
    expect(urls(p, C)).toEqual([A, F2, C]);
  });

  it("never hides this office or its own floors, removed or not visited", () => {
    const p = panel({
      visited: [v(A, 1)],
      removed: [r(C, 5), r(G1, 5)],
    });
    const buttons = panelButtons(p, C, [floor(G1)]);
    expect(buttons.map((b) => [b.url, b.kind])).toEqual([
      [A, "visited"],
      [C, "here"],
      [G1, "floor"],
    ]);
  });

  it("caps the list at MAX_PANEL_BUTTONS, and the cap never drops this office or its floors", () => {
    const many = Array.from({ length: MAX_PANEL_BUTTONS }, (_, i) =>
      v(`https://o${i}.example.com`, i + 1),
    );
    const p = panel({ visited: [...many, v(C, MAX_PANEL_BUTTONS + 5)] });
    const buttons = panelButtons(p, C, [floor(G1)]);
    expect(buttons).toHaveLength(MAX_PANEL_BUTTONS);
    expect(buttons.find((b) => b.url === C)?.kind).toBe("here");
    expect(buttons.find((b) => b.url === G1)?.kind).toBe("floor");
  });
});

describe("the ride fragment", () => {
  const sample = panel({
    visited: [v(A, 1), v(B, 2), v(HERE, 3)],
    removed: [r(C, 4)],
    snapshots: [s(A, 1, [F1]), s(HERE, 3, [G1])],
  });

  it("carries the panel and the departure office in our key, and reads back as the same panel", () => {
    const fragment = encodePanelFragment(sample, HERE);
    expect(fragment.startsWith(`${PANEL_HASH_KEY}=`)).toBe(true);
    expect(fragment).toMatch(/^[A-Za-z0-9_=-]+$/);
    const read = readPanelFragment(`#${fragment}`);
    expect(read?.from).toBe(HERE);
    expect(read?.rest).toBe("");
    expect(sorted(sanitisePanel(read?.panel, NOW))).toEqual(
      sorted(sanitisePanel(sample, NOW)),
    );
    // With or without the "#".
    expect(readPanelFragment(fragment)?.from).toBe(HERE);
  });

  it("strips only our key and keeps the rest of the hash", () => {
    const fragment = encodePanelFragment(sample, HERE);
    expect(readPanelFragment(`#foo=1&${fragment}&bar`)?.rest).toBe("foo=1&bar");
    expect(readPanelFragment(`#${fragment}&bar`)?.rest).toBe("bar");
    expect(readPanelFragment("#foo=1&bar")).toBeNull();
    expect(readPanelFragment("")).toBeNull();
  });

  it("strips every part under our key, and reads the first", () => {
    // A crafted link with two panels must not leave one in the address bar,
    // to be read again at the next reload.
    const first = encodePanelFragment(sample, HERE);
    const second = encodePanelFragment(panel({ visited: [v(E, 1)] }), E);
    const read = readPanelFragment(`#${first}&x=1&${second}`);
    expect(read?.from).toBe(HERE);
    expect(read?.rest).toBe("x=1");
  });

  it("refuses a value that is too long, not base64url JSON, or of another version, and still strips it", () => {
    const b64 = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const good = {
      v: 1,
      from: HERE,
      visited: [v(A, 1)],
      removed: [],
      snapshots: [],
    };
    expect(
      readPanelFragment(`#${PANEL_HASH_KEY}=${b64(good)}`)?.panel,
    ).not.toBeNull();
    // A valid panel that is too long: refused for its length alone.
    const long = b64({
      ...good,
      visited: Array.from({ length: 300 }, (_, i) =>
        v(`https://o${i}.example.com`, i + 1),
      ),
    });
    expect(long.length).toBeGreaterThan(MAX_PANEL_FRAGMENT_CHARS);
    for (const value of [
      long,
      "%%%not-base64%%%",
      b64("just a string"),
      Buffer.from("{not json").toString("base64url"),
      b64({ ...good, v: 2 }),
    ]) {
      const read = readPanelFragment(`#keep=1&${PANEL_HASH_KEY}=${value}`);
      expect(read).not.toBeNull();
      expect(read?.panel).toBeNull();
      expect(read?.rest).toBe("keep=1");
    }
  });

  it("reads a departure office that is not an origin as none", () => {
    const b64 = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const read = readPanelFragment(
      `#${PANEL_HASH_KEY}=${b64({ v: 1, from: "javascript:alert(1)", visited: [], removed: [], snapshots: [] })}`,
    );
    expect(read?.from).toBeNull();
  });

  describe("over the size cap", () => {
    const host = (tag: string, i: number) =>
      `https://${"x".repeat(50)}-${tag}${i}.example.com`;
    const n = (k: number) => Array.from({ length: k }, (_, i) => i);
    const decode = (p: Panel) => {
      const fragment = encodePanelFragment(p, HERE);
      expect(fragment.length).toBeLessThanOrEqual(MAX_PANEL_FRAGMENT_CHARS);
      expect(encodePanelFragment(p, HERE)).toBe(fragment);
      return sanitisePanel(readPanelFragment(fragment)!.panel, NOW);
    };

    it("drops the oldest snapshots whole first, and keeps every removal and visit", () => {
      const offices = n(MAX_SNAPSHOTS).map((i) => host("o", i));
      const p = panel({
        visited: offices.map((o, i) => v(o, i + 1)),
        removed: n(5).map((i) => r(host("gone", i), i + 1)),
        snapshots: offices.map((o, i) =>
          s(
            o,
            100 + i,
            n(10).map((k) => host(`f${i}-`, k)),
          ),
        ),
      });
      const out = decode(p);
      expect(out.visited).toHaveLength(MAX_SNAPSHOTS);
      expect(out.removed).toHaveLength(5);
      expect(out.snapshots.length).toBeGreaterThan(0);
      expect(out.snapshots.length).toBeLessThan(MAX_SNAPSHOTS);
      // The kept snapshots are the newest, each whole.
      const kept = out.snapshots.map((x) => x.rev).sort((a, b) => a - b);
      expect(kept[kept.length - 1]).toBe(100 + MAX_SNAPSHOTS - 1);
      expect(kept).toEqual(
        n(kept.length).map((i) => 100 + MAX_SNAPSHOTS - kept.length + i),
      );
      for (const snap of out.snapshots) expect(snap.floors).toHaveLength(10);
    });

    it("then drops the oldest removals, and keeps every visit", () => {
      const p = panel({
        visited: n(10).map((i) => v(host("o", i), i + 1)),
        removed: n(MAX_PANEL_REMOVALS).map((i) => r(host("gone", i), i + 1)),
      });
      const out = decode(p);
      expect(out.visited).toHaveLength(10);
      expect(out.removed.length).toBeGreaterThan(0);
      expect(out.removed.length).toBeLessThan(MAX_PANEL_REMOVALS);
      const kept = out.removed.map((x) => x.at).sort((a, b) => a - b);
      expect(kept[kept.length - 1]).toBe(MAX_PANEL_REMOVALS);
      expect(kept[0]).toBe(MAX_PANEL_REMOVALS - kept.length + 1);
    });

    it("drops the oldest visits only when nothing else is left", () => {
      const p = panel({
        visited: n(MAX_PANEL_BUTTONS).map((i) => v(host("o", i), i + 1)),
      });
      const out = decode(p);
      expect(out.visited.length).toBeGreaterThan(0);
      expect(out.visited.length).toBeLessThan(MAX_PANEL_BUTTONS);
      const kept = out.visited.map((x) => x.addedAt).sort((a, b) => a - b);
      expect(kept[kept.length - 1]).toBe(MAX_PANEL_BUTTONS);
      expect(kept[0]).toBe(MAX_PANEL_BUTTONS - kept.length + 1);
    });
  });
});
