// The landing's two bodies: the signed-out hero and the office list.
//
// The hero sends a visitor to sign in, or to the product site in their own
// language. Each office card is one link to its office and carries the plan
// and the price; a deleted office's card is marked ended and shows no price,
// because nothing is charged for it. The head offers another office only to an
// account that has one.
//
// An account with an enterprise account and no Hosted office has nothing on
// this page: it is sent to /enterprise, and the empty office list is not drawn.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OfficeCard } from "../lib/session-view";
import type { SupportedLanguageCode } from "../lib/i18n/languages";

GlobalRegistrator.register({ url: "http://localhost:3999/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Where the page sends the visitor, by the router or by the location.
const moves: string[] = [];
const nextNavigation = await import("next/navigation");
const realNextNavigation = { ...nextNavigation };
const router = {
  replace: (href: string) => void moves.push(href),
  push: (href: string) => void moves.push(href),
  prefetch: () => undefined,
  refresh: () => undefined,
  back: () => undefined,
  forward: () => undefined,
};
await mock.module("next/navigation", () => ({
  ...realNextNavigation,
  useRouter: () => router,
}));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Dashboard, HomeView, SignedOut } = await import("./home-view");
const { webTranslatorFor } = await import("../lib/i18n/rich");
const { customerPriceLine } = await import("../components/plan-copy");

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await mock.module("next/navigation", () => realNextNavigation);
  await GlobalRegistrator.unregister();
});

// Element presence is asserted on its tag name, never on the node: a failing
// matcher on a DOM node serialises it, which is slow and unreadable.
function mount(html: string): HTMLElement {
  const box = document.createElement("div");
  box.innerHTML = html;
  return box;
}

const PRICE = {
  amounts: { USD: 9, EUR: 8 },
  billingPeriod: "month",
} as const;
const office: OfficeCard = {
  instanceId: "i-1",
  officeName: "acme",
  hostname: "acme.isomux.app",
  ready: true,
  ended: false,
  plan: {
    label: "Entry",
    specification: "4 vCPU, 8 GB RAM, 100 GB SSD",
    customerPrice: PRICE,
    currency: "EUR",
  },
};

function dashboard(offices: OfficeCard[]): HTMLElement {
  return mount(
    renderToStaticMarkup(
      createElement(Dashboard, { i18n: webTranslatorFor("en"), offices }),
    ),
  );
}

function card(box: HTMLElement, name: string): HTMLAnchorElement {
  const link = box.querySelector<HTMLAnchorElement>(
    `a[href="/office/${name}"]`,
  );
  expect([name, link?.tagName ?? null]).toEqual([name, "A"]);
  return link!;
}

describe("the office list", () => {
  test("each card links to its office and carries its plan and price", () => {
    const box = dashboard([
      office,
      {
        ...office,
        instanceId: "i-2",
        officeName: "lab",
        hostname: "lab.isomux.app",
        ready: false,
        plan: {
          label: "Poweruser",
          specification: "8 vCPU, 24 GB RAM, 300 GB SSD",
          customerPrice: { ...PRICE, amounts: { USD: 19, EUR: 17 } },
          currency: "USD",
        },
      },
    ]);
    expect(
      box.querySelector('[data-testid="dashboard"]')?.tagName ?? null,
    ).not.toBeNull();
    // Each card shows what its subscription pays, in that currency alone.
    const cases = [
      ["acme", "acme.isomux.app", "Entry", "4 vCPU", "€8.00", "$", "done"],
      ["lab", "lab.isomux.app", "Poweruser", "8 vCPU", "$19.00", "€", "active"],
    ] as const;
    for (const [name, hostname, label, spec, paid, other, state] of cases) {
      const text = card(box, name).textContent ?? "";
      expect([name, text.includes(hostname)]).toEqual([name, true]);
      expect([name, text.includes(label)]).toEqual([name, true]);
      expect([name, text.includes(spec)]).toEqual([name, true]);
      expect([name, text.includes(paid)]).toEqual([name, true]);
      expect([name, text.includes(other)]).toEqual([name, false]);
      expect([
        name,
        card(box, name)
          .querySelector("[data-state]")
          ?.getAttribute("data-state"),
      ]).toEqual([name, state]);
      expect([name, card(box, name).hasAttribute("data-ended")]).toEqual([
        name,
        false,
      ]);
    }
  });

  test("a deleted office is marked ended and shows no price", () => {
    const box = dashboard([
      { ...office, ready: false, ended: true },
      { ...office, instanceId: "i-2", officeName: "live" },
    ]);
    const ended = card(box, "acme");
    const live = card(box, "live");
    const price = customerPriceLine("en", PRICE, "EUR")!;
    // The enabling condition: the live card with the same plan shows the price.
    expect(live.textContent).toContain(price);
    expect(ended.hasAttribute("data-ended")).toBe(true);
    expect(
      ended.querySelector("[data-state]")?.getAttribute("data-state"),
    ).toBe("ended");
    expect(ended.textContent).toContain("Entry");
    expect(ended.textContent).not.toContain(price);
  });

  test("the head offers another office only to an account that has one", () => {
    const one = dashboard([office]);
    expect(
      one.querySelector('a[href="/signup?another=1"]')?.textContent?.trim(),
    ).toBeTruthy();
    const none = dashboard([]);
    expect(
      none.querySelector('a[href="/signup?another=1"]')?.tagName ?? null,
    ).toBeNull();
    // An account with no office is offered its first one instead.
    expect(none.querySelector('a[href="/signup"]')?.tagName ?? null).toBe("A");
  });
});

