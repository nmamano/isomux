import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { ThumbsUpReaction } = await import("./ThumbsUpReaction.tsx");
const { describeMembersChatAuthor } = await import("./MembersChatPanel.tsx");
const { useI18n } = await import("../i18n.tsx");

it("toggles desired state and exposes honestly attributed names by focus, hover and tap", async () => {
  const calls: boolean[] = [];
  function Fixture() {
    const [active, setActive] = useState(false);
    const { t } = useI18n();
    return createElement(ThumbsUpReaction, {
      active,
      isMobile: true,
      names: active
        ? [
            describeMembersChatAuthor({ kind: "agent", userName: "Helper" }, t)
              .label,
            describeMembersChatAuthor(
              { kind: "api", userName: "Sam", device: "Phone" },
              t,
            ).label,
          ]
        : [],
      onChange: async (next) => {
        calls.push(next);
        setActive(next);
      },
    });
  }
  const view = render(onLanguage("en", createElement(Fixture)));
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Thumbs up" })),
  );
  expect(calls).toEqual([true]);
  expect(
    view
      .getByRole("button", { name: "Remove thumbs up" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  const count = view.getByRole("button", { name: "Thumbs up: 2" });
  const names = count.getAttribute("title")!;
  expect(names).toContain("Helper · agent");
  expect(names).toContain('Sam · API token "Phone"');
  fireEvent.focus(count);
  expect(view.getByText(names).textContent).toBe(names);
  fireEvent.keyDown(count, { key: "Escape" });
  expect(view.queryByText(names) === null).toBe(true);
  fireEvent.pointerEnter(count, { pointerType: "mouse" });
  expect(view.getByText(names).textContent).toBe(names);
  fireEvent.pointerLeave(count, { pointerType: "mouse" });
  expect(view.queryByText(names) === null).toBe(true);
  fireEvent.pointerEnter(count, { pointerType: "touch" });
  fireEvent.pointerLeave(count, { pointerType: "touch" });
  fireEvent.click(count);
  fireEvent.mouseLeave(count);
  expect(view.getByText(names).textContent).toBe(names);
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "Remove thumbs up" })),
  );
  expect(calls).toEqual([true, false]);
  expect(view.queryByRole("button", { name: "Thumbs up: 2" }) === null).toBe(
    true,
  );
});
