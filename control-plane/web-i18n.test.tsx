// The storefront's translation, in the parts that cannot live under `web/`.
//
// IT IS OUT HERE for one reason: `web-boundary.test.ts` forbids any file under
// `web/` from containing an operation kind, so that a page cannot ask for one by
// spelling it - and proving that a step label is translated means naming real
// kinds. The page-by-page render tests are in
// `web/components/pages.i18n.test.tsx`, which needs the app's own copy of React
// and therefore has to sit inside it.
//
// Every assertion is a LITERAL translated string (ruling 14).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as fs from "node:fs";
import * as path from "node:path";
import { Steps } from "./web/components/office-view";
import { webTranslatorFor } from "./web/lib/i18n/rich";
import { hidesLanguageSwitch } from "./web/lib/i18n/language-switch";
import {
  languageFromAcceptLanguage,
  languageFromCookie,
} from "./web/lib/i18n/languages";
import { checkoutParams } from "./stripe/checkout";
import type { ProgressView } from "./web/lib/services.server";

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
    // would still pass. These are real kinds from control-plane/progress.ts.
    const html = renderToStaticMarkup(
      <Steps
        i18n={webTranslatorFor("ca")}
        testid="kinds"
        now={null}
        steps={[
          step("create_instance", "Ordering your server", "done"),
          step("reboot", "Restarting your server", "active"),
          step(
            "wait_for_package_manager",
            "Waiting for the server's package manager",
            "waiting",
          ),
        ]}
      />,
    );
    expect(html).toContain("Demanant el teu servidor");
    expect(html).toContain("Reiniciant el teu servidor");
    expect(html).toContain("Esperant el gestor de paquets del servidor");
    expect(html).toContain("fet");
    expect(html).toContain("en curs");
    expect(html).toContain("sense començar");
    // The English the projection sent is gone, and no key leaked as text.
    expect(html).not.toContain("Ordering your server");
    expect(html).not.toContain("steps.label");
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
      // string. English also stays byte-identical (ruling 6).
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
    const html = renderToStaticMarkup(
      <Steps
        i18n={webTranslatorFor("es")}
        testid="synthetic"
        now={null}
        steps={[step("waiting-for-payment", "Waiting for payment", "active")]}
      />,
    );
    expect(html).toContain("Esperando el pago");
    expect(html).not.toContain("Waiting for payment");
    expect(
      renderToStaticMarkup(
        <Steps
          i18n={webTranslatorFor("en")}
          testid="synthetic"
          now={null}
          steps={[step("waiting-for-payment", "Waiting for payment", "active")]}
        />,
      ),
    ).toContain("Waiting for payment");
  });

  test("an unknown kind falls back to the English the projection sent", () => {
    const html = renderToStaticMarkup(
      <Steps
        i18n={webTranslatorFor("ca")}
        testid="unknown"
        now={null}
        steps={[step("a_kind_from_the_future", "Doing something new", "active")]}
      />,
    );
    expect(html).toContain("Doing something new");
    expect(html).toContain("en curs");
  });

  test("a running step's spoken duration is pluralized by the reader's rules", () => {
    const spoken = (language: "en" | "es" | "ca", elapsedMs: number): string => {
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
      return html.match(/aria-label="([^"]*)"/)?.[1] ?? "";
    };
    // English is unchanged at every boundary the old code split at.
    expect(spoken("en", 1_000)).toBe("running for 1 second");
    expect(spoken("en", 2_000)).toBe("running for 2 seconds");
    expect(spoken("en", 0)).toBe("running for 0 seconds");
    expect(spoken("en", 3_600_000)).toBe("running for 1 hour");
    expect(spoken("es", 1_000)).toBe("en marcha desde hace 1 segundo");
    expect(spoken("ca", 120_000)).toBe("en marxa des de fa 2 minuts");
    expect(spoken("ca", 60_000)).toBe("en marxa des de fa 1 minut");
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
