import { expect, it } from "bun:test";
import {
  beginAppHandshake,
  isAppSessionSignal,
  isAppViewReport,
  widgetDraftKey,
  screenshotHint,
} from "./app-widget-state.ts";

it("accepts only the fixed signal from this app iframe", () => {
  const frame = {} as Window;
  const event = {
    source: frame,
    origin: "https://hello.office.example",
    data: "isomux:app-session-required",
  };
  expect(isAppSessionSignal(event, frame, "https://hello.office.example")).toBe(
    true,
  );
  expect(
    isAppSessionSignal(
      { ...event, source: {} as Window },
      frame,
      "https://hello.office.example",
    ),
  ).toBe(false);
  expect(
    isAppSessionSignal(
      { ...event, origin: "https://other.office.example" },
      frame,
      "https://hello.office.example",
    ),
  ).toBe(false);
  expect(
    isAppSessionSignal(
      { ...event, data: "anything" },
      frame,
      "https://hello.office.example",
    ),
  ).toBe(false);
  expect(isAppSessionSignal(event, null, "https://hello.office.example")).toBe(
    false,
  );
});

// The frame's report of the page it shows (task d7ac4f73): only from this
// app's frame, only in the report's shape, and only the view's own fields.
it("reads the view only from this app frame's report", () => {
  const frame = {} as Window;
  const appUrl = "https://hello.office.example";
  const report = {
    type: "isomux:app-view",
    path: "/recipes/3?step=2#notes",
    title: "Pasta",
  };
  const event = { source: frame, origin: appUrl, data: report };
  expect(isAppViewReport(event, frame, appUrl)).toEqual({
    path: report.path,
    title: "Pasta",
  });
  expect(
    isAppViewReport(
      { ...event, data: { ...report, title: undefined, extra: "x" } },
      frame,
      appUrl,
    ),
  ).toEqual({ path: report.path });
  for (const refused of [
    { ...event, source: {} as Window },
    { ...event, origin: "https://other.office.example" },
    { ...event, data: { ...report, type: "isomux:app-reload" } },
    { ...event, data: "isomux:app-view" },
    { ...event, data: null },
    { ...event, data: { ...report, path: 3 } },
    { ...event, data: { type: report.type, title: "Pasta" } },
    { ...event, data: { ...report, title: 4 } },
  ])
    expect(isAppViewReport(refused, frame, appUrl)).toBeNull();
  expect(isAppViewReport(event, null, appUrl)).toBeNull();
  expect(isAppViewReport(event, frame, null)).toBeNull();
});

it("bounds sign-in recovery across page reloads and permits later expiry", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const boot = { name: "hello", registration: 1 };
  expect(beginAppHandshake(storage, boot, 100000)).toBe(true);
  expect(beginAppHandshake(storage, boot, 100001)).toBe(false);
  expect(beginAppHandshake(storage, boot, 160000)).toBe(true);
  expect(beginAppHandshake(storage, { ...boot, registration: 2 }, 160001)).toBe(
    true,
  );
  expect(
    beginAppHandshake(
      {
        getItem: () => {
          throw new Error("disabled");
        },
        setItem: () => {},
      },
      boot,
      200000,
    ),
  ).toBe(false);
});

it("binds drafts to the app registration and target", () => {
  const boot = { name: "hello", registration: 1 };
  expect(widgetDraftKey(boot, "a")).not.toBe(widgetDraftKey(boot, "b"));
  expect(widgetDraftKey(boot, "a")).not.toBe(
    widgetDraftKey({ ...boot, registration: 2 }, "a"),
  );
});

it("selects screenshot hints from desktop platform with mobile and unknown fallbacks", () => {
  const cases = [
    ["Win32", "Windows NT", 0, "appWidget.windowsHint"],
    ["MacIntel", "Macintosh", 0, "appWidget.macHint"],
    ["MacIntel", "Macintosh", 5, "appWidget.genericHint"],
    ["iPhone", "iPhone", 5, "appWidget.genericHint"],
    ["Linux armv8", "Android", 5, "appWidget.genericHint"],
    ["Linux x86_64", "Linux", 0, "appWidget.genericHint"],
    ["", "", 0, "appWidget.genericHint"],
  ] as const;
  for (const [platform, ua, touches, expected] of cases)
    expect(screenshotHint(platform, ua, touches)).toBe(expected);
});
