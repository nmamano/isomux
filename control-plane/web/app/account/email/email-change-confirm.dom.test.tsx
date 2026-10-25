// The page an email change link opens, when the browser is not signed in to
// the account that asked (task 4fe8a83c): the confirm route answers 401 or 403,
// and the page sends the customer to sign in. The way there must not carry the
// link: the token rides in the fragment so that no log or Referer sees it, and
// a sign-in URL is a query.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:3999/account/email" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EmailChangeConfirm } = await import("./email-change-confirm");
const { createEmailChangeTokens } =
  await import("../../../lib/signin-link.server");

const CONFIRM = "/api/account/email/confirm";
const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

let posts = 0;
function answer(status: number): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    );
    if (url.pathname === CONFIRM) posts++;
    return new Response(null, { status });
  }) as typeof fetch;
}

// Element presence is asserted on its tag name or an attribute, never on the
// node: a failing matcher on a DOM node serialises it.
let container: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  posts = 0;
  window.location.hash = "";
});

describe("the change link opened without the account's session", () => {
  for (const status of [401, 403]) {
    test(`a ${status} sends the customer to sign in, by a way that does not carry the link`, async () => {
      const token = createEmailChangeTokens({
        secret: "dom-test-secret-0123456789abcdef",
      }).create({ a: "acct-customer", e: "work@example.com" });
      answer(status);
      window.location.hash = `#token=${token}`;
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(EmailChangeConfirm));
      });
      await settle();
      const button = container.querySelector<HTMLElement>(
        '[data-testid="email-change-confirm"]',
      );
      expect(button?.tagName ?? null).not.toBeNull();
      await act(async () => {
        button!.click();
      });
      await settle();
      // The enabling condition: the page asked the route and got the refusal.
      expect(posts).toBe(1);

      const alert = container.querySelector('[role="alert"]');
      const signIn = alert?.querySelector('a[href^="/signin"]') ?? null;
      expect(signIn?.getAttribute("href") ?? null).not.toBeNull();
      // No part of the link reaches a URL the server sees.
      const hrefs = [...container.querySelectorAll("a")].map(
        (a) => a.getAttribute("href") ?? "",
      );
      for (const href of hrefs) expect(href).not.toContain(token.slice(0, 16));
      // The link stays usable once the customer is signed in.
      expect(
        container.querySelector('[data-testid="email-change-confirm"]')
          ?.tagName ?? null,
      ).not.toBeNull();
    });
  }
});
