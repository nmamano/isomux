import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SignupForm } from "./signup-form";

const POLICY_HREFS = [
  "https://isomux.com/hosted-terms",
  "https://isomux.com/hosted-privacy",
  "https://isomux.com/hosted-refund",
];

/** Every hosted policy link comes before `marker` in the page. */
function expectPoliciesBefore(html: string, marker: string) {
  const at = html.indexOf(marker);
  expect([marker, at]).not.toEqual([marker, -1]);
  for (const href of POLICY_HREFS) {
    const link = html.indexOf(`href="${href}"`);
    expect([href, link >= 0 && link < at]).toEqual([href, true]);
  }
}

test("the server render offers each plan, keeps the key hidden, and orders the form", () => {
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
  expect(html).toContain('value="poweruser"');
  // Each plan shows its specification and, with no price set, nothing else.
  const options = [
    ...html.matchAll(/<label class="plan-option">([\s\S]*?)<\/label>/g),
  ].map((m) => m[1]);
  expect(options).toHaveLength(2);
  for (const option of options) {
    expect(option.split('class="note"').length - 1).toBe(1);
  }
  expect(html).toContain("4 vCPU, 8 GB RAM, 100 GB SSD");
  expect(html).toContain("8 vCPU, 24 GB RAM, 300 GB SSD");

  // Coupon, then the key, then the saved-key confirmation, then the policies,
  // then the payment button.
  const order = [
    'data-testid="coupon"',
    'data-testid="server-administrator-private-key"',
    'class="key-confirm"',
    `href="${POLICY_HREFS[0]}"`,
    'data-testid="signup-submit"',
  ].map((marker) => html.indexOf(marker));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expectPoliciesBefore(html, 'data-testid="signup-submit"');

  // No key exists before the browser makes one: the key field is empty and
  // every control that needs a key, and the payment button, is off.
  expect(html).not.toContain("PRIVATE KEY");
  expect(html).toMatch(
    /data-testid="server-administrator-private-key"[^>]*><\/textarea>/,
  );
  for (const control of [
    /class="key-reveal"[^>]*disabled=""/,
    /class="key-copy"[^>]*disabled=""/,
    /class="key-download"[^>]*disabled=""/,
    /data-testid="signup-submit"[^>]*disabled=""/,
  ]) {
    expect(html).toMatch(control);
  }
  expect(html).not.toContain("aria-describedby");
});

test("returning signup shows every policy before continuing, and passes a refusal to the form", () => {
  // The page is a server component that needs a session, so its order is
  // pinned in the source. The continue button reads from the catalog, so its
  // key is what names it here.
  const page = readFileSync(
    new URL("../app/signup/page.tsx", import.meta.url),
    "utf8",
  );
  const noticePosition = page.indexOf("<PolicyNotice");
  expect(noticePosition).toBeGreaterThan(0);
  expect(noticePosition).toBeLessThan(page.indexOf('t("signup.continue")'));
  expect(page).toContain('data-testid="signup-error"');
  expect(page).toContain("initialError={error}");
});

test("interactive signup announces a refusal before the payment action", () => {
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
    html.indexOf('data-testid="signup-submit"'),
  );
});

test("the new-office form posts the new intent", () => {
  const html = renderToStaticMarkup(
    <SignupForm
      language="en"
      domain="test.isomux.app"
      initialName=""
      plans={[]}
    />,
  );
  const form = html.match(/<form[\s\S]*<\/form>/)?.[0] ?? "";
  const intent = form.match(/<input[^>]*name="signupIntent"[^>]*>/)?.[0];
  expect(intent).toBeDefined();
  expect(intent).toContain('type="hidden"');
  expect(intent).toContain('value="new"');
});
