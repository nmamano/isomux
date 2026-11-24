// The two-column page's leave controls (task 9ec5ce17, which undid task
// ed4c14c4). On a phone with an entry open, the header's Close leaves the page
// and a back row in the entry goes back to the list: two controls to two
// places, so both stay. On a phone with the list open and on desktop, the
// page Close is the only control.
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

describe("SidebarPage leave controls", () => {
  it("phone, entry open: Close in the header leaves the page, and a back row in the entry goes back to the list", async () => {
    const { root, header, onClose, onBack } = open(true, false);
    // The view under test: the entry shows and the list does not.
    const entry = root.querySelector<HTMLElement>("[data-test-entry]");
    expect(entry).not.toBeNull();
    expect(root.querySelector("[data-test-list]")).toBeNull();

    expect(buttons(root).length).toBe(2);
    const headerButtons = buttons(header);
    expect(headerButtons.length).toBe(1);
    const close = headerButtons[0]!;
    expect(close.hasAttribute("data-page-close")).toBe(true);
    expect(close.hasAttribute("data-page-back-to-list")).toBe(false);

    const back = buttons(entry!);
    expect(back.length).toBe(1);
    expect(back[0]!.hasAttribute("data-page-back-to-list")).toBe(true);
    expect(back[0]!.hasAttribute("data-test-back")).toBe(true);
    expect(back[0]!.hasAttribute("data-page-close")).toBe(false);
    expect(back[0]!.textContent?.trim()).toBe(BACK_LABEL);

    // Close leaves the page and does not go back to the list.
    await act(async () => {
      fireEvent.click(close);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(root.querySelector("[data-test-entry]")).not.toBeNull();

    // The back row goes back to the list and does not close the page.
    await act(async () => {
      fireEvent.click(back[0]!);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
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
