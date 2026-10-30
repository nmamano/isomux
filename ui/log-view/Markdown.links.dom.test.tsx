// Chat links from the iPhone Home Screen office (task 79beacd9).
//
// Pins: agents post app links such as https://<office>/loop in chat. Safari
// does not hold the member's session, so in the Home Screen window every link
// keeps its plain href: an app's short link and an office page stay in the
// window, where the member is signed in (the app page links back to the
// office), and a link to another site opens in the Safari sheet iOS gives it.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");
const { asDevice, IPHONE_HOME_SCREEN } =
  await import("../test-support/ios-home-screen.ts");

it("keeps every chat link as it is in the iPhone Home Screen office", () => {
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
      office + "/loop",
      office + "/board",
      office + "/settings",
      "https://example.com/",
    ]);
    view.unmount();
  } finally {
    undo();
  }
});
