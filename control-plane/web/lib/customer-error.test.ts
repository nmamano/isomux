import { describe, expect, test } from "bun:test";
import { customerReason } from "../../signup.ts";
import {
  customerFailure,
  refusedResult,
  safeCustomerReason,
  type CustomerFailureSurface,
} from "./customer-error.ts";
import { SUPPORTED_LANGUAGES } from "./i18n/languages.ts";
import { translatorFor } from "./i18n/translate.ts";
import { SUPPORT_EMAIL } from "./support-email.ts";

const SURFACES: CustomerFailureSurface[] = [
  "checkout_reserved",
  "payments",
  "reinstatement",
  "billing_change",
  "billing_change_ambiguous",
];

/** Who the failure happened to. The log carries it; the customer never reads it. */
const CONTEXT = { accountId: "acct-ctx" };

/** The reference sentence a failure must end with, in that language. */
function referenceSentence(
  language: (typeof SUPPORTED_LANGUAGES)[number]["code"],
  reference: string,
): string {
  return ` ${translatorFor(language).t("errors.reference", { reference })}`;
}

describe("customer payment failures", () => {
  test("server detail removes credentials before the log receives it", () => {
    const logged: unknown[][] = [];
    customerFailure(
      "en",
      "transient",
      "payments",
      new Error(
        "Bearer short-secret https://office.test/i/owner-secret password=small",
      ),
      CONTEXT,
      {
        log: (...args) => {
          logged.push(args);
        },
      },
    );
    expect(JSON.stringify(logged)).not.toMatch(
      /short-secret|owner-secret|small/,
    );
    expect(JSON.stringify(logged)).toContain("redacted");
  });
  test("keeps configuration detail only in the server log", () => {
    const logged: unknown[][] = [];
    const raw =
      "Permission denied on acct_private; edit https://dashboard.stripe.com/b/acct_private";
    const shown = customerFailure(
      "en",
      "configuration",
      "payments",
      raw,
      CONTEXT,
      {
        newReference: () => "PAY-0123456789",
        log: (...args: unknown[]) => logged.push(args),
      },
    );

    expect(shown).toContain(SUPPORT_EMAIL);
    expect(shown.endsWith(referenceSentence("en", "PAY-0123456789"))).toBe(
      true,
    );
    expect(shown).not.toContain("acct_private");
    expect(shown).not.toContain("dashboard.stripe.com");
    expect(shown).not.toContain("acct-ctx");
    expect(logged).toHaveLength(1);
    expect(logged[0][1]).toBe(raw);
  });

  test("a configuration failure is ours: in every language and on every surface it names support, then the reference", () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      for (const surface of SURFACES) {
        const shown = customerFailure(
          code,
          "configuration",
          surface,
          "x",
          CONTEXT,
          {
            newReference: () => "PAY-0123456789",
            log: () => {},
          },
        );
        const label = [code, surface];
        expect([...label, shown.includes(SUPPORT_EMAIL)]).toEqual([
          ...label,
          true,
        ]);
        expect([
          ...label,
          shown.endsWith(referenceSentence(code, "PAY-0123456789")),
        ]).toEqual([...label, true]);
      }
    }
  });

  test("capitalizes only explicitly safe refusals", () => {
    expect(
      safeCustomerReason("en", "we do not recognise this account", CONTEXT),
    ).toBe("We do not recognise this account.");
    // A refusal that starts with neither letter case gets a lead-in, not a
    // changed first character.
    const quoted = safeCustomerReason("en", '"acme" is taken', CONTEXT);
    expect(quoted).toMatch(/^\p{Lu}/u);
    expect(quoted.endsWith('"acme" is taken.')).toBe(true);
  });

  test("makes an empty safe refusal opaque and traceable, and logs who it happened to", () => {
    const logged: unknown[][] = [];
    const shown = safeCustomerReason(
      "en",
      " ",
      { accountId: "acct-empty", officeName: "empty-office" },
      {
        newReference: () => "PAY-3F0A9C21B7",
        log: (...args: unknown[]) => logged.push(args),
      },
    );
    expect(shown).toContain(SUPPORT_EMAIL);
    expect(shown.endsWith(referenceSentence("en", "PAY-3F0A9C21B7"))).toBe(
      true,
    );
    expect(logged).toHaveLength(1);
    const tag = String(logged[0][0]);
    expect(tag).toContain("PAY-3F0A9C21B7");
    expect(tag).toContain("account=acct-empty");
    expect(tag).toContain(`office=${JSON.stringify("empty-office")}`);
  });

  test("makes an unknown coupon-provider refusal opaque and traceable", () => {
    const raw =
      "invalid_request_error (more_permissions_required): Permission denied for acct_private. Manage keys at https://dashboard.stripe.com/apikeys.";
    const wrapped = `--coupon SECRET cannot be used as a full discount: ${raw}`;
    const translated = customerReason(wrapped);
    const shown = translated
      ? safeCustomerReason("en", translated, CONTEXT)
      : customerFailure(
          "en",
          "configuration",
          "checkout_reserved",
          wrapped,
          CONTEXT,
          {
            newReference: () => "PAY-3F0A9C21B7",
            log: () => {},
          },
        );

    expect(shown).toContain(SUPPORT_EMAIL);
    expect(shown).not.toContain("acct_");
    expect(shown).not.toContain("dashboard.stripe.com");
    expect(shown).toContain("PAY-3F0A9C21B7");
  });

  test("a failure is worded by its kind and surface in the request's language, then the reference", () => {
    const reference = { newReference: () => "PAY-0123456789", log: () => {} };
    const cases = [
      ["es", "transient", "payments", "errors.providerTransient"],
      [
        "en",
        "transient",
        "checkout_reserved",
        "errors.checkoutReservedTransient",
      ],
      [
        "ca",
        "configuration",
        "checkout_reserved",
        "errors.checkoutReservedConfiguration",
      ],
    ] as const;
    for (const [language, kind, surface, key] of cases) {
      const { t } = translatorFor(language);
      const sentence = (t as (k: string, v: object) => string)(key, {
        support: SUPPORT_EMAIL,
      });
      expect([
        language,
        surface,
        customerFailure(language, kind, surface, "x", CONTEXT, reference),
      ]).toEqual([
        language,
        surface,
        sentence + referenceSentence(language, "PAY-0123456789"),
      ]);
    }
  });
});

