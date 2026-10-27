// The script a framed app page gets (task d7ac4f73), run in a bare context
// with only the browser globals listed in `page` below: it tells the office
// wrapper which page the member sees, and reloads in place when the wrapper
// asks. The proxy's decision to append it is in
// server/test-support/app-proxy.test.ts.

import { expect, it } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  APP_RELOAD_MESSAGE,
  APP_VIEW_MESSAGE_TYPE,
  appViewScript,
} from "./app-view-script.ts";

const OFFICE = "https://office.example";

// A page in a frame (or at the top, with framed: false). Timers run only when
// the test ticks them; message listeners are kept so the test can deliver a
// message as the browser would.
function page(opts: { framed: boolean }) {
  const posted: [unknown, string][] = [];
  const parent = {
    postMessage(data: unknown, targetOrigin: string) {
      posted.push([data, targetOrigin]);
    },
  };
  const intervals: { fn: () => void; ms: number }[] = [];
  const timeouts: (() => void)[] = [];
  const listeners: ((event: unknown) => void)[] = [];
  let reloads = 0;
  const location = {
    pathname: "/recipes/3",
    search: "?step=2",
    hash: "#notes",
    get href() {
      return `https://hello.office.example${this.pathname}${this.search}${this.hash}`;
    },
    reload() {
      reloads++;
    },
  };
  const document = { title: "Pasta" };
  const win: Record<string, unknown> = {
    location,
    document,
    setInterval(fn: () => void, ms: number) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    setTimeout(fn: () => void) {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeout() {},
    addEventListener(type: string, fn: (event: unknown) => void) {
      if (type === "message") listeners.push(fn);
    },
    removeEventListener() {},
  };
  win.window = win;
  win.self = win;
  win.parent = opts.framed ? parent : win;
  win.top = win.parent;
  runInNewContext(appViewScript(OFFICE), win);
  return {
    posted,
    location,
    document,
    intervals,
    listeners,
    reloads: () => reloads,
    tick() {
      for (const fn of timeouts.splice(0)) fn();
      for (const { fn } of intervals) fn();
    },
    deliver(event: { source: unknown; origin: string; data: unknown }) {
      for (const fn of listeners) fn(event);
    },
    parent,
  };
}

const view = (path: string, title: string): [unknown, string] => [
  { type: APP_VIEW_MESSAGE_TYPE, path, title },
  OFFICE,
];

it("posts the page once at start, to the office origin only, and stays quiet while nothing changes", () => {
  const p = page({ framed: true });
  p.tick();
  expect(p.posted).toEqual([view("/recipes/3?step=2#notes", "Pasta")]);
  // The poll is the agreed 500 ms, and an unchanged page sends nothing.
  expect(p.intervals.map(({ ms }) => ms)).toEqual([500]);
  for (let i = 0; i < 5; i++) p.tick();
  expect(p.posted).toHaveLength(1);
});

it("posts once per change of the route or the title", () => {
  const p = page({ framed: true });
  p.tick();
  p.location.hash = "#steps";
  p.tick();
  p.tick();
  p.document.title = "Pasta, step 2";
  p.tick();
  p.tick();
  p.location.pathname = "/recipes/4";
  p.location.search = "";
  p.location.hash = "";
  p.document.title = "Soup";
  p.tick();
  expect(p.posted).toEqual([
    view("/recipes/3?step=2#notes", "Pasta"),
    view("/recipes/3?step=2#steps", "Pasta"),
    view("/recipes/3?step=2#steps", "Pasta, step 2"),
    view("/recipes/4", "Soup"),
  ]);
});

// The reload request is honoured only from the parent and only from the
// office origin: another frame, or another site that frames the app, cannot
// make it reload.
it("reloads in place only on the office's own reload message", () => {
  const p = page({ framed: true });
  p.tick();
  p.deliver({ source: {}, origin: OFFICE, data: APP_RELOAD_MESSAGE });
  p.deliver({
    source: p.parent,
    origin: "https://evil.example",
    data: APP_RELOAD_MESSAGE,
  });
  p.deliver({ source: p.parent, origin: OFFICE, data: "isomux:other" });
  p.deliver({
    source: p.parent,
    origin: OFFICE,
    data: { type: APP_RELOAD_MESSAGE },
  });
  expect(p.reloads()).toBe(0);
  p.deliver({ source: p.parent, origin: OFFICE, data: APP_RELOAD_MESSAGE });
  expect(p.reloads()).toBe(1);
});

// A page open in its own tab has no wrapper to tell: nothing is posted,
// polled or listened for.
it("does nothing in a top-level page", () => {
  const p = page({ framed: false });
  p.tick();
  expect(p.posted).toEqual([]);
  expect(p.intervals).toEqual([]);
  expect(p.listeners).toEqual([]);
});
