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
// Isomux for Enterprise has its own sign-in page on the same form: every way in
// returns the buyer to /enterprise, and every way a sign-in fails lands on the
// enterprise sign-in page, never on Hosted's.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
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

const routed: string[] = [];
const nextNavigation = await import("next/navigation");
const realNextNavigation = { ...nextNavigation };
const router = {
  replace: (href: string) => void routed.push(href),
  push: (href: string) => void routed.push(href),
  prefetch: () => undefined,
  refresh: () => undefined,
  back: () => undefined,
  forward: () => undefined,
};
await mock.module("next/navigation", () => ({
  ...realNextNavigation,
  useRouter: () => router,
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SignInForm } = await import("./signin-form");
const { EmailLinkForm } = await import("./email/email-link-form");
const { SignedInRedirect } = await import("./signed-in-redirect");
const { translatorFor } = await import("../../lib/i18n/translate");
const { createSignInTokens } = await import("../../lib/signin-link.server");
const { GOOGLE_REMOVED_MARKER } =
  await import("../../lib/google-removed-marker");

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await mock.module("next-auth/react", () => realNextAuthReact);
  await mock.module("next/navigation", () => realNextNavigation);
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
  routed.length = 0;
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
    // Nothing to choose between, so no "or".
    expect(find("signin-google")?.tagName ?? null).toBe("BUTTON");
    expect(find("signin-or")?.tagName ?? null).toBeNull();
  });

  test('with the provider an "or" stands between the email form and Google', async () => {
    serve({ [PROVIDERS]: providers("google", "email-link") });
    await render(createElement(SignInForm));
    const form = find("email-link-form");
    const or = find("signin-or");
    expect(form?.tagName ?? null).not.toBeNull();
    expect(or?.textContent?.trim()).toBeTruthy();
    const google = find("signin-google");
    expect(google?.tagName ?? null).toBe("BUTTON");
    // Document order: the form, then "or", then Google.
    expect(
      form!.compareDocumentPosition(or!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      or!.compareDocumentPosition(google!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await click(google!);
    expect(signInCalls).toEqual([["google", { callbackUrl: "/" }]]);
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

describe("the sign-in page after a refused Google sign-in", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/signin");
  });

  /** The alert the page shows when it opens with this error, or null. */
  async function alertFor(error: string | null): Promise<string | null> {
    window.history.replaceState(
      null,
      "",
      error === null ? "/signin" : `/signin?error=${error}`,
    );
    serve({ [PROVIDERS]: providers("google", "email-link") });
    await render(createElement(SignInForm));
    const alert = container.querySelector('[role="alert"]');
    const text = alert ? (alert.textContent ?? "").trim() : null;
    await act(async () => root?.unmount());
    root = null;
    container.remove();
    return text;
  }

  test("a removed Google account gets its own alert, not the failed-link one", async () => {
    // The enabling conditions: no error is no alert, and a failed link has one.
    expect(await alertFor(null)).toBeNull();
    const linkFailed = await alertFor("CredentialsSignin");
    expect(linkFailed).toBeTruthy();

    const removed = await alertFor(GOOGLE_REMOVED_MARKER);
    expect(removed).toBeTruthy();
    expect(removed).not.toBe(linkFailed);
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

describe("the enterprise sign-in page", () => {
  test("Google and the email link both return to /enterprise", async () => {
    serve({
      [PROVIDERS]: providers("google", "email-link"),
      [REQUEST]: () => new Response("", { status: 200 }),
    });
    await render(createElement(SignInForm, { product: "enterprise" }));
    await click(find("signin-google")!);
    expect(signInCalls).toEqual([["google", { callbackUrl: "/enterprise" }]]);
    const form = find("email-link-form");
    expect(form?.tagName ?? null).not.toBeNull();
    await type(
      find("email-link-address") as HTMLInputElement,
      "it@acme.example",
    );
    await click(form!.querySelector('button[type="submit"]') as HTMLElement);
    const posts = calls.filter((c) => c.url === REQUEST);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body ?? "null")).toEqual({
      email: "it@acme.example",
      product: "enterprise",
    });
  });

  test("nothing of Hosted but the privacy policy, which covers both products", async () => {
    const { t } = translatorFor("en");
    const href = (a: Element) => a.getAttribute("href") ?? "";
    const hostedPolicies = () =>
      [...container.querySelectorAll("a")].filter((a) =>
        href(a).includes("isomux.com/hosted-"),
      );
    // How a link opens, not only where it goes: the buyer keeps the form.
    const opens = (a: Element) =>
      [href(a), a.getAttribute("target"), a.getAttribute("rel")].join(" ");

    // The enabling conditions: the Hosted page has its three policies, one of
    // them the privacy policy.
    serve({ [PROVIDERS]: providers("google", "email-link") });
    await render(createElement(SignInForm));
    expect(container.textContent).toContain(t("signIn.subheading"));
    expect(hostedPolicies()).toHaveLength(3);
    const privacy = hostedPolicies()
      .filter((a) => href(a).includes("privacy"))
      .map(opens);
    expect(privacy).toHaveLength(1);
    await act(async () => root?.unmount());
    container.remove();

    await render(createElement(SignInForm, { product: "enterprise" }));
    const text = container.textContent ?? "";
    expect(text).not.toContain(t("signIn.subheading"));
    expect(text).not.toContain("isomux.app");
    // The buyer gives an email here, so the policy that covers it is linked,
    // as on Hosted. The terms and refund policy are Hosted's: the enterprise
    // agreement governs.
    expect(hostedPolicies().map(opens)).toEqual(privacy);
    // The way out goes to the product page the buyer came from.
    expect([...container.querySelectorAll("a")].map(href)).toContain(
      "https://isomux.com/enterprise",
    );
  });

  test("a signed-in visitor is sent to /enterprise, and on Hosted's page to /", async () => {
    serve({
      "/api/session": () =>
        Response.json({
          signedIn: true,
          email: "it@acme.example",
          offices: null,
          enterprise: null,
        }),
    });
    await render(createElement(SignedInRedirect, { product: "enterprise" }));
    expect(routed).toEqual(["/enterprise"]);
    await act(async () => root?.unmount());
    container.remove();
    routed.length = 0;
    await render(createElement(SignedInRedirect));
    expect(routed).toEqual(["/"]);
  });
});

describe("the page a mailed enterprise link opens", () => {
  const token = () =>
    createSignInTokens({
      secret: "dom-test-secret-0123456789abcdef",
    }).create("it@acme.example");

  test("returns to /enterprise", async () => {
    const link = token();
    serve({});
    window.location.hash = `#token=${link}&product=enterprise`;
    await render(createElement(EmailLinkForm));
    await click(find("email-link-signin")!);
    expect(signInCalls).toEqual([
      ["email-link", { token: link, callbackUrl: "/enterprise" }],
    ]);
  });

  test("any other product value is Hosted", async () => {
    const link = token();
    serve({});
    window.location.hash = `#token=${link}&product=%2Fevil`;
    await render(createElement(EmailLinkForm));
    await click(find("email-link-signin")!);
    expect(signInCalls).toEqual([
      ["email-link", { token: link, callbackUrl: "/" }],
    ]);
  });

  test("of Hosted's policies only the privacy policy, and none before the fragment is read", async () => {
    const hostedLinks = (root: ParentNode) =>
      [...root.querySelectorAll("a")]
        .map((a) => a.getAttribute("href") ?? "")
        .filter((href) => href.includes("/hosted-"));
    // The prerendered first paint, before any effect reads the fragment.
    const shell = document.createElement("div");
    shell.innerHTML = renderToStaticMarkup(createElement(EmailLinkForm));
    expect(hostedLinks(shell)).toEqual([]);

    // The enabling condition: a Hosted link shows all three once it is read.
    serve({});
    window.location.hash = `#token=${token()}`;
    await render(createElement(EmailLinkForm));
    expect(hostedLinks(container)).toHaveLength(3);
    const privacy = hostedLinks(container).filter((href) =>
      href.includes("privacy"),
    );
    expect(privacy).toHaveLength(1);
    await act(async () => root?.unmount());
    container.remove();

    window.location.hash = `#token=${token()}&product=enterprise`;
    await render(createElement(EmailLinkForm));
    expect(find("email-link-signin")?.tagName ?? null).toBe("BUTTON");
    expect(hostedLinks(container)).toEqual(privacy);
  });

  test("without a token the way back is the enterprise sign-in page", async () => {
    serve({});
    window.location.hash = "#product=enterprise";
    await render(createElement(EmailLinkForm));
    expect(find("email-link-signin")?.tagName ?? null).toBeNull();
    const hrefs = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/enterprise/signin");
    expect(hrefs).not.toContain("/signin");
  });
});

describe("a failed sign-in that started on the enterprise page", () => {
  // Auth.js sends every failed sign-in to /signin (auth.ts, pages.signIn). A
  // sign-in that started from the enterprise page, or from an enterprise
  // link, in this tab is moved on to the enterprise sign-in page with the same
  // error. A Hosted sign-in started later in the same tab is not.
  const ERROR = "?error=CredentialsSignin&code=credentials";
  let replaced: string[] = [];
  let replaceSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    // Earlier tests in this file start sign-ins in this tab too.
    sessionStorage.clear();
    replaced = [];
    replaceSpy = spyOn(window.location, "replace").mockImplementation(
      (url: string | URL) => void replaced.push(String(url)),
    );
  });

  afterEach(() => {
    replaceSpy?.mockRestore();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/signin");
  });

  async function unmount(): Promise<void> {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
  }

  async function startFromEnterprisePage(): Promise<void> {
    window.history.replaceState(null, "", "/enterprise/signin");
    serve({ [PROVIDERS]: providers("google", "email-link") });
    await render(createElement(SignInForm, { product: "enterprise" }));
    await click(find("signin-google")!);
    await unmount();
  }

  async function startFromLink(product: string | null): Promise<void> {
    const link = createSignInTokens({
      secret: "dom-test-secret-0123456789abcdef",
    }).create("it@acme.example");
    window.history.replaceState(null, "", "/signin/email");
    window.location.hash =
      product === null ? `#token=${link}` : `#token=${link}&product=${product}`;
    serve({});
    await render(createElement(EmailLinkForm));
    await click(find("email-link-signin")!);
    await unmount();
    window.location.hash = "";
  }

  /** Where Hosted's page, opened with this query, moves the visitor. */
  async function landOnHostedPage(query: string): Promise<string[]> {
    window.history.replaceState(null, "", `/signin${query}`);
    serve({ [PROVIDERS]: providers("google", "email-link") });
    await render(createElement(SignInForm));
    return [...replaced, ...routed];
  }

  function expectMovedOn(moves: string[], query: string): void {
    expect(moves).toHaveLength(1);
    const target = new URL(moves[0], "http://localhost:3999");
    expect(target.pathname).toBe("/enterprise/signin");
    expect(target.search).toBe(query);
  }

  test.each([
    ERROR,
    "?error=rate_limited",
    "?error=GoogleRemoved",
    "?error=OAuthCallbackError",
  ])(
    "from the enterprise page: %s lands on the enterprise page",
    async (query) => {
      await startFromEnterprisePage();
      expectMovedOn(await landOnHostedPage(query), query);
    },
  );

  test("from an enterprise link: a used or expired link lands on the enterprise page", async () => {
    await startFromLink("enterprise");
    expectMovedOn(await landOnHostedPage(ERROR), ERROR);
  });

  test("a Hosted sign-in after an enterprise one stays on Hosted's page", async () => {
    // From Hosted's own page...
    await startFromEnterprisePage();
    window.history.replaceState(null, "", "/signin");
    serve({ [PROVIDERS]: providers("google", "email-link") });
    await render(createElement(SignInForm));
    await click(find("signin-google")!);
    await unmount();
    expect(await landOnHostedPage(ERROR)).toEqual([]);
    // The page shows the error itself.
    expect(
      container.querySelector('[role="alert"]')?.tagName ?? null,
    ).not.toBeNull();
    await unmount();

    // ...and from a Hosted link opened in the same tab.
    await startFromEnterprisePage();
    await startFromLink(null);
    expect(await landOnHostedPage(ERROR)).toEqual([]);
  });

  test("with no sign-in started in this tab, or no error, Hosted's page stays", async () => {
    expect(await landOnHostedPage(ERROR)).toEqual([]);
    await unmount();
    await startFromEnterprisePage();
    expect(await landOnHostedPage("")).toEqual([]);
  });

  test("the enterprise page shows the error itself and moves nowhere", async () => {
    await startFromEnterprisePage();
    window.history.replaceState(null, "", `/enterprise/signin${ERROR}`);
    serve({ [PROVIDERS]: providers("google", "email-link") });
    await render(createElement(SignInForm, { product: "enterprise" }));
    expect([...replaced, ...routed]).toEqual([]);
    expect(
      container.querySelector('[role="alert"]')?.textContent?.trim(),
    ).toBeTruthy();
  });
});
