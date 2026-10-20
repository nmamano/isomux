// The storefront's pages in Spanish, Catalan and Chinese
// (internal-docs/i18n-loop.md, S11). Its sibling
// `control-plane/web-i18n.test.tsx` holds the parts that have to name an
// operation kind, which no file under web/ may do.
//
// No assertion pins translated copy (internal-docs/testing-guide.md, principle
// 15). Each page is rendered on English too, and every text a reader meets must
// differ from the same text on English, except the data the page carries
// (names, hostnames, plan figures, dates), which must stay the same.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignedOut, Dashboard } from "../app/home-view";
import { SignupForm } from "./signup-form";
import { OfficeView } from "./office-view";
import { PolicyNotice } from "./policy-notice";
import { UnsubscribeView } from "./unsubscribe-view";
import { customerPriceLine } from "./plan-copy";
import { webTranslatorFor } from "../lib/i18n/rich";
import type { ProgressView } from "../lib/services.server";

type Language = "en" | "es" | "ca" | "zh";

function decode(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The text a reader meets in a render, in document order: every text node,
 * and the placeholder and aria-label attributes. */
function texts(html: string): string[] {
  return [
    ...html.matchAll(/>([^<]+)<|\b(?:placeholder|aria-label)="([^"]*)"/gu),
  ]
    .map((m) => decode(m[1] ?? m[2]).trim())
    .filter(Boolean);
}

/** The text of every link, in order. */
function links(html: string): string[] {
  return [...html.matchAll(/<a [^>]*>([^<]*)<\/a>/gu)].map((m) => decode(m[1]));
}

const PUNCTUATION = /^[\p{P}\s→]*$/u;

/** Every text of `local` differs from the same text of the English render,
 * except bare punctuation and the `data` the page carries, which must be the
 * same. `data` must occur on the English render, so a stale entry fails. */
function expectTranslated(
  local: string,
  en: string,
  data: string[] = [],
): void {
  const localized = texts(local);
  const english = texts(en);
  expect(english.length).toBeGreaterThan(0);
  expect(localized.length).toBe(english.length);
  for (const value of data)
    expect([value, english.includes(value)]).toEqual([value, true]);
  for (const [index, text] of english.entries()) {
    if (PUNCTUATION.test(text)) continue;
    if (data.includes(text))
      expect([index, localized[index]]).toEqual([index, text]);
    else expect([index, localized[index]]).not.toEqual([index, text]);
  }
}

const policyNames = links(renderToStaticMarkup(<PolicyNotice language="en" />));

describe("the prerendered shells", () => {
  test("the signed-out landing reads every language", () => {
    const render = (language: Language) =>
      renderToStaticMarkup(<SignedOut i18n={webTranslatorFor(language)} />);
    // The product name is not copy (ruling 11) and is the same in all of them.
    for (const language of ["es", "ca", "zh"] as const)
      expectTranslated(render(language), render("en"), ["Hosted Isomux"]);
  });

  test("the dashboard reads every language, and its heading follows the English split", () => {
    const office = {
      instanceId: "i-1",
      officeName: "acme",
      hostname: "acme.isomux.app",
      ready: true,
      ended: false,
    };
    const render = (language: Language, count: 0 | 1 | 2) =>
      renderToStaticMarkup(
        <Dashboard
          i18n={webTranslatorFor(language)}
          email="a@example.com"
          offices={[
            office,
            { ...office, instanceId: "i-2", ready: false },
          ].slice(0, count)}
        />,
      );
    const heading = (html: string) => {
      const text = html.match(/<h1>([^<]*)<\/h1>/u)?.[1] ?? "";
      expect(text.length).toBeGreaterThan(0);
      return decode(text);
    };
    for (const language of ["en", "es", "ca", "zh"] as const) {
      for (const count of [0, 1, 2] as const) {
        const html = render(language, count);
        expect([language, count, html.includes("a@example.com")]).toEqual([
          language,
          count,
          true,
        ]);
        if (language !== "en")
          expectTranslated(
            html,
            render("en", count),
            count ? ["acme.isomux.app"] : [],
          );
      }
      // ZERO OFFICES KEEPS THE SINGULAR, in every language: the English splits
      // at more than one, and Intl.PluralRules would have moved it.
      expect([language, heading(render(language, 0))]).toEqual([
        language,
        heading(render(language, 1)),
      ]);
      // Chinese writes one office and two the same way.
      if (language !== "zh")
        expect([language, heading(render(language, 2))]).not.toEqual([
          language,
          heading(render(language, 1)),
        ]);
    }
  });
});

describe("the sign-up page", () => {
  const plans = [
    {
      id: "office",
      label: "Entry",
      specification: "4 vCPU, 8 GB RAM, 100 GB SSD",
      customerPrice: {
        amount: 8,
        currency: "EUR" as const,
        billingPeriod: "month" as const,
      },
    },
  ];
  const render = (language: Language) =>
    renderToStaticMarkup(
      <SignupForm
        language={language}
        domain="isomux.app"
        initialName=""
        plans={plans}
      />,
    );

  test("reads every language and keeps the plan name and specification", () => {
    // Plan name, hardware figures and the example address are data, not copy
    // (ruling 11).
    for (const language of ["es", "ca", "zh"] as const)
      expectTranslated(render(language), render("en"), [
        "Entry",
        "4 vCPU, 8 GB RAM, 100 GB SSD",
        "your-name.isomux.app",
        ...policyNames,
      ]);
  });

  test("formats the price for the reader", () => {
    const english = customerPriceLine("en", plans[0].customerPrice)!;
    for (const language of ["en", "es", "ca", "zh"] as const) {
      const line = customerPriceLine(language, plans[0].customerPrice)!;
      const amount = new Intl.NumberFormat(language, {
        style: "currency",
        currency: "EUR",
      }).format(8);
      expect([language, line.includes(amount)]).toEqual([language, true]);
      if (language !== "en")
        expect([language, line]).not.toEqual([language, english]);
    }
  });

  test("the policy notice keeps the English document names in every language", () => {
    expect(policyNames.length).toBe(3);
    const en = renderToStaticMarkup(<PolicyNotice language="en" />);
    for (const language of ["es", "ca", "zh"] as const) {
      const html = renderToStaticMarkup(<PolicyNotice language={language} />);
      expect([language, links(html)]).toEqual([language, policyNames]);
      expectTranslated(html, en, policyNames);
    }
  });
});

