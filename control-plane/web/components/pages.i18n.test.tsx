// The storefront's pages in Spanish and Catalan (internal-docs/i18n-loop.md,
// S11). Its sibling `control-plane/web-i18n.test.tsx` holds the parts that have
// to name an operation kind, which no file under web/ may do.
//
// Every assertion is a LITERAL translated string (ruling 14). A test that read
// its expectation back through the translator would pass with the translator
// broken.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignedOut, Dashboard } from "../app/home-view";
import { SignupForm } from "./signup-form";
import { OfficeView } from "./office-view";
import { PolicyNotice } from "./policy-notice";
import { customerPriceLine } from "./plan-copy";
import { webTranslatorFor } from "../lib/i18n/rich";
import type { ProgressView } from "../lib/services.server";

describe("the prerendered shells", () => {
  test("the signed-out landing reads Catalan and Spanish", () => {
    expect(
      renderToStaticMarkup(<SignedOut i18n={webTranslatorFor("ca")} />),
    ).toContain("Inicia la sessió");
    expect(
      renderToStaticMarkup(<SignedOut i18n={webTranslatorFor("es")} />),
    ).toContain("Inicia sesión");
    // The product name is not copy (ruling 11) and is the same in all three.
    for (const language of ["en", "es", "ca"] as const) {
      expect(
        renderToStaticMarkup(<SignedOut i18n={webTranslatorFor(language)} />),
      ).toContain("Hosted Isomux");
    }
  });

  test("the dashboard reads Catalan, and its heading follows the English split", () => {
    const office = {
      instanceId: "i-1",
      officeName: "acme",
      hostname: "acme.isomux.app",
      ready: true,
    };
    const one = renderToStaticMarkup(
      <Dashboard
        i18n={webTranslatorFor("ca")}
        email="a@example.com"
        offices={[office]}
      />,
    );
    expect(one).toContain("Sessió iniciada com a a@example.com");
    expect(one).toContain("La teva oficina");
    expect(one).toContain("a punt");
    expect(one).toContain("Tanca la sessió");

    const two = renderToStaticMarkup(
      <Dashboard
        i18n={webTranslatorFor("es")}
        email={null}
        offices={[office, { ...office, instanceId: "i-2", ready: false }]}
      />,
    );
    expect(two).toContain("Tus oficinas");
    expect(two).toContain("aún no está lista");

    // ZERO OFFICES KEEPS THE SINGULAR, in every language: the English splits at
    // more than one, and Intl.PluralRules would have moved it.
    const none = renderToStaticMarkup(
      <Dashboard i18n={webTranslatorFor("ca")} email={null} offices={[]} />,
    );
    expect(none).toContain("La teva oficina");
    expect(none).not.toContain("Les teves oficines");
    expect(none).toContain("Encara no tens cap oficina.");
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

  test("reads Catalan and keeps the plan name and specification", () => {
    const html = renderToStaticMarkup(
      <SignupForm
        language="ca"
        domain="isomux.app"
        initialName=""
        plans={plans}
      />,
    );
    expect(html).toContain("Tria la teva oficina");
    expect(html).toContain("Continua al pagament");
    expect(html).toContain("Codi promocional (opcional)");
    expect(html).toContain("Clau privada amagada");
    // Plan name and hardware figures are data, not copy (ruling 11).
    expect(html).toContain("Entry");
    expect(html).toContain("4 vCPU, 8 GB RAM, 100 GB SSD");
  });

  test("reads Spanish, and the price is formatted for the reader", () => {
    const html = renderToStaticMarkup(
      <SignupForm
        language="es"
        domain="isomux.app"
        initialName=""
        plans={plans}
      />,
    );
    expect(html).toContain("Elige tu oficina");
    expect(html).toContain("Continuar al pago");
    expect(html).toContain("Código promocional (opcional)");
    // Intl puts a NO-BREAK SPACE before the symbol in both, which is why the
    // expectation spells it: a plain space here would fail on bytes that look
    // identical in a diff.
    expect(customerPriceLine("es", plans[0].customerPrice)).toBe(
      "8,00\u00a0€ por mes",
    );
    expect(customerPriceLine("ca", plans[0].customerPrice)).toBe(
      "8,00\u00a0€ per mes",
    );
    // English is byte-identical to what this page printed before the catalog.
    expect(customerPriceLine("en", plans[0].customerPrice)).toBe(
      "€8.00 per month",
    );
  });

  test("the policy notice keeps the English document names in every language", () => {
    for (const [language, lead] of [
      ["es", "Antes de pagar, revisa "],
      ["ca", "Abans de pagar, revisa "],
    ] as const) {
      const html = renderToStaticMarkup(<PolicyNotice language={language} />);
      expect(html).toContain(lead);
      for (const name of [
        "Terms of Service",
        "Privacy Policy",
        "Refund Policy",
      ]) {
        expect([language, name, html.includes(name)]).toEqual([
          language,
          name,
          true,
        ]);
      }
    }
  });
});

const baseView: ProgressView = {
  asOf: 0,
  instanceId: "instance-i18n",
  officeName: "acme",
  hostname: "acme.isomux.app",
  sshCommand: null,
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

describe("the office page", () => {
  test("reads Catalan and Spanish across its sections", () => {
    const ca = renderToStaticMarkup(
      <OfficeView language="ca" initial={baseView} instanceId="instance-i18n" />,
    );
    expect(ca).toContain("La teva oficina encara no està a punt.");
    expect(ca).toContain("Progrés");
    expect(ca).toContain("Com entrar-hi");
    expect(ca).toContain("El teu pla");
    expect(ca).toContain("Reinici");
    expect(ca).toContain("Completa el pagament");
    // The hostname is the customer's own name for their office.
    expect(ca).toContain("acme.isomux.app");
    // The translated region carries its own lang for a reader with no
    // JavaScript, because the root layout's attribute is a static "en".
    expect(ca).toContain('<main lang="ca">');

    const es = renderToStaticMarkup(
      <OfficeView language="es" initial={baseView} instanceId="instance-i18n" />,
    );
    expect(es).toContain("Tu oficina aún no está lista.");
    expect(es).toContain("Progreso");
    expect(es).toContain("Cómo entrar");
    expect(es).toContain("Reinicio");
    expect(es).toContain('<main lang="es">');
  });

  test("a liveness rung and an attention class reach their translated words", () => {
    const html = renderToStaticMarkup(
      <OfficeView
        language="ca"
        initial={{
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
        }}
        instanceId="instance-i18n"
      />,
    );
    expect(html).toContain("Comprovat ara mateix: esperant el certificat.");
    expect(html).toContain(
      "Un pas ha superat el seu límit de temps. Revisarem la teva configuració.",
    );
    expect(html).toContain("(ja ho hem vist)");
    expect(html).toContain("Hem de revisar la teva configuració");
    // The English the projection sent is gone, not merely accompanied.
    expect(html).not.toContain("waiting for the certificate");
    expect(html).not.toContain("A step has passed its time limit");
  });

  test("an unknown liveness rung falls back to the English the projection sent", () => {
    const html = renderToStaticMarkup(
      <OfficeView
        language="ca"
        initial={{
          ...baseView,
          ready: true,
          liveness: {
            rung: "a-rung-from-the-future",
            words: "we could not classify the last check",
            strikes: 0,
            checkedAt: 0,
            unreachable: false,
          },
        }}
        instanceId="instance-i18n"
      />,
    );
    expect(html).toContain(
      "Comprovat ara mateix: we could not classify the last check.",
    );
    expect(html).not.toContain("liveness.label");
  });

  test("the cancellation panel reads Catalan with its proven dates intact", () => {
    const html = renderToStaticMarkup(
      <OfficeView
        language="ca"
        initial={{
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
        }}
        instanceId="instance-i18n"
      />,
    );
    expect(html).toContain(
      "La teva subscripció està programada per acabar el 2026-01-02.",
    );
    expect(html).toContain("Mantén la meva oficina");
    // Stripe's own status word and the ISO date are data (ruling 11).
    expect(html).toContain("Entry - active");
    expect(html).toContain("2026-01-02");
  });
});
