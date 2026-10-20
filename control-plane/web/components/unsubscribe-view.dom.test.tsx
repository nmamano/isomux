// The /unsubscribe page: opening it changes nothing, its one button does.
//
// Mail scanners and link previews open every link in a mail, so the page must
// not unsubscribe on load; a person confirms with the button, which posts the
// token to the one-click endpoint.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
  url: "https://storefront.example.com/unsubscribe?t=tok",
});
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { UnsubscribeView } = await import("./unsubscribe-view");

const TOKEN = "Zm9vYmFy-YmF6_cXV4";
const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

interface Post {
  url: URL;
  method: string;
}
let posts: Post[] = [];
let answer: () => Response = () => new Response(null, { status: 200 });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  posts.push({
    url: new URL(href, "https://storefront.example.com"),
    method: init?.method ?? "GET",
  });
  return answer();
}) as typeof fetch;

let container: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  posts = [];
  answer = () => new Response(null, { status: 200 });
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(token: string | null): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(UnsubscribeView, { token, language: "en" }));
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

test("opening the page sends nothing; the button posts the token once and the page says it is done", async () => {
  await render(TOKEN);
  expect(posts).toEqual([]);
  expect(buttons()).toHaveLength(1);
  const before = container.textContent;

  await click(buttons()[0]);
  expect(posts).toHaveLength(1);
  expect(posts[0].method).toBe("POST");
  expect(posts[0].url.pathname).toBe("/api/unsubscribe");
  expect(posts[0].url.searchParams.get("t")).toBe(TOKEN);
  // Done: nothing left to press, and the page reads differently.
  expect(buttons()).toHaveLength(0);
  expect(container.textContent).not.toBe(before);
});

test("a failed request leaves the button to try again, and says so", async () => {
  answer = () => new Response(null, { status: 503 });
  await render(TOKEN);
  const before = container.textContent;
  await click(buttons()[0]);
  expect(posts).toHaveLength(1);
  expect(buttons()).toHaveLength(1);
  expect(buttons()[0].disabled).toBe(false);
  expect(container.textContent).not.toBe(before);
});

test("a link without a token offers no button", async () => {
  await render(null);
  expect(buttons()).toHaveLength(0);
  expect(container.textContent?.trim().length).toBeGreaterThan(0);
  expect(posts).toEqual([]);
});
