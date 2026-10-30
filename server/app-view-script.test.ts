// The script a framed app page gets (task d7ac4f73), run in a bare context
// with only the browser globals listed in `page` below: it tells the office
// wrapper which page the member sees, reloads in place when the wrapper asks,
// and sends a new-tab link or window.open to the same app to a new office tab
// on the app's widget page (task 469e8886). The proxy's decision to append it
// is in server/test-support/app-proxy.test.ts.

import { expect, it } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  APP_RELOAD_MESSAGE,
  APP_VIEW_MESSAGE_TYPE,
  appViewScript,
} from "./app-view-script.ts";

const OFFICE = "https://office.example";
const APP = "hello";
const APP_ORIGIN = "https://hello.office.example";

// An element as the script reads it: its local name, attributes and base URL.
interface FakeElement {
  localName: string;
  baseURI: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

function el(
  localName: string,
  attributes: Record<string, string> = {},
  baseURI = APP_ORIGIN + "/recipes/3",
): FakeElement {
  return {
    localName,
    baseURI,
    getAttribute: (name) =>
      Object.hasOwn(attributes, name) ? attributes[name] : null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
  };
}

// A page in a frame (or at the top, with framed: false). Timers run only when
// the test ticks them; listeners are kept so the test can deliver an event as
// the browser would. `frames` are the page's iframe/frame elements, `base` its
// <base> element, and window.open is a recorder that returns a sentinel.
function page(
  opts: {
    framed: boolean;
    frames?: FakeElement[];
    base?: FakeElement;
    baseURI?: string;
  } = { framed: true },
) {
  const posted: [unknown, string][] = [];
  const parent = {
    postMessage(data: unknown, targetOrigin: string) {
      posted.push([data, targetOrigin]);
    },
  };
  const intervals: { fn: () => void; ms: number }[] = [];
  const timeouts: (() => void)[] = [];
  const listeners: { type: string; fn: (event: unknown) => void }[] = [];
  let reloads = 0;
  const location = {
    protocol: "https:",
    host: "hello.office.example",
    hostname: "hello.office.example",
    origin: APP_ORIGIN,
    pathname: "/recipes/3",
    search: "?step=2",
    hash: "#notes",
    get href() {
      return `${APP_ORIGIN}${this.pathname}${this.search}${this.hash}`;
    },
    reload() {
      reloads++;
    },
  };
  const frames = opts.frames ?? [];
  const document = {
    title: "Pasta",
    baseURI: opts.baseURI ?? APP_ORIGIN + "/recipes/3",
    querySelector(selector: string) {
      if (selector.includes("base"))
        return opts.base?.hasAttribute("target") ? opts.base : null;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector.includes("iframe") || selector.includes("frame"))
        return frames.filter((frame) => frame.hasAttribute("name"));
      return [];
    },
  };
  const SENTINEL = { opened: true };
  const opened: { receiver: unknown; args: unknown[] }[] = [];
  const originalOpen = function (this: unknown, ...args: unknown[]) {
    opened.push({ receiver: this, args });
    return SENTINEL;
  };
  const win: Record<string, unknown> = {
    location,
    document,
    URL,
    open: originalOpen,
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
      listeners.push({ type, fn });
    },
    removeEventListener() {},
  };
  win.window = win;
  win.self = win;
  win.parent = opts.framed ? parent : win;
  win.top = win.parent;
  runInNewContext(appViewScript(OFFICE, APP), win);
  return {
    win,
    posted,
    location,
    document,
    intervals,
    listeners,
    opened,
    originalOpen,
    SENTINEL,
    reloads: () => reloads,
    tick() {
      for (const fn of timeouts.splice(0)) fn();
      for (const { fn } of intervals) fn();
    },
    deliver(event: { source: unknown; origin: string; data: unknown }) {
      for (const { type, fn } of listeners) if (type === "message") fn(event);
    },
    // A mouse event as the browser dispatches it to window. `path` is the
    // composed path, innermost first. Returns whether the default was
    // prevented.
    mouse(
      type: "click" | "auxclick",
      path: unknown[],
      init: {
        button?: number;
        ctrlKey?: boolean;
        metaKey?: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
        defaultPrevented?: boolean;
      } = {},
    ): boolean {
      let prevented = init.defaultPrevented ?? false;
      const event = {
        type,
        button: init.button ?? (type === "click" ? 0 : 1),
        ctrlKey: init.ctrlKey ?? false,
        metaKey: init.metaKey ?? false,
        shiftKey: init.shiftKey ?? false,
        altKey: init.altKey ?? false,
        get defaultPrevented() {
          return prevented;
        },
        preventDefault() {
          prevented = true;
        },
        composedPath: () => [...path, document, win],
        target: path[0],
      };
      for (const listener of listeners)
        if (listener.type === type) listener.fn(event);
      return prevented;
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
  // window.open is the app's own, and a new-tab link keeps its default.
  expect(p.win.open).toBe(p.originalOpen);
  const link = el("a", { href: "/blog", target: "_blank" });
  expect(p.mouse("click", [link])).toBe(false);
  expect(p.opened).toEqual([]);
});