// The log line is what support greps when a customer pastes a reference. The
// old signup catch carried the account; the reference alone finds a line that
// says what went wrong but not to whom.
describe("the customer-error log line says who it happened to", () => {
  function logTag(context: Parameters<typeof customerFailure>[4]): string {
    const logged: unknown[][] = [];
    customerFailure("en", "configuration", "payments", "detail", context, {
      newReference: () => "PAY-0123456789",
      log: (...args: unknown[]) => logged.push(args),
    });
    expect(logged).toHaveLength(1);
    expect(logged[0][1]).toBe("detail");
    return String(logged[0][0]);
  }

  test("account, instance and office each appear once, after the reference", () => {
    const tag = logTag({
      accountId: "acct-1",
      instanceId: "inst-1",
      officeName: "acme",
    });
    expect(tag.startsWith("[customer-error PAY-0123456789 ")).toBe(true);
    expect(tag.endsWith("]")).toBe(true);
    for (const field of [
      "account=acct-1",
      "instance=inst-1",
      `office=${JSON.stringify("acme")}`,
    ]) {
      expect([field, tag.split(field).length - 1]).toEqual([field, 1]);
    }
  });

  test("an absent instance or office is left out, not printed empty", () => {
    for (const context of [
      { accountId: "acct-1" },
      { accountId: "acct-1", instanceId: null, officeName: null },
    ]) {
      const tag = logTag(context);
      expect(tag).toContain("account=acct-1");
      expect(tag).not.toContain("instance=");
      expect(tag).not.toContain("office=");
    }
  });

  test("an office name is quoted, so customer input cannot forge or end a field", () => {
    // signUpOffice can log before validateSignup has judged the name.
    const typed = 'a b] account=acct-forged office="x"';
    const tag = logTag({ accountId: "acct-1", officeName: typed });
    expect(tag).toContain(`office=${JSON.stringify(typed)}`);
    expect(tag.split("account=").length - 1).toBe(2);
    expect(
      tag.startsWith("[customer-error PAY-0123456789 account=acct-1"),
    ).toBe(true);
  });
});

