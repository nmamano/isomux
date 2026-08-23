import { describe, expect, test } from "bun:test";
import { customerReason } from "../../signup.ts";
import { customerFailure, safeCustomerReason } from "./customer-error.ts";

describe("customer payment failures", () => {
  test("keeps configuration detail only in the server log", () => {
    const logged: unknown[][] = [];
    const raw =
      "Permission denied on acct_private; edit https://dashboard.stripe.com/b/acct_private";
    const shown = customerFailure("configuration", "payments", raw, {
      newReference: () => "PAY-0123456789",
      log: (...args) => logged.push(args),
    });

    expect(shown).toBe(
      "Payments are not available right now. Reference: PAY-0123456789.",
    );
    expect(shown).not.toContain("acct_private");
    expect(shown).not.toContain("dashboard.stripe.com");
    expect(logged).toEqual([["[customer-error PAY-0123456789]", raw]]);
  });

  test("offers a retry only for a transient failure and keeps the reservation fact", () => {
    const configuration = customerFailure(
      "configuration",
      "checkout_reserved",
      "bad key",
      { newReference: () => "PAY-AAAAAAAAAA", log: () => {} },
    );
    const transient = customerFailure(
      "transient",
      "checkout_reserved",
      "timeout",
      { newReference: () => "PAY-BBBBBBBBBB", log: () => {} },
    );

    expect(configuration).toBe(
      "We could not open a payment page. Your name is reserved. Reference: PAY-AAAAAAAAAA.",
    );
    expect(configuration).not.toContain("try again");
    expect(transient).toBe(
      "We could not open a payment page just now. Your name is reserved, so try again in a moment. Reference: PAY-BBBBBBBBBB.",
    );
  });

  test("capitalizes only explicitly safe refusals", () => {
    expect(safeCustomerReason("we do not recognise this account")).toBe(
      "We do not recognise this account.",
    );
    expect(safeCustomerReason('"acme" is taken')).toBe(
      'Request refused: "acme" is taken.',
    );
  });

  test("makes an empty safe refusal opaque and traceable", () => {
    expect(
      safeCustomerReason(" ", {
        newReference: () => "PAY-3F0A9C21B7",
        log: () => {},
      }),
    ).toBe("Payments are not available right now. Reference: PAY-3F0A9C21B7.");
  });

  test("makes an unknown coupon-provider refusal opaque and traceable", () => {
    const raw =
      "invalid_request_error (more_permissions_required): Permission denied for acct_private. Manage keys at https://dashboard.stripe.com/apikeys.";
    const wrapped = `--coupon SECRET cannot be used as a full discount: ${raw}`;
    const translated = customerReason(wrapped);
    const shown = translated
      ? safeCustomerReason(translated)
      : customerFailure("configuration", "checkout_reserved", wrapped, {
          newReference: () => "PAY-3F0A9C21B7",
          log: () => {},
        });

    expect(shown).toBe(
      "We could not open a payment page. Your name is reserved. Reference: PAY-3F0A9C21B7.",
    );
    expect(shown).not.toContain("acct_");
    expect(shown).not.toContain("dashboard.stripe.com");
    expect(shown).toContain("PAY-3F0A9C21B7");
  });
});
