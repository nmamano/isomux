// The storefront's translation, in the parts that cannot live under `web/`.
//
// IT IS OUT HERE for one reason: `web-boundary.test.ts` forbids any file under
// `web/` from containing an operation kind, so that a page cannot ask for one by
// spelling it - and proving that a step label is translated means naming real
// kinds. The page-by-page render tests are in
// `web/components/pages.i18n.test.tsx`, which needs the app's own copy of React
// and therefore has to sit inside it.
//
// No assertion pins translated copy (internal-docs/testing-guide.md, principle
// 15): a translated element is compared with the same element on English, and
// the derivation test, whose claim is which key a kind reaches, reads that key
// from the catalog after proving it differs from English.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  refusalText,
  Steps,
  type RefusalTable,
} from "./web/components/office-view";
import { webTranslatorFor } from "./web/lib/i18n/rich";
import { hidesLanguageSwitch } from "./web/lib/i18n/language-switch";
import {
  languageFromAcceptLanguage,
  languageFromCookie,
} from "./web/lib/i18n/languages";
import { checkoutParams } from "./stripe/checkout";
import type { ProgressView } from "./web/lib/services.server";
import { SUPPORTED_LANGUAGES } from "./web/lib/i18n/languages";
import { REFUSAL_WORDS } from "./requests";
import { CANCEL_REFUSAL_WORDS } from "./cancel";
import { REINSTATEMENT_REFUSAL_WORDS } from "./reinstatement";

const WEB = path.join(import.meta.dir, "web");
const read = (relative: string): string =>
  fs.readFileSync(path.join(WEB, relative), "utf8");

type Kind = ProgressView["steps"][number]["kind"];

/** The rendered text as a reader sees it. React escapes an apostrophe as
 * `&#x27;`, and several of these labels carry one. */
