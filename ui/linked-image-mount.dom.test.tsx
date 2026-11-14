// Both pages open an image link in the lightbox (task 3d947224): the office
// page and an app's short-link page each mount one LinkedImageLightbox. The
// behavior itself is in ui/log-view/linked-image.dom.test.tsx; this pins the
// mounts. App and AppWidgetPage mount bare (ui/App.history.dom.test.tsx).

import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { AppWidgetPage } = await import("./AppWidgetPage.tsx");
const { setApiShim } = await import("./api.ts");

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

// No remote page loads in a DOM test: the widget's iframe stays empty.
const settings = (
  window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  }
).happyDOM.settings;
const iframeLoading = settings.disableIframePageLoading;
settings.disableIframePageLoading = true;
afterAll(() => {
  settings.disableIframePageLoading = iframeLoading;
});

// An agent's image link, as chat text renders it.
let link: HTMLAnchorElement;
const stopNavigation = (e: Event) => e.preventDefault();
beforeEach(() => {
  const text = document.createElement("div");
  text.className = "md-content";
  link = document.createElement("a");
  link.href = "/api/files/agent-1/shot.png";
  link.target = "_blank";
  link.textContent = "open image full screen";
  text.appendChild(link);
  document.body.appendChild(text);
  window.addEventListener("click", stopNavigation);
});
afterEach(() => {
  link.parentElement!.remove();
  window.removeEventListener("click", stopNavigation);
});

const shown = () =>
  [...document.body.querySelectorAll("img")].filter((img) =>
    (img.getAttribute("src") ?? "").includes("/api/files/agent-1/shot.png"),
  ).length;

it("the office page opens an image link in the lightbox", async () => {
  const view = render(<App routing={false} />);
  expect(shown()).toBe(0);
  fireEvent.click(link);
  expect(shown()).toBe(1);
  view.unmount();
});

it("an app's short-link page opens an image link in the lightbox", async () => {
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(<AppWidgetPage boot={{ name: "hello", registration: 1 }} />);
  });
  expect(shown()).toBe(0);
  fireEvent.click(link);
  expect(shown()).toBe(1);
  view!.unmount();
});