// Task 469e8886: a new-tab link or window.open to the same app opens the
// app's widget page at that path, in a new tab, with no handle back.
const widget = (path: string) => [
  `${OFFICE}/${APP}${path}`,
  "_blank",
  "noopener",
];

it("opens a new-tab link to the same app as the widget page at that path", () => {
  const cases: [string, Record<string, string>, string][] = [
    [
      "target=_blank",
      { href: "/blog?x=1#top", target: "_blank" },
      "/blog?x=1#top",
    ],
    // Keywords are ASCII case-insensitive.
    ["target=_BLANK", { href: "/blog", target: "_BLANK" }, "/blog"],
    // The app's root opens the widget's root.
    ["the root", { href: "/", target: "_blank" }, "/"],
    // An absolute URL on the app's own origin.
    [
      "absolute",
      { href: APP_ORIGIN + "/blog/post-1", target: "_blank" },
      "/blog/post-1",
    ],
    // A name no frame in the page has opens a new browsing context.
    ["unknown name", { href: "/blog", target: "reader" }, "/blog"],
  ];
  for (const [label, attributes, path] of cases) {
    const p = page();
    // The click lands on a span inside the link.
    const prevented = p.mouse("click", [el("span"), el("a", attributes)]);
    expect({
      label,
      prevented,
      opened: p.opened.map(({ args }) => args),
    }).toEqual({
      label,
      prevented: true,
      opened: [widget(path)],
    });
  }
  // An image-map area is a link too; a relative href resolves against the
  // element's base URL (a <base href>), not the page's address.
  const p = page();
  const area = el(
    "area",
    { href: "post-2", target: "_blank" },
    APP_ORIGIN + "/blog/",
  );
  expect(p.mouse("click", [area])).toBe(true);
  expect(p.opened.map(({ args }) => args)).toEqual([widget("/blog/post-2")]);
});

it("treats <base target> and a new-tab gesture on a plain link as a new tab", () => {
  const link = () => el("a", { href: "/blog" });
  const gestures: [string, () => boolean, ReturnType<typeof page>][] = [];
  const based = page({ framed: true, base: el("base", { target: "_blank" }) });
  gestures.push([
    "<base target=_blank>",
    () => based.mouse("click", [link()]),
    based,
  ]);
  for (const key of ["ctrlKey", "metaKey", "shiftKey"] as const) {
    const p = page();
    gestures.push([key, () => p.mouse("click", [link()], { [key]: true }), p]);
  }
  const middle = page();
  gestures.push([
    "middle auxclick",
    () => middle.mouse("auxclick", [link()], { button: 1 }),
    middle,
  ]);
  for (const [label, act, p] of gestures) {
    const prevented = act();
    expect({
      label,
      prevented,
      opened: p.opened.map(({ args }) => args),
    }).toEqual({
      label,
      prevented: true,
      opened: [widget("/blog")],
    });
  }
});

