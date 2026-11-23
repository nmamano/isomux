// The two-column page's back controls (task ed4c14c4). On a phone with an
// entry open, the header's left control goes back to the list and the page
// has no other back control (the header Close and a back row in the entry
// showed the same name and read as one button twice). On a phone with the
// list open and on desktop, the header control is the page Close.
//
// The list and the entry hold no buttons here, so every button on the page
// is a control SidebarPage itself draws.

import { describe, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { SidebarPage } = await import("./SidebarPage.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

const BACK_LABEL = "Part list name";

function Page({
  startListShown,
  onClose,
  onBack,
}: {
  startListShown: boolean;
  onClose: () => void;
  onBack: () => void;
}) {
  const [listShown, setListShown] = useState(startListShown);
  return createElement(SidebarPage, {
    title: "Page title",
    onClose,
    listShown,
    onBackToList: () => {
      onBack();
      setListShown(true);
    },
    backLabel: BACK_LABEL,
    backAttrs: { "data-test-back": "" },
    rootAttrs: { "data-test-page": "" },
    detailAttrs: { "data-test-entry": "" },
    listLabel: "List",
    list: createElement("div", { "data-test-list": "" }, "list rows"),
    children: createElement("div", null, "entry body"),
  });
}

function open(isMobile: boolean, startListShown: boolean) {
  const onClose = mock(() => {});
  const onBack = mock(() => {});
  const view = render(
    onLanguage(null, createElement(Page, { startListShown, onClose, onBack }), {
      isMobile,
    }),
  );
  const root = view.container.querySelector<HTMLElement>("[data-test-page]")!;
  // The header bar is the page's first row.
  const header = root.firstElementChild as HTMLElement;
  return { view, root, header, onClose, onBack };
}

const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")];

describe("SidebarPage back controls", () => {
  it("phone, entry open: one back control, in the header, back to the list", async () => {
    const { root, header, onClose, onBack } = open(true, false);
    // The view under test: the entry shows and the list does not.
    expect(root.querySelector("[data-test-entry]")).not.toBeNull();
    expect(root.querySelector("[data-test-list]")).toBeNull();

    expect(buttons(root).length).toBe(1);
    const back = buttons(root)[0]!;
    expect(header.contains(back)).toBe(true);
    expect(back.hasAttribute("data-page-back-to-list")).toBe(true);
    expect(back.hasAttribute("data-test-back")).toBe(true);
    expect(back.hasAttribute("data-page-close")).toBe(false);
    expect(back.textContent?.trim()).toBe(BACK_LABEL);
    expect(root.querySelector("[data-page-close]")).toBeNull();

    await act(async () => {
      fireEvent.click(back);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // Back shows the list, whose header control is Close again.
    expect(root.querySelector("[data-test-list]")).not.toBeNull();
    expect(root.querySelector("[data-test-entry]")).toBeNull();
    expect(header.querySelector("[data-page-close]")).not.toBeNull();
    expect(root.querySelector("[data-page-back-to-list]")).toBeNull();
  });

  it("phone, list open: the header control is Close, and there is no back to the list", async () => {
    const { root, header, onClose, onBack } = open(true, true);
    expect(root.querySelector("[data-test-list]")).not.toBeNull();
    expect(root.querySelector("[data-test-entry]")).toBeNull();

    expect(buttons(root).length).toBe(1);
    const close = buttons(root)[0]!;
    expect(header.contains(close)).toBe(true);
    expect(close.hasAttribute("data-page-close")).toBe(true);
    expect(root.querySelector("[data-page-back-to-list]")).toBeNull();

    await act(async () => {
      fireEvent.click(close);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("desktop: list and entry both show, the header control is Close, and there is no back to the list", async () => {
    const { root, header, onClose, onBack } = open(false, false);
    expect(root.querySelector("[data-test-list]")).not.toBeNull();
    expect(root.querySelector("[data-test-entry]")).not.toBeNull();

    expect(buttons(root).length).toBe(1);
    const close = buttons(root)[0]!;
    expect(header.contains(close)).toBe(true);
    expect(close.hasAttribute("data-page-close")).toBe(true);
    expect(root.querySelector("[data-page-back-to-list]")).toBeNull();

    await act(async () => {
      fireEvent.click(close);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });
});
