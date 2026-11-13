// The bar at the top of every storefront page.
//
// Signed out it carries the brand and the language switch only. Signed in it
// adds the nav, the account's address and Sign out, and below 640 px those
// move into a menu. The layout stays mounted across client navigations, so an
// open menu must close when the page changes under it. The operator pages get
// the brand alone: they are English and have no customer nav.
//
// Sign out on an enterprise page lands on the enterprise sign-in page.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionProbe } from "../lib/use-session";

GlobalRegistrator.register({ url: "http://localhost:3999/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const signOutCalls: unknown[][] = [];
const nextAuthReact = await import("next-auth/react");
const realNextAuthReact = { ...nextAuthReact };
await mock.module("next-auth/react", () => ({
  ...realNextAuthReact,
  signOut: async (...args: unknown[]) => {
    signOutCalls.push(args);
    return undefined;
  },
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TopBarView } = await import("./top-bar");
const { webTranslatorFor } = await import("../lib/i18n/rich");

afterAll(async () => {
  await mock.module("next-auth/react", () => realNextAuthReact);
  await GlobalRegistrator.unregister();
});

const EMAIL = "owner@example.com";
const SIGNED_IN: SessionProbe = {
  state: "signed-in",
  email: EMAIL,
  offices: null,
  enterprise: null,
  operator: null,
};

// Element presence is asserted on its tag name, never on the node: a failing
// matcher on a DOM node serialises it, which is slow and unreadable.
let container: HTMLElement;
let outside: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;

function bar(probe: SessionProbe, pathname: string | null) {
  return createElement(TopBarView, {
    i18n: webTranslatorFor("en"),
    probe,
    pathname,
  });
}

async function render(probe: SessionProbe, pathname: string | null) {
  if (!root) {
    container = document.createElement("div");
    outside = document.createElement("p");
    document.body.append(container, outside);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(bar(probe, pathname));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  outside?.remove();
  signOutCalls.length = 0;
});

const find = (testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`);
const tagOf = (testId: string): string | null => find(testId)?.tagName ?? null;

/** The bar's own nav link to `href`, outside the menu panel. */
function navLink(href: string): HTMLAnchorElement | null {
  return (
    find("top-bar-nav")?.querySelector<HTMLAnchorElement>(
      `a[href="${href}"]`,
    ) ?? null
  );
}

function menuButton(): HTMLButtonElement {
  const button = find("menu-button");
  expect(button?.tagName ?? null).toBe("BUTTON");
  return button as HTMLButtonElement;
}

/** The panel the menu button controls, when it is shown; null when it is not. */
function openPanel(): HTMLElement | null {
  const id = menuButton().getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const panel = document.getElementById(id!);
  return panel && !panel.hidden ? panel : null;
}

async function realClick(element: Element): Promise<void> {
  // The whole sequence a mouse click sends, so a listener on any of them sees it.
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      element.dispatchEvent(
        new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, {
          bubbles: true,
        }),
      );
    }
    (element as HTMLElement).click();
  });
}

describe("what the bar shows", () => {
  test.each(["loading", "unavailable", "signed-out"] as const)(
    "%s: the brand and the language switch, no account controls",
    async (state) => {
      await render({ state }, "/");
      // The brand goes home.
      expect(container.querySelector('a[href="/"]')?.tagName ?? null).toBe("A");
      expect(tagOf("language-switch")).not.toBeNull();
      for (const testId of [
        "top-bar-nav",
        "signed-in-as",
        "sign-out",
        "menu-button",
      ])
        expect([testId, tagOf(testId)]).toEqual([testId, null]);
    },
  );

  test("signed in: the nav, the account's address and Sign out", async () => {
    await render(SIGNED_IN, "/");
    expect(navLink("/")?.tagName ?? null).toBe("A");
    expect(navLink("/account")?.getAttribute("data-testid")).toBe(
      "account-link",
    );
    expect(find("signed-in-as")?.textContent?.trim()).toBe(EMAIL);
    expect(tagOf("menu-button")).toBe("BUTTON");
    expect(tagOf("language-switch")).not.toBeNull();
  });

  test("Sign out signs out to the landing", async () => {
    await render(SIGNED_IN, "/account");
    const button = find("sign-out");
    expect(button?.tagName ?? null).toBe("BUTTON");
    await realClick(button!);
    expect(signOutCalls).toEqual([[{ redirectTo: "/" }]]);
  });

  test.each(["/ops", "/ops/instance-1"])(
    "%s: the brand only, even signed in",
    async (pathname) => {
      // The enabling condition: the same probe off /ops draws the controls.
      await render(SIGNED_IN, "/");
      expect(tagOf("top-bar-nav")).not.toBeNull();
      await render(SIGNED_IN, pathname);
      expect(container.querySelector('a[href="/"]')?.tagName ?? null).toBe("A");
      for (const testId of ["top-bar-nav", "language-switch", "menu-button"])
        expect([testId, tagOf(testId)]).toEqual([testId, null]);
    },
  );
});

// Only an account the server says is an operator gets the way to /ops; the
// /ops pages check the flag again on their own.
describe("the link to the ops floor", () => {
  const opsLinks = (): number =>
    container.querySelectorAll('a[href="/ops"]').length;

  test("an operator has it in the nav and in the menu", async () => {
    await render({ ...SIGNED_IN, operator: true }, "/");
    expect(navLink("/ops")?.tagName ?? null).toBe("A");
    await realClick(menuButton());
    expect(openPanel()?.querySelector('a[href="/ops"]')?.tagName ?? null).toBe(
      "A",
    );
  });

  test.each([false, null])(
    "operator %p: no link to /ops anywhere in the bar",
    async (operator) => {
      await render({ ...SIGNED_IN, operator }, "/");
      // The enabling condition: the nav and the menu are drawn.
      expect(navLink("/account")?.tagName ?? null).toBe("A");
      await realClick(menuButton());
      expect(openPanel()?.tagName ?? null).not.toBeNull();
      expect(opsLinks()).toBe(0);
    },
  );
});

describe("the current page in the nav", () => {
  // "page" on the link's own page, "true" on a page under it, nothing elsewhere.
  const CASES: [string, string | null, string | null][] = [
    ["/", "page", null],
    ["/office/acme", "true", null],
    ["/account", null, "page"],
    ["/account/email", null, "true"],
    ["/signup", null, null],
    ["/unsubscribe", null, null],
  ];
  test.each(CASES)("%s", async (pathname, offices, account) => {
    await render(SIGNED_IN, pathname);
    expect([
      navLink("/")?.getAttribute("aria-current") ?? null,
      navLink("/account")?.getAttribute("aria-current") ?? null,
    ]).toEqual([offices, account]);
  });
});

describe("the menu", () => {
  async function opened(pathname = "/"): Promise<HTMLElement> {
    await render(SIGNED_IN, pathname);
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(openPanel()?.tagName ?? null).toBeNull();
    await realClick(menuButton());
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    const panel = openPanel();
    expect(panel?.tagName ?? null).not.toBeNull();
    return panel!;
  }

  const expectClosed = () => {
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(openPanel()?.tagName ?? null).toBeNull();
  };

  test("holds Offices, Account, the address and Sign out", async () => {
    const panel = await opened();
    expect(panel.querySelector('a[href="/"]')?.tagName ?? null).toBe("A");
    expect(panel.querySelector('a[href="/account"]')?.tagName ?? null).toBe(
      "A",
    );
    expect(panel.textContent).toContain(EMAIL);
    const signOut = [...panel.querySelectorAll("button")].find(
      (button) => button.getAttribute("data-testid") !== "menu-button",
    );
    expect(signOut?.tagName ?? null).toBe("BUTTON");
    await realClick(signOut!);
    expect(signOutCalls).toEqual([[{ redirectTo: "/" }]]);
  });

  test("the button closes it again", async () => {
    await opened();
    await realClick(menuButton());
    expectClosed();
  });

  test("Escape closes it and gives the focus back to the button", async () => {
    // From a link in the panel, where the keyboard user is...
    const panel = await opened();
    const link = panel.querySelector<HTMLElement>('a[href="/account"]')!;
    link.focus();
    await act(async () => {
      link.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expectClosed();
    expect(document.activeElement?.getAttribute("data-testid") ?? null).toBe(
      "menu-button",
    );
    // ...and from the button itself, where a click leaves the focus.
    await realClick(menuButton());
    expect(openPanel()?.tagName ?? null).not.toBeNull();
    menuButton().focus();
    await act(async () => {
      menuButton().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expectClosed();
  });

  test("a click outside closes it; a click inside does not", async () => {
    const panel = await opened();
    // Inside first: a listener that closes on every click fails here.
    const address = [...panel.querySelectorAll("*")].find(
      (element) =>
        element.children.length === 0 && element.textContent?.includes(EMAIL),
    );
    expect(address?.tagName ?? null).not.toBeNull();
    await realClick(address!);
    expect(openPanel()?.tagName ?? null).not.toBeNull();
    await realClick(outside);
    expectClosed();
  });

  test("opening the language list closes it", async () => {
    // The bar is not the menu: two open popups on a phone bar overlap.
    await opened();
    const summary = find("language-switch")?.querySelector("summary");
    expect(summary?.tagName ?? null).toBe("SUMMARY");
    await realClick(summary!);
    expectClosed();
  });

  test("opening it closes the language list", async () => {
    // The other order: the list is open and the menu button is pressed.
    await render(SIGNED_IN, "/");
    const details = find("language-switch")?.querySelector("details");
    expect(details?.tagName ?? null).toBe("DETAILS");
    await realClick(details!.querySelector("summary")!);
    // The enabling condition: the list really is open before the press.
    expect(details!.open).toBe(true);
    await realClick(menuButton());
    expect(openPanel()?.tagName ?? null).not.toBeNull();
    expect(details!.open).toBe(false);
  });

  test("a new page closes it", async () => {
    await opened("/");
    await render(SIGNED_IN, "/account");
    expectClosed();
    // The same page rendered again leaves an open menu open.
    await realClick(menuButton());
    await render(SIGNED_IN, "/account");
    expect(openPanel()?.tagName ?? null).not.toBeNull();
  });
});

describe("the enterprise pages", () => {
  test.each(["/enterprise", "/enterprise/agreement"])(
    "Sign out on %s signs out to the enterprise sign-in page, from the bar and the menu",
    async (pathname) => {
      await render(SIGNED_IN, pathname);
      const button = find("sign-out");
      expect(button?.tagName ?? null).toBe("BUTTON");
      await realClick(button!);
      await realClick(menuButton());
      const panel = openPanel();
      const inMenu = [...(panel?.querySelectorAll("button") ?? [])].find(
        (b) => b.getAttribute("data-testid") !== "menu-button",
      );
      expect(inMenu?.tagName ?? null).toBe("BUTTON");
      await realClick(inMenu!);
      expect(signOutCalls).toEqual([
        [{ redirectTo: "/enterprise/signin" }],
        [{ redirectTo: "/enterprise/signin" }],
      ]);
    },
  );

  test("a page whose path only starts with the same letters is not one", async () => {
    await render(SIGNED_IN, "/enterprises");
    await realClick(find("sign-out")!);
    expect(signOutCalls).toEqual([[{ redirectTo: "/" }]]);
  });
});
