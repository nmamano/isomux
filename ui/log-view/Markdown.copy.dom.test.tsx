// The copy button on a chat code block says what happened (task 305994aa),
// like CopyButton after acddc30f: copied only after a write the browser
// accepted, failed when both the clipboard API and the execCommand fallback
// refused. The outcome rides on data-copy-outcome, which
// the stylesheet keys its colors on (hover included); this file pins the
// attribute, the title and the icon, not the colors.
import { afterEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { Markdown } = await import("./Markdown.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");
const saved = {
  clipboard: Object.getOwnPropertyDescriptor(navigator, "clipboard"),
  exec: Object.getOwnPropertyDescriptor(document, "execCommand"),
};
const restore = (target: object, key: string, d?: PropertyDescriptor) => {
  if (d) Object.defineProperty(target, key, d);
  else delete (target as Record<string, unknown>)[key];
};
afterEach(() => {
  jest.useRealTimers();
  restore(navigator, "clipboard", saved.clipboard);
  restore(document, "execCommand", saved.exec);
});

// Each path accepts or refuses on its own. `writes` records the texts the
// clipboard API took, and the textarea value for each fallback it accepted.
function clipboard() {
  const state = {
    api: true,
    fallback: true,
    writes: [] as string[],
    fallbackCalls: 0,
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (!state.api) throw new Error("NotAllowedError");
        state.writes.push(text);
      },
    },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string) => {
      state.fallbackCalls++;
      if (command !== "copy" || !state.fallback) return false;
      const ta = [...document.body.querySelectorAll("textarea")].at(-1);
      state.writes.push(ta ? ta.value : "(no textarea)");
      return true;
    },
  });
  return state;
}

const CODE = "const answer = 42;";
// The code element's text as marked emits it: the block's lines, newline-ended.
const CODE_TEXT = CODE + "\n";

function mount(content = "```ts\n" + CODE + "\n```") {
  const view = render(<Markdown content={content} />);
  const button = () => {
    const b = view.container.querySelector<HTMLElement>(".code-copy-btn");
    if (!b) throw new Error("no code-block copy button");
    return b;
  };
  return {
    button,
    outcome: () => button().getAttribute("data-copy-outcome"),
    name: () => button().getAttribute("title"),
    // The three icons by their shape: the copy icon draws a rect, the check
    // a polyline, the cross neither.
    icon: () => {
      const svg = button().querySelector("svg");
      if (!svg) return "none";
      if (svg.querySelector("rect")) return "copy";
      if (svg.querySelector("polyline")) return "check";
      return svg.querySelector("path") ? "cross" : "other";
    },
    click: () =>
      act(async () => {
        fireEvent.click(button());
      }),
  };
}

it("a write the clipboard API accepts shows copied, with the code text", async () => {
  const cb = clipboard();
  const b = mount();
  expect(b.outcome()).toBeNull();
  expect(b.name()).toBe(t("common.copy"));
  expect(b.icon()).toBe("copy");
  await b.click();
  expect(cb.writes).toEqual([CODE_TEXT]);
  expect(cb.fallbackCalls).toBe(0);
  expect(b.outcome()).toBe("copied");
  expect(b.name()).toBe(t("common.copiedNotice"));
  expect(b.icon()).toBe("check");
});

// The task's bug: both writes refused, and the button turned green anyway.
it("a write both paths refuse shows the failure", async () => {
  const cb = clipboard();
  cb.api = false;
  cb.fallback = false;
  const b = mount();
  await b.click();
  expect(cb.fallbackCalls).toBe(1);
  expect(cb.writes).toEqual([]);
  expect(b.icon()).toBe("cross");
  expect(b.outcome()).toBe("failed");
  expect(b.name()).toBe(t("common.copyFailed"));
});

it("a refused clipboard API with an accepted fallback shows copied", async () => {
  const cb = clipboard();
  cb.api = false;
  const b = mount();
  await b.click();
  expect(cb.writes).toEqual([CODE_TEXT]);
  expect(b.outcome()).toBe("copied");
  expect(b.name()).toBe(t("common.copiedNotice"));
  expect(b.icon()).toBe("check");
});

// One timer per button: a second click restarts it, so the first click's
// timer cannot cut the second outcome short. The reset removes the attribute
// (not just its value), so the stylesheet's plain hover applies again.
it("each outcome shows for the full reset time, then the button is plain again", async () => {
  jest.useFakeTimers();
  const cb = clipboard();
  const b = mount();
  await b.click();
  expect(b.outcome()).toBe("copied");
  await act(async () => void jest.advanceTimersByTime(1000));
  cb.api = false;
  cb.fallback = false;
  await b.click();
  expect(b.outcome()).toBe("failed");
  // 1.6 s after the first click, 0.6 s after the second.
  await act(async () => void jest.advanceTimersByTime(600));
  expect(b.outcome()).toBe("failed");
  expect(b.name()).toBe(t("common.copyFailed"));
  expect(b.icon()).toBe("cross");
  await act(async () => void jest.advanceTimersByTime(1000));
  expect(b.button().hasAttribute("data-copy-outcome")).toBe(false);
  expect(b.name()).toBe(t("common.copy"));
  expect(b.icon()).toBe("copy");
});
