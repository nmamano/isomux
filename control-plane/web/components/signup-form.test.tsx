import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignupForm } from "./signup-form";
import { customerPriceLine } from "./plan-copy";

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
});
