// The two browser halves of email sign-in.
//
// The sign-in page offers the email form only when the server lists the
// provider: the page is prerendered and auto-deploys from main, so before the
// mail key exists it must look exactly as it does without the feature.
//
// The page a mailed link opens signs in on a click and never on its own. Mail
// scanners open links before the person does, and a page that submitted by
// itself would spend the single-use token on the scanner's visit.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";

GlobalRegistrator.register({ url: "http://localhost:3999/signin" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const signInCalls: unknown[][] = [];
const nextAuthReact = await import("next-auth/react");
const realNextAuthReact = { ...nextAuthReact };
await mock.module("next-auth/react", () => ({
  ...realNextAuthReact,
  signIn: async (...args: unknown[]) => {
    signInCalls.push(args);
    return undefined;
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SignInForm } = await import("./signin-form");
const { EmailLinkForm } = await import("./email/email-link-form");
const { createSignInTokens } = await import("../../lib/signin-link.server");

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await mock.module("next-auth/react", () => realNextAuthReact);
  await GlobalRegistrator.unregister();
});

interface Call {
  url: string;
  method: string;
  body: string | null;
}
let calls: Call[] = [];

/** Answers by path; records every request the page makes. */
function serve(routes: Record<string, () => Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    );
    calls.push({
      url: url.pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    const route = routes[url.pathname];
    return route ? route() : new Response("{}", { status: 404 });
  }) as typeof fetch;
}

// Element presence is asserted on its tag name, never on the node: a failing
// matcher on a DOM node serialises it, which is slow and unreadable.
let container: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
  await settle();
}

/** Let effects, fetches and the state they set land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function find(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  // The prototype's setter, not the element's: React tracks the value it last
  // wrote on the element, and an assignment there reads as no change.
  const prototype = Object.getPrototypeOf(input) as object;
  await act(async () => {
    Reflect.set(prototype, "value", value, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  calls = [];
  signInCalls.length = 0;
  window.location.hash = "";
});

const PROVIDERS = "/api/auth/providers";
const REQUEST = "/api/signin/email";

function providers(...ids: string[]): () => Response {
  return () =>
    Response.json(
      Object.fromEntries(ids.map((id) => [id, { id, type: "credentials" }])),
    );
}

describe("the sign-in page", () => {
  test("without the provider it offers Google alone", async () => {
    serve({
      [PROVIDERS]: providers("google"),
      [REQUEST]: () => new Response(""),
    });
    await render(createElement(SignInForm));
    // The enabling condition: the page asked, and was told.
    expect(calls.some((c) => c.url === PROVIDERS)).toBe(true);
    expect(find("email-link-form")?.tagName ?? null).toBeNull();
    expect(calls.some((c) => c.url === REQUEST)).toBe(false);
  });

  test("with the provider it asks for a link for the typed address", async () => {
    serve({
      [PROVIDERS]: providers("google", "email-link"),
      [REQUEST]: () => new Response("", { status: 200 }),
    });
    await render(createElement(SignInForm));
    const form = find("email-link-form");
    expect(form?.tagName ?? null).not.toBeNull();
    await type(
      find("email-link-address") as HTMLInputElement,
      "user@proton.me",
    );
    await click(form!.querySelector('button[type="submit"]') as HTMLElement);
    const posts = calls.filter((c) => c.url === REQUEST);
    expect(posts.length).toBe(1);
    expect(posts[0].method).toBe("POST");
    expect(JSON.parse(posts[0].body ?? "null")).toEqual({
      email: "user@proton.me",
    });
    // The address field gives way to the confirmation.
    expect(find("email-link-address")?.tagName ?? null).toBeNull();
    expect(find("email-link-status")?.textContent?.trim()).toBeTruthy();
  });

  test("a refusal is shown as the server worded it, and the form stays", async () => {
    const sentence = "server-worded refusal 7c1e";
    serve({
      [PROVIDERS]: providers("google", "email-link"),
      [REQUEST]: () => new Response(sentence, { status: 429 }),
    });
    await render(createElement(SignInForm));
    expect(find("email-link-form")?.tagName ?? null).not.toBeNull();
    await type(
      find("email-link-address") as HTMLInputElement,
      "user@proton.me",
    );
    await click(
      find("email-link-form")!.querySelector(
        'button[type="submit"]',
      ) as HTMLElement,
    );
    expect(find("email-link-status")?.textContent).toContain(sentence);
    expect(find("email-link-address")?.tagName ?? null).not.toBeNull();
  });
});

describe("the page a mailed link opens", () => {
  test("signs in on a click, and not before", async () => {
    const token = createSignInTokens({
      secret: "dom-test-secret-0123456789abcdef",
    }).create("user@proton.me");
    serve({});
    window.location.hash = `#token=${token}`;
    await render(createElement(EmailLinkForm));
    // The page has rendered with the token: it names the address it will sign
    // in as. Nothing has been spent yet.
    expect(container.textContent).toContain("user@proton.me");
    expect(signInCalls).toEqual([]);
    const button = find("email-link-signin");
    expect(button?.tagName ?? null).not.toBeNull();
    await click(button!);
    expect(signInCalls).toEqual([["email-link", { token, callbackUrl: "/" }]]);
  });

  test("without a token there is nothing to press, and a way back", async () => {
    serve({});
    await render(createElement(EmailLinkForm));
    expect(find("email-link-signin")?.tagName ?? null).toBeNull();
    expect(
      container.querySelector('a[href="/signin"]')?.tagName ?? null,
    ).not.toBeNull();
    expect(signInCalls).toEqual([]);
  });
});