// refusedResult is the one place a refusal's kind decides what the customer
// reads, and whether its code goes to the page.
describe("refusedResult", () => {
  function render(
    kind: "customer" | "configuration" | "transient",
    surface: CustomerFailureSurface,
    reason: string,
    code?: string,
  ): { result: ReturnType<typeof refusedResult>; logged: unknown[][] } {
    const logged: unknown[][] = [];
    const result = refusedResult(
      "en",
      surface,
      code === undefined
        ? { ok: false, kind, reason }
        : { ok: false, kind, reason, code },
      { accountId: "acct-r", instanceId: "inst-r" },
      {
        newReference: () => "PAY-0123456789",
        log: (...args: unknown[]) => logged.push(args),
      },
    );
    return { result, logged };
  }

  test("a customer refusal shows its own sentence, carries its code, and writes no log", () => {
    const reason = "this office is already reinstated";
    const { result, logged } = render(
      "customer",
      "reinstatement",
      reason,
      "already_reinstated",
    );
    expect(result).toEqual({
      ok: false,
      code: "already_reinstated",
      reason: safeCustomerReason("en", reason, CONTEXT),
    });
    expect(logged).toEqual([]);
  });

  test("a customer refusal with no code goes out with no code key", () => {
    const reason = '"acme" is taken';
    const { result, logged } = render("customer", "payments", reason);
    expect(result).toEqual({
      ok: false,
      reason: safeCustomerReason("en", reason, CONTEXT),
    });
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
    expect(logged).toEqual([]);
  });

  test("a configuration or transient refusal is opaque, drops its code, and logs the reason with its context", () => {
    const reason = "we could not prove the original Stripe customer";
    for (const kind of ["configuration", "transient"] as const) {
      for (const surface of SURFACES) {
        const { result, logged } = render(
          kind,
          surface,
          reason,
          "stripe_ambiguous",
        );
        const label = [kind, surface];
        expect([...label, Object.keys(result).sort()]).toEqual([
          ...label,
          ["ok", "reason"],
        ]);
        expect([...label, result.reason.includes("Stripe customer")]).toEqual([
          ...label,
          false,
        ]);
        expect([
          ...label,
          result.reason.endsWith(referenceSentence("en", "PAY-0123456789")),
        ]).toEqual([...label, true]);
        expect([...label, logged.length]).toEqual([...label, 1]);
        expect([...label, logged[0][1]]).toEqual([...label, reason]);
        expect([
          ...label,
          String(logged[0][0]).includes("account=acct-r"),
          String(logged[0][0]).includes("instance=inst-r"),
        ]).toEqual([...label, true, true]);
      }
    }
  });

  test("the kind and the surface pick the sentence", () => {
    // A configuration failure names support; a transient one asks for a
    // retry, and on checkout_reserved it says the name is held.
    expect(
      render("configuration", "checkout_reserved", "x").result.reason,
    ).toContain(SUPPORT_EMAIL);
    const transient = render("transient", "checkout_reserved", "x").result
      .reason;
    expect(transient).not.toContain(SUPPORT_EMAIL);
    expect(transient).toBe(
      customerFailure("en", "transient", "checkout_reserved", "x", CONTEXT, {
        newReference: () => "PAY-0123456789",
        log: () => {},
      }),
    );
    expect(
      render("transient", "billing_change_ambiguous", "x").result.reason,
    ).not.toBe(render("transient", "billing_change", "x").result.reason);
  });
});