function text(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The label and the state word of one rendered step; both must be present. */
function stepText(
  html: string,
  kind: string,
): { label: string; state: string } {
  const li = text(html).match(
    new RegExp(
      `<li data-testid="step-${kind}">(.*?) - <span data-state="[^"]*">([^<]*)</span>`,
    ),
  );
  expect([
    kind,
    (li?.[1] ?? "").length > 0,
    (li?.[2] ?? "").length > 0,
  ]).toEqual([kind, true, true]);
  return { label: li![1], state: li![2] };
}

function step(kind: string, label: string, state: string) {
  return {
    kind: kind as Kind,
    label,
    state: state as ProgressView["steps"][number]["state"],
    detail: null,
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
  };
}

describe("the step ladder", () => {
  test("a real step kind reaches its translated label", () => {
    // THE DERIVATION IS WHAT THIS PROVES. `keyForId` builds the catalog key from
    // the kind rather than from a table of kinds, so a broken transform would
    // fall back to the English label the projection sent and every other test
    // would still pass. These are real kinds from control-plane/progress.ts,
    // each with the key its kind must reach.
    const cases = [
      [
        "create_instance",
        "Ordering your server",
        "done",
        "steps.labelCreateInstance",
      ],
      ["reboot", "Restarting your server", "active", "steps.labelReboot"],
      [
        "wait_for_package_manager",
        "Waiting for the server's package manager",
        "waiting",
        "steps.labelWaitForPackageManager",
      ],
    ] as const;
    const render = (language: "en" | "ca") =>
      renderToStaticMarkup(
        <Steps
          i18n={webTranslatorFor(language)}
          testid="kinds"
          now={null}
          steps={cases.map(([kind, label, state]) => step(kind, label, state))}
        />,
      );
    const en = render("en");
    const ca = render("ca");
    const catalan = webTranslatorFor("ca");
    const english = webTranslatorFor("en");
    for (const [kind, delivered, , key] of cases) {
      expect([key, catalan.t(key)]).not.toEqual([key, english.t(key)]);
      expect([kind, stepText(ca, kind).label]).toEqual([kind, catalan.t(key)]);
      // The English the projection sent is gone.
      expect([kind, stepText(ca, kind).label]).not.toEqual([kind, delivered]);
      expect([kind, stepText(ca, kind).state]).not.toEqual([
        kind,
        stepText(en, kind).state,
      ]);
    }
    // Three states, three different words.
    expect(new Set(cases.map(([kind]) => stepText(ca, kind).state)).size).toBe(
      3,
    );
    // No key leaked as text.
    expect(ca).not.toContain("steps.label");
  });

  test("every kind the control plane can send has a key", () => {
    // The whole ladder at once, so a kind added to progress.ts without a
    // catalog entry fails here rather than quietly reading English in
    // production. The English label is deliberately wrong text, so a fallback
    // is visible.
    const kinds = [
      "create_instance",
      "wait_for_address",
      "wait_for_ssh",
      "first_contact",
      "install_customer_key",
      "arm_revocation",
      "wait_for_package_manager",
      "set_dns",
      "run_installer",
      "verify_https",
      "mint_invite",
      "revoke_access",
      "power_off",
      "reboot",
      "power_on",
      "expire_checkout",
      "cancel_asset",
      "remove_dns",
    ];
    const labels = Object.fromEntries(
      [...read("../progress.ts").matchAll(/^\s+(\w+): "([^"]+)",$/gm)].map(
        (m) => [m[1], m[2]],
      ),
    );
    for (const kind of kinds) {
      // The label table in progress.ts is the source of the English.
      expect([kind, typeof labels[kind]]).toEqual([kind, "string"]);
      const render = (language: "en" | "es") =>
        renderToStaticMarkup(
          <Steps
            i18n={webTranslatorFor(language)}
            testid="one"
            now={null}
            steps={[step(kind, labels[kind], "done")]}
          />,
        );
      // English first: this proves the label was extracted correctly, so the
      // Spanish assertion below cannot pass by comparing against the wrong
      // string.
      expect([kind, text(render("en")).includes(labels[kind])]).toEqual([
        kind,
        true,
      ]);
      expect([kind, text(render("es")).includes(labels[kind])]).toEqual([
        kind,
        false,
      ]);
    }
  });

  test("the office page's own synthetic step is translated too", () => {
    // `waiting-for-payment` is invented by office-view rather than sent by the
    // control plane, so it is absent from the progress.ts table the check above
    // walks. Its label is the English fallback; the key is the normal path.
    const delivered = "Waiting for payment";
    const render = (language: "en" | "es") =>
      renderToStaticMarkup(
        <Steps
          i18n={webTranslatorFor(language)}
          testid="synthetic"
          now={null}
          steps={[step("waiting-for-payment", delivered, "active")]}
        />,
      );
    const es = stepText(render("es"), "waiting-for-payment").label;
    expect(es).not.toBe(delivered);
    expect(es).not.toBe(stepText(render("en"), "waiting-for-payment").label);
  });

  test("an unknown kind falls back to the English the projection sent", () => {
    const render = (language: "en" | "ca") =>
      renderToStaticMarkup(
        <Steps
          i18n={webTranslatorFor(language)}
          testid="unknown"
          now={null}
          steps={[
            step("a_kind_from_the_future", "Doing something new", "active"),
          ]}
        />,
      );
    const ca = stepText(render("ca"), "a_kind_from_the_future");
    expect(ca.label).toBe("Doing something new");
    // The state word is still the reader's.
    expect(ca.state).not.toBe(
      stepText(render("en"), "a_kind_from_the_future").state,
    );
  });

  test("a running step's spoken duration is pluralized by the reader's rules", () => {
    const spoken = (
      language: "en" | "es" | "ca",
      elapsedMs: number,
    ): string => {
      const html = renderToStaticMarkup(
        <Steps
          i18n={webTranslatorFor(language)}
          testid="spoken"
          now={elapsedMs}
          steps={[
            {
              ...step("run_installer", "Installing isomux", "active"),
              startedAt: 0,
            },
          ]}
        />,
      );
      const label = text(html).match(/aria-label="([^"]*)"/)?.[1] ?? "";
      expect(label.length).toBeGreaterThan(0);
      return label;
    };
    // The phrase with its count taken out, so two counts compare on words only.
    const words = (
      language: "en" | "es" | "ca",
      elapsedMs: number,
      count: number,
    ) => {
      const label = spoken(language, elapsedMs);
      expect([label, label.includes(String(count))]).toEqual([label, true]);
      return label.replace(String(count), "#");
    };
    for (const language of ["en", "es", "ca"] as const) {
      const one = words(language, 1_000, 1);
      const two = words(language, 2_000, 2);
      // One second is singular, two are plural, and zero takes the plural.
      expect([language, one]).not.toEqual([language, two]);
      expect([language, words(language, 0, 0)]).toEqual([language, two]);
      // Seconds, minutes and hours are three units.
      const units = [
        one,
        words(language, 60_000, 1),
        words(language, 3_600_000, 1),
      ];
      expect([language, new Set(units).size]).toEqual([language, 3]);
      // Minutes pluralize too.
      expect([language, words(language, 120_000, 2)]).not.toEqual([
        language,
        words(language, 60_000, 1),
      ]);
    }
    for (const language of ["es", "ca"] as const)
      for (const elapsedMs of [1_000, 2_000, 120_000])
        expect([language, elapsedMs, spoken(language, elapsedMs)]).not.toEqual([
          language,
          elapsedMs,
          spoken("en", elapsedMs),
        ]);
  });
});

