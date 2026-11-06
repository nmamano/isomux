// An in-memory pager archive and a store that uses it unless a test passes
// its own archive. Production always passes the file archive.

import {
  createPagerStore,
  type PagerArchive,
  type PagerMoveIntent,
  type PagerStore,
  type PagerStoreDeps,
} from "../pager-store.ts";
import { pagerPageItem, type PageItemSource } from "../page-items.ts";
import type { PagerEntry } from "../../shared/types.ts";

// `lines` is the file's content, oldest first (its size counts lines), and a
// test may push a raw line into it. `tornNextAppend` models an append that
// wrote part of its batch, cut the last line short, and then threw.
export function createMemoryPagerArchive() {
  const a = {
    lines: [] as string[],
    appends: 0,
    failNextAppend: false,
    tornNextAppend: false,
    intent: null as PagerMoveIntent | null | "corrupt",
    size: () => a.lines.length,
    append(entries: PagerEntry[]) {
      if (a.failNextAppend) {
        a.failNextAppend = false;
        throw new Error("disk full");
      }
      const lines = entries.map((e) => JSON.stringify(e));
      if (a.tornNextAppend) {
        a.tornNextAppend = false;
        a.lines.push(...lines.slice(0, -1), lines.at(-1)!.slice(0, 20));
        throw new Error("fsync failed");
      }
      a.appends++;
      a.lines.push(...lines);
    },
    truncate(to: number) {
      a.lines.length = to;
    },
    newestLines: () => a.lines.slice().reverse(),
    readIntent: () => a.intent,
    writeIntent(intent: PagerMoveIntent) {
      a.intent = structuredClone(intent);
    },
    clearIntent() {
      a.intent = null;
    },
    async *scan() {
      const snapshot = a.lines.slice();
      for (let i = snapshot.length - 1; i >= 0; i--) {
        await Promise.resolve();
        yield snapshot[i];
      }
    },
  };
  return a satisfies PagerArchive;
}

export function createTestPagerStore(
  deps: Omit<PagerStoreDeps, "archive"> & { archive?: PagerArchive },
) {
  return createPagerStore({ archive: createMemoryPagerArchive(), ...deps });
}

// A pager store as the delivery engines read it: every page as a page item
// (server/page-items.ts), with no paged asks.
export function pageItemsOf(
  store: Pick<PagerStore, "list" | "get" | "recordDelivery">,
): Pick<PageItemSource, "list" | "get" | "recordDelivery"> {
  const item = (entry: PagerEntry | null) =>
    entry ? pagerPageItem(entry) : null;
  return {
    list: () => store.list().map(pagerPageItem),
    get: (id) => item(store.get(id)),
    recordDelivery: (id, delivery) => item(store.recordDelivery(id, delivery)),
  };
}
