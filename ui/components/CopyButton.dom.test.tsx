// The icon copy button says what happened (task acddc30f): green only after a
// write the browser accepted, a failed state when nothing reached the
// clipboard. An empty text counts as nothing copied.
import { afterEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { CopyButton } = await import("./CopyButton.tsx");
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

// The clipboard API and the textarea fallback, each accepting or refusing.
// `writes` records every text that reached either path.
function clipboard() {
  const state = { accept: true, writes: [] as string[] };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (!state.accept) throw new Error("NotAllowedError");
        state.writes.push(text);
      },
    },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => {
      if (state.accept) state.writes.push("(fallback)");
      return state.accept;
    },
  });
  return state;
}

function mount(getText: () => string) {
  let failures = 0;
  const view = render(
    <CopyButton getText={getText} onCopyFailed={() => void failures++} />,
  );
  const button = () => view.getByRole("button");
  return {
    view,
    failures: () => failures,
    name: () => button().getAttribute("title"),
    click: () =>
      act(async () => {
        fireEvent.click(button());
      }),
  };
}

it("a write the browser accepts shows copied, and no failure", async () => {
  const cb = clipboard();
  const b = mount(() => "TEXT_MARKER");
  expect(b.name()).toBe(t("common.copy"));
  await b.click();
  expect(cb.writes).toEqual(["TEXT_MARKER"]);
  expect(b.name()).toBe(t("common.copiedNotice"));
  expect(b.failures()).toBe(0);
});

it("a write both paths refuse shows the failure, and still tells the caller", async () => {
  const cb = clipboard();
  cb.accept = false;
  const b = mount(() => "TEXT_MARKER");
  await b.click();
  expect(cb.writes).toEqual([]);
  expect(b.name()).toBe(t("common.copyFailed"));
  expect(b.failures()).toBe(1);
});

it("a text that cannot be built shows the failure and writes nothing", async () => {
  const cb = clipboard();
  const b = mount(() => {
    throw new Error("no text");
  });
  await b.click();
  expect(cb.writes).toEqual([]);
  expect(b.name()).toBe(t("common.copyFailed"));
  expect(b.failures()).toBe(1);
});

// The task's bug: an empty text was written and the button turned green.
it("an empty text is nothing copied: the failure, and no write", async () => {
  const cb = clipboard();
  const b = mount(() => "");
  await b.click();
  expect(cb.writes).toEqual([]);
  expect(b.name()).toBe(t("common.copyFailed"));
  expect(b.failures()).toBe(1);
});

it("the newest outcome shows, in either order", async () => {
  const cb = clipboard();
  const b = mount(() => "TEXT_MARKER");
  cb.accept = false;
  await b.click();
  expect(b.name()).toBe(t("common.copyFailed"));
  cb.accept = true;
  await b.click();
  expect(b.name()).toBe(t("common.copiedNotice"));
  cb.accept = false;
  await b.click();
  expect(b.name()).toBe(t("common.copyFailed"));
});

// One reset timer: a second click restarts it, so the first click's timer
// cannot cut the second outcome short (two failures, so a timer per state
// would still cut it).
it("each outcome shows for the full reset time, then the button is plain again", async () => {
  jest.useFakeTimers();
  const cb = clipboard();
  cb.accept = false;
  const b = mount(() => "TEXT_MARKER");
  await b.click();
  await act(async () => void jest.advanceTimersByTime(1000));
  await b.click();
  expect(b.name()).toBe(t("common.copyFailed"));
  // 1.6 s after the first click, 0.6 s after the second.
  await act(async () => void jest.advanceTimersByTime(600));
  expect(b.name()).toBe(t("common.copyFailed"));
  await act(async () => void jest.advanceTimersByTime(1000));
  expect(b.name()).toBe(t("common.copy"));
});