describe("refusals", () => {
  /** What the server sent beside the code. Not a real sentence, so a fallback
   * is visible. */
  const DELIVERED = "The sentence the server sent";

  /** Every code each table can put on the wire, read from the tables
   * themselves, so a code added without a catalog sentence fails here. The two
   * Stripe codes never travel: the facade turns them into its own translated
   * failure with a reference, and sends no code. */
  const TABLES: [RefusalTable, string[]][] = [
    ["request", Object.keys(REFUSAL_WORDS)],
    [
      "cancel",
      Object.keys(CANCEL_REFUSAL_WORDS).filter(
        (code) => code !== "stripe_unavailable" && code !== "stripe_ambiguous",
      ),
    ],
    ["reinstatement", Object.keys(REINSTATEMENT_REFUSAL_WORDS)],
  ];

  test("every refusal code the control plane can send reads in the reader's language", () => {
    for (const [table, codes] of TABLES) {
      expect([table, codes.length > 0]).toEqual([table, true]);
      for (const code of codes) {
        const english = refusalText(
          webTranslatorFor("en"),
          table,
          code,
          DELIVERED,
        );
        // A catalog sentence, not the fallback.
        expect([table, code, english === DELIVERED]).toEqual([
          table,
          code,
          false,
        ]);
        expect([table, code, english.trim().length > 0]).toEqual([
          table,
          code,
          true,
        ]);
        for (const { code: language } of SUPPORTED_LANGUAGES) {
          if (language === "en") continue;
          const translated = refusalText(
            webTranslatorFor(language),
            table,
            code,
            DELIVERED,
          );
          expect([table, code, language, translated === DELIVERED]).toEqual([
            table,
            code,
            language,
            false,
          ]);
          expect([table, code, language, translated === english]).toEqual([
            table,
            code,
            language,
            false,
          ]);
        }
      }
    }
  });

  test("a code the page has no sentence for falls back to what the server sent", () => {
    const spanish = webTranslatorFor("es");
    const unknown: [RefusalTable, unknown][] = [
      ["request", "a_code_from_the_future"],
      ["request", undefined],
      ["request", null],
      ["request", 42],
      ["request", ""],
      // An own property of every object, not of the catalog.
      ["request", "constructor"],
      // A code of ANOTHER table: codes repeat across tables with different
      // words, so a code only reads in the table that sent it.
      ["cancel", "not_live"],
      ["request", "too_late"],
      ["reinstatement", "already_cancelled"],
    ];
    for (const [table, code] of unknown) {
      expect([
        table,
        code,
        refusalText(spanish, table, code, DELIVERED),
      ]).toEqual([table, code, DELIVERED]);
    }
    // The same codes DO read in their own tables, so the cases above are
    // refused for being foreign, not for being unknown everywhere.
    for (const [table, code] of [
      ["request", "not_live"],
      ["reinstatement", "too_late"],
      ["cancel", "already_cancelled"],
    ] as const) {
      expect([
        table,
        code,
        refusalText(spanish, table, code, DELIVERED),
      ]).not.toEqual([table, code, DELIVERED]);
    }
  });
});