describe("the signed-out hero", () => {
  const hero = (language: SupportedLanguageCode) =>
    mount(
      renderToStaticMarkup(
        createElement(SignedOut, { i18n: webTranslatorFor(language) }),
      ),
    );

  // The product site's front page in each storefront language.
  const SITE: Record<SupportedLanguageCode, string> = {
    en: "https://isomux.com/",
    es: "https://isomux.com/es/",
    ca: "https://isomux.com/ca/",
    zh: "https://isomux.com/zh/",
  };

  test.each(Object.keys(SITE) as SupportedLanguageCode[])(
    "%s: sign in, or read about Isomux in the same language",
    (language) => {
      const box = hero(language);
      expect(box.querySelector('a[href="/signin"]')?.tagName ?? null).toBe("A");
      const site = box.querySelector(`a[href="${SITE[language]}"]`);
      expect([language, site?.textContent?.trim() || null]).not.toEqual([
        language,
        null,
      ]);
      // No other language's page is linked.
      const others = Object.entries(SITE).filter(([code]) => code !== language);
      for (const [code, href] of others)
        expect([code, box.querySelector(`a[href="${href}"]`)]).toEqual([
          code,
          null,
        ]);
    },
  );

  test("the office art is decorative, reserves its box, and is a small file", () => {
    const image = hero("en").querySelector("img");
    expect(image?.tagName ?? null).toBe("IMG");
    expect(image!.getAttribute("alt")).toBe("");
    expect(Number(image!.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(image!.getAttribute("height"))).toBeGreaterThan(0);
    const src = image!.getAttribute("src") ?? "";
    expect(src.startsWith("/")).toBe(true);
    const file = path.join(import.meta.dir, "..", "public", src);
    expect(fs.statSync(file).size).toBeLessThan(40 * 1024);
  });
});

describe("an account with an enterprise account", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let box: HTMLElement | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    box?.remove();
    moves.length = 0;
    globalThis.fetch = realFetch;
  });

  /** The landing once the probe has answered with this account. */
  async function landing(
    offices: OfficeCard[],
    enterprise: boolean,
  ): Promise<{ moves: string[]; dashboard: boolean }> {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.href,
      );
      if (
        url.pathname !== "/api/session" ||
        url.searchParams.get("offices") !== "1"
      )
        return new Response("{}", { status: 404 });
      return Response.json({
        signedIn: true,
        email: "it@acme.example",
        offices,
        enterprise,
      });
    }) as typeof fetch;
    const replace = spyOn(window.location, "replace").mockImplementation(
      (url: string | URL) => void moves.push(String(url)),
    );
    try {
      box = document.createElement("div");
      document.body.append(box);
      root = createRoot(box);
      await act(async () => {
        root!.render(createElement(HomeView));
      });
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    } finally {
      replace.mockRestore();
    }
    return {
      moves: [...moves],
      dashboard: box.querySelector('[data-testid="dashboard"]') !== null,
    };
  }

  test("and no office: sent to /enterprise, no office list drawn", async () => {
    const seen = await landing([], true);
    expect(
      seen.moves.map((href) => new URL(href, "http://x").pathname),
    ).toEqual(["/enterprise"]);
    expect(seen.dashboard).toBe(false);
  });

  test.each([
    ["an office and an enterprise account", [office], true],
    ["no office and no enterprise account", [], false],
    ["an office and no enterprise account", [office], false],
  ] as [string, OfficeCard[], boolean][])(
    "%s: the office list, and no move",
    async (_name, offices, enterprise) => {
      const seen = await landing(offices, enterprise);
      expect(seen.moves).toEqual([]);
      expect(seen.dashboard).toBe(true);
    },
  );
});
