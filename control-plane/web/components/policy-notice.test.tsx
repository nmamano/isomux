import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PolicyNotice } from "./policy-notice";

test("policy notice links every hosted policy in a new tab", () => {
  const html = renderToStaticMarkup(<PolicyNotice language="en" />);
  for (const [href, label] of [
    ["https://isomux.com/hosted-terms", "Terms of Service"],
    ["https://isomux.com/hosted-privacy", "Privacy Policy"],
    ["https://isomux.com/hosted-refund", "Refund Policy"],
  ]) {
    expect(html).toContain(
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );
  }
});