const baseView: ProgressView = {
  asOf: 0,
  instanceId: "instance-i18n",
  officeName: "acme",
  hostname: "acme.isomux.app",
  sshTarget: null,
  plan: "V153",
  tier: {
    label: "Entry",
    specification: "4 vCPU, 8 GB RAM, 100 GB SSD",
    customerPrice: { amount: 8, currency: "EUR", billingPeriod: "month" },
  },
  serviceState: "live",
  goal: "live",
  origin: "created",
  steps: [],
  otherOperations: [],
  ready: false,
  ended: false,
  attention: [],
  access: { state: "gone", expiresAt: null, ceilingProven: true },
  handoff: {
    canMint: false,
    invite: { state: "none", operationId: null, mintedAt: null },
    revocation: { state: "done", customerConfirmed: true, confirmedAt: 0 },
  },
  liveness: null,
  restart: { state: "none", active: false, lastRequestedAt: null },
  subscription: null,
  lifecycle: null,
};

// The page's data, the same in every language.
const OFFICE_DATA = [
  "acme.isomux.app",
  "Entry",
  "4 vCPU, 8 GB RAM, 100 GB SSD",
  ...policyNames,
];

function office(language: Language, view: ProgressView): string {
  return renderToStaticMarkup(
    <OfficeView
      language={language}
      initial={view}
      instanceId="instance-i18n"
    />,
  );
}

describe("the office page", () => {
  test("reads Catalan and Spanish across its sections", () => {
    for (const language of ["es", "ca"] as const) {
      const html = office(language, baseView);
      expectTranslated(html, office("en", baseView), OFFICE_DATA);
      // The translated region carries its own lang for a reader with no
      // JavaScript, because the root layout's attribute is a static "en".
      expect(html).toContain(`<main lang="${language}">`);
    }
  });

  test("a liveness rung and an attention class reach their translated words", () => {
    const view: ProgressView = {
      ...baseView,
      ready: true,
      liveness: {
        rung: "tls",
        words: "waiting for the certificate",
        strikes: 0,
        checkedAt: 0,
        unreachable: false,
      },
      attention: [
        {
          reasonClass: "absolute_deadline",
          severity: "warning",
          raisedAt: 0,
          acknowledged: true,
          summary:
            "A step has passed its time limit. We will check your setup.",
        },
      ],
    };
    const html = office("ca", view);
    expectTranslated(html, office("en", view), [
      ...OFFICE_DATA,
      "llc@isomux.com",
    ]);
    // The English the projection sent is gone, not merely accompanied.
    expect(html).not.toContain("waiting for the certificate");
    expect(html).not.toContain("A step has passed its time limit");
  });

  test("an unknown liveness rung falls back to the English the projection sent", () => {
    const words = "we could not classify the last check";
    const view: ProgressView = {
      ...baseView,
      ready: true,
      liveness: {
        rung: "a-rung-from-the-future",
        words,
        strikes: 0,
        checkedAt: 0,
        unreachable: false,
      },
    };
    // The check line: the reader's own prefix around the projection's words.
    const prefix = (html: string) => {
      const line = texts(html).find((text) => text.includes(words)) ?? "";
      expect(line.length).toBeGreaterThan(words.length);
      return line.slice(0, line.indexOf(words));
    };
    const ca = office("ca", view);
    expect(prefix(ca).length).toBeGreaterThan(0);
    expect(prefix(ca)).not.toBe(prefix(office("en", view)));
    expect(ca).not.toContain("liveness.label");
  });

  test("the cancellation panel reads Catalan with its proven dates intact", () => {
    const view: ProgressView = {
      ...baseView,
      ready: true,
      subscription: {
        status: "active",
        currentPeriodEnd: Date.UTC(2026, 0, 2),
        cancelAtPeriodEnd: true,
        comped: false,
        endedAt: null,
        customerCancelled: true,
        cancellationPolicy: "launch",
      },
    };
    const ca = office("ca", view);
    const en = office("en", view);
    // Stripe's own status word, next to the plan name, is data (ruling 11).
    expectTranslated(ca, en, [...OFFICE_DATA.slice(0, 3), "Entry - active,"]);
    // The ISO date is data too: the scheduled-end sentence carries it, and
    // every text that carries it on English carries it on Catalan.
    const scheduledEnd = (html: string) =>
      html.match(/data-testid="cancel-scheduled"><p>([^<]*)<\/p>/u)?.[1] ?? "";
    for (const html of [en, ca])
      expect(scheduledEnd(html)).toContain("2026-01-02");
    const dated = (html: string) =>
      texts(html).map((text) => text.includes("2026-01-02"));
    expect(dated(ca)).toEqual(dated(en));
  });
});

describe("the unsubscribe page", () => {
  test("reads every language, with and without a token", () => {
    for (const token of ["Zm9vYmFy", null]) {
      const render = (language: Language) =>
        renderToStaticMarkup(
          <UnsubscribeView token={token} language={language} />,
        );
      for (const language of ["es", "ca", "zh"] as const)
        expectTranslated(render(language), render("en"));
    }
  });
});