it("leaves every other click to the browser", () => {
  const preview = el("iframe", { name: "preview" });
  const cases: [
    string,
    unknown[],
    Parameters<ReturnType<typeof page>["mouse"]>[2],
    "click" | "auxclick",
  ][] = [
    ["plain click", [el("a", { href: "/blog" })], {}, "click"],
    [
      "target=_self",
      [el("a", { href: "/blog", target: "_self" })],
      {},
      "click",
    ],
    ["target=_top", [el("a", { href: "/blog", target: "_top" })], {}, "click"],
    [
      "target=_parent",
      [el("a", { href: "/blog", target: "_parent" })],
      {},
      "click",
    ],
    // Keywords are ASCII case-insensitive.
    [
      "target=_SELF",
      [el("a", { href: "/blog", target: "_SELF" })],
      {},
      "click",
    ],
    ["target=_Top", [el("a", { href: "/blog", target: "_Top" })], {}, "click"],
    // The app's own inner frame.
    [
      "named frame",
      [el("a", { href: "/blog", target: "preview" })],
      {},
      "click",
    ],
    [
      "other host",
      [el("a", { href: "https://other.example/blog", target: "_blank" })],
      {},
      "click",
    ],
    [
      "other app",
      [el("a", { href: "https://board.office.example/", target: "_blank" })],
      {},
      "click",
    ],
    [
      "same host over http",
      [el("a", { href: "http://hello.office.example/blog", target: "_blank" })],
      {},
      "click",
    ],
    // blob: reports the app's origin; it is not a page of the app.
    [
      "blob",
      [
        el("a", {
          href: APP_ORIGIN.replace("https://", "blob:https://") + "/0b5e",
          target: "_blank",
        }),
      ],
      {},
      "click",
    ],
    [
      "javascript",
      [el("a", { href: "javascript:void 0", target: "_blank" })],
      {},
      "click",
    ],
    [
      "download",
      [el("a", { href: "/report.pdf", target: "_blank", download: "" })],
      {},
      "click",
    ],
    ["no href", [el("a", { target: "_blank" })], {}, "click"],
    ["not a link", [el("button"), el("div")], { ctrlKey: true }, "click"],
    ["alt click", [el("a", { href: "/blog" })], { altKey: true }, "click"],
    // Firefox has dispatched click for other buttons; only auxclick counts.
    ["middle as click", [el("a", { href: "/blog" })], { button: 1 }, "click"],
    ["right auxclick", [el("a", { href: "/blog" })], { button: 2 }, "auxclick"],
  ];
  for (const [label, path, init, type] of cases) {
    const p = page({ framed: true, frames: [preview] });
    const prevented = p.mouse(type, path, init);
    expect({ label, prevented, opened: p.opened }).toEqual({
      label,
      prevented: false,
      opened: [],
    });
    // Enabling condition: the same page does handle a new-tab link.
    expect(
      p.mouse("click", [el("a", { href: "/blog", target: "_blank" })]),
    ).toBe(true);
  }
  // A click the app already handled (an SPA router) stays the app's.
  const p = page();
  const prevented = p.mouse(
    "click",
    [el("a", { href: "/blog", target: "_blank" })],
    {
      defaultPrevented: true,
    },
  );
  expect({ prevented, opened: p.opened }).toEqual({
    prevented: true,
    opened: [],
  });
  expect(p.mouse("click", [el("a", { href: "/blog", target: "_blank" })])).toBe(
    true,
  );
});

it("routes window.open to the same app into the widget, and passes every other call through", () => {
  const preview = el("iframe", { name: "preview" });
  const p = page({
    framed: true,
    frames: [preview],
    baseURI: APP_ORIGIN + "/blog/",
  });
  const open = p.win.open as (...args: unknown[]) => unknown;
  // Enabling condition: the app's window.open is wrapped.
  expect(open).not.toBe(p.originalOpen);
  const mapped: [unknown[], string][] = [
    [["/recipes/4"], "/recipes/4"],
    [["/recipes/4", "_blank"], "/recipes/4"],
    [["/recipes/4", ""], "/recipes/4"],
    [["/recipes/4", "_BLANK", "popup"], "/recipes/4"],
    [["/recipes/4", "reader"], "/recipes/4"],
    // Relative to the document's base URL.
    [["post-2?x=1#c"], "/blog/post-2?x=1#c"],
    [[new URL(APP_ORIGIN + "/blog/post-3")], "/blog/post-3"],
  ];
  for (const [args, path] of mapped) {
    p.opened.length = 0;
    const result = open.apply(p.win, args);
    expect({ args, result, opened: p.opened }).toEqual({
      args,
      result: null,
      opened: [{ receiver: p.win, args: widget(path) }],
    });
  }
  const passed: unknown[][] = [
    [],
    [""],
    ["about:blank"],
    ["/recipes/4", "_self"],
    ["/recipes/4", "_top"],
    ["/recipes/4", "_parent"],
    ["/recipes/4", "_SELF"],
    ["/recipes/4", "preview"],
    ["https://other.example/x", "_blank"],
    ["https://board.office.example/", "_blank", "noopener"],
    [APP_ORIGIN.replace("https://", "blob:https://") + "/0b5e"],
  ];
  for (const args of passed) {
    p.opened.length = 0;
    const result = open.apply(p.win, args);
    expect({ args, result, opened: p.opened }).toEqual({
      args,
      result: p.SENTINEL,
      opened: [{ receiver: p.win, args }],
    });
  }
});
