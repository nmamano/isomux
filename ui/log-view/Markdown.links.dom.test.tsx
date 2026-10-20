// Chat links from the iPhone Home Screen office (ui/safari-link.ts).
//
// Pins: agents post app links such as https://<office>/loop in chat. iOS keeps
// a same-origin link inside the Home Screen window, which has no Back button,
// so there an app's short link opens Safari. An office page such as /settings
// stays in the office, and a link to another site keeps the plain href, which
// iOS already opens in a Safari sheet.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");

it("opens an app link in Safari from the iPhone Home Screen office, and nothing else", () => {
  const office = window.location.origin;
  const undo = asDevice(IPHONE_HOME_SCREEN);
  try {
    const view = render(
      <Markdown
        content={`[loop](${office}/loop) ${office}/board ${office}/settings [site](https://example.com/)`}
      />,
    );
    expect(
      view.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual([
      "x-safari-" + office + "/loop",
      "x-safari-" + office + "/board",
      office + "/settings",
      "https://example.com/",
    ]);
    view.unmount();
  } finally {
    undo();
  }
});
