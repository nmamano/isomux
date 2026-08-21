import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SignupForm, SignupPolicyNotice } from "./signup-form";
import { customerPriceLine } from "./plan-copy";

function expectPolicyLinksBefore(html: string, paymentLabel: string) {
  expect(html).toContain("Before you pay, review the");
  for (const [href, label] of [
    ["https://isomux.com/hosted-terms", "Terms of Service"],
    ["https://isomux.com/hosted-privacy", "Privacy Policy"],
    ["https://isomux.com/hosted-refund", "Refund Policy"],
  ]) {
    expect(html).toContain(
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );
    expect(html.indexOf(label)).toBeLessThan(html.indexOf(paymentLabel));
  }
}

test("signup renders both specifications and omits unset prices", () => {
  expect(customerPriceLine(null)).toBeNull();
  expect(
    customerPriceLine({
      amount: 19,
      currency: "EUR",
      billingPeriod: "month",
    }),
  ).toBe("€19.00 per month");
  const html = renderToStaticMarkup(
    <SignupForm
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
});

test("returning signup shows every policy before continuing to payment", () => {
  const notice = renderToStaticMarkup(<SignupPolicyNotice />);
  expectPolicyLinksBefore(`${notice}Continue signup`, "Continue signup");
  const page = readFileSync(
    new URL("../app/signup/page.tsx", import.meta.url),
    "utf8",
  );
  const noticePosition = page.indexOf("<SignupPolicyNotice />");
  expect(noticePosition).toBeGreaterThan(0);
  expect(noticePosition).toBeLessThan(page.indexOf("Continue signup"));
});