describe("language resolution", () => {
  test("the cookie beats the header, and the header decides without one", () => {
    // The precedence the pages implement, over its two inputs: a switch a
    // header could beat would not be a switch.
    const resolve = (cookie: string | null, header: string | null) =>
      languageFromCookie(cookie) ?? languageFromAcceptLanguage(header);
    expect(resolve("ca", "es-ES,es;q=0.9")).toBe("ca");
    expect(resolve("en", "ca")).toBe("en");
    expect(resolve(null, "es-ES,es;q=0.9")).toBe("es");
    expect(resolve("fr", "ca")).toBe("ca");
    expect(resolve(null, null)).toBe("en");
  });

  test("the two server pages resolve from the request, and ops does not", () => {
    for (const page of [
      "app/signup/page.tsx",
      "app/office/[officeKey]/page.tsx",
    ]) {
      expect([page, read(page).includes("languageForRequest()")]).toEqual([
        page,
        true,
      ]);
      // The translated region is marked for a reader with no JavaScript.
      expect([page, read(page).includes("lang={language}")]).toEqual([
        page,
        true,
      ]);
    }
    for (const page of ["app/ops/page.tsx", "app/ops/[instanceId]/page.tsx"]) {
      const source = read(page);
      expect([page, source.includes("languageForRequest")]).toEqual([
        page,
        false,
      ]);
      expect([page, source.includes("OPS_LANGUAGE")]).toEqual([page, true]);
    }
  });

  test("the switch is hidden on ops and shown everywhere else", () => {
    expect(hidesLanguageSwitch("/ops")).toBe(true);
    expect(hidesLanguageSwitch("/ops/instance-1")).toBe(true);
    expect(hidesLanguageSwitch("/")).toBe(false);
    expect(hidesLanguageSwitch("/signin")).toBe(false);
    expect(hidesLanguageSwitch("/signup")).toBe(false);
    expect(hidesLanguageSwitch("/office/acme")).toBe(false);
    // Not a bare prefix match: an office named "opsomething" is a customer page.
    expect(hidesLanguageSwitch("/opsomething")).toBe(false);
    expect(hidesLanguageSwitch(null)).toBe(false);
  });

  test("every page declares its language to the document", () => {
    for (const page of [
      "app/home-view.tsx",
      "app/signin/signin-form.tsx",
      "app/signup/page.tsx",
      "app/office/[officeKey]/page.tsx",
      "app/ops/page.tsx",
      "app/ops/[instanceId]/page.tsx",
    ]) {
      expect([page, read(page).includes("<DocumentLanguage")]).toEqual([
        page,
        true,
      ]);
    }
  });
});

describe("the Stripe-hosted page", () => {
  test("the create body carries no locale", () => {
    // THE LANGUAGE SWITCH DOES NOT REACH STRIPE'S OWN PAGE, deliberately. The
    // session's idempotency key is derived from stored state, so a replay of one
    // generation must send a byte-identical body, and a locale read from the
    // request is the one input a language switch could change between a lost
    // response and its retry. Checkout follows the customer's browser instead.
    // (PM ruling, 2026-09-06.) This pins the body, not the comment that explains
    // it: a re-added locale fails here and has to read the reason first.
    const body = checkoutParams({
      accountId: "acct-1",
      email: "a@example.com",
      officeName: "acme",
      priceId: "price_1",
      successUrl: "https://cloud.isomux.com/office/acme",
      cancelUrl: "https://cloud.isomux.com/signup",
    });
    expect("locale" in body).toBe(false);
    expect(Object.keys(body)).not.toContain("locale");
  });

  test("both checkout paths still resolve the request's language for our own copy", () => {
    // The refusals these two routes return ARE translated; only Stripe's page
    // is not.
    for (const route of [
      "app/api/signup/route.ts",
      "app/api/reinstate/route.ts",
    ]) {
      expect([route, read(route).includes("languageForRequest()")]).toEqual([
        route,
        true,
      ]);
    }
  });
});
