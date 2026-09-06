import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SignupForm } from "./signup-form";
import { PolicyNotice } from "./policy-notice";
import { customerPriceLine } from "./plan-copy";

function expectPolicyLinksBefore(html: string, paymentLabel: string) {
  for (const label of ["Terms of Service", "Privacy Policy", "Refund Policy"]) {
    expect(html.indexOf(label)).toBeLessThan(html.indexOf(paymentLabel));
  }
}

test("signup renders both specifications and omits unset prices", () => {
  expect(customerPriceLine("en", null)).toBeNull();
  expect(
    customerPriceLine("en", {
      amount: 19,
      currency: "EUR",
      billingPeriod: "month",
    }),
  ).toBe("€19.00 per month");
  const html = renderToStaticMarkup(
    <SignupForm
      language="en"
      domain="test.isomux.app"
      initialName=""
      plans={[
        {
          id: "office",
          label: "Entry",
          specification: "4 vCPU, 8 GB RAM, 100 GB SSD",
          customerPrice: null,
        },
        {
          id: "poweruser",
          label: "Poweruser",
          specification: "8 vCPU, 24 GB RAM, 300 GB SSD",
          customerPrice: null,
        },
      ]}
    />,
  );
  const entryInput = html.match(/<input[^>]*value="office"[^>]*>/)?.[0];
  expect(entryInput).toContain('name="plan"');
  expect(entryInput).toContain('checked=""');
  expect(entryInput).toContain('value="office"');
  expect(html).toContain('value="poweruser"');
  expect(html).toContain("4 vCPU, 8 GB RAM, 100 GB SSD");
  expect(html).toContain("8 vCPU, 24 GB RAM, 300 GB SSD");
  expect(html).not.toContain("per month");
  expectPolicyLinksBefore(html, "Continue to payment");
  expect(html.indexOf("Promotional code (optional)")).toBeLessThan(
    html.indexOf("Save your server administrator key"),
  );
  expect(html.indexOf("I saved it")).toBeLessThan(
    html.indexOf("Continue to payment"),
  );
  expect(html).toContain("manage or repair your server. It was generated");
  expect(html).toContain("<strong>How to use it:</strong>");
  expect(html).toContain('class="key-field"');
  expect(html).toContain('placeholder="Private key hidden"');
  expect(html).toContain("Reveal private key");
  expect(html).toContain('aria-pressed="false"');
  expect(html).toContain("Copy private key");
  expect(html).toContain("Download private key");
  expect(html).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  expect(html).toContain('disabled=""');
  expect(html).not.toContain('aria-describedby="signup-save-key-reason"');
  expect(html).not.toContain(
    "Save your server administrator key before continuing.",
  );
});

test("returning signup shows every policy before continuing to payment", () => {
  const notice = renderToStaticMarkup(<PolicyNotice language="en" />);
  expectPolicyLinksBefore(`${notice}Continue signup`, "Continue signup");
  const page = readFileSync(
    new URL("../app/signup/page.tsx", import.meta.url),
    "utf8",
  );
  // The ORDER in the source, not the words: the continue button reads from the
  // catalog now, so the key is what names it here.
  const noticePosition = page.indexOf("<PolicyNotice");
  expect(noticePosition).toBeGreaterThan(0);
  expect(noticePosition).toBeLessThan(page.indexOf('t("signup.continue")'));
  expect(page).toContain('data-testid="signup-error"');
});

test("returning signup passes a redirect refusal into the interactive form", () => {
  const page = readFileSync(
    new URL("../app/signup/page.tsx", import.meta.url),
    "utf8",
  );
  expect(page).toContain("initialError={error}");
  expect(page).toContain('data-testid="signup-error"');
});

test("interactive signup announces a refusal at the payment action", () => {
  const html = renderToStaticMarkup(
    <SignupForm
      language="en"
      domain="test.isomux.app"
      initialName=""
      initialError="Try signup again."
      plans={[]}
    />,
  );
  expect(html).toContain(
    'data-testid="signup-error" role="alert">Try signup again.',
  );
  expect(html.indexOf("Try signup again.")).toBeLessThan(
    html.indexOf("Continue to payment"),
  );
});
