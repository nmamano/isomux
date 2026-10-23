import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PolicyNotice } from "./policy-notice";

test("policy notice links every hosted policy in a new tab", () => {
  const html = renderToStaticMarkup(<PolicyNotice language="en" />);
  const anchors = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
  expect(anchors).toEqual(
    [
      "https://isomux.com/hosted-terms",
      "https://isomux.com/hosted-privacy",
      "https://isomux.com/hosted-refund",
    ].map(
      (href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">`,
    ),
  );
});
