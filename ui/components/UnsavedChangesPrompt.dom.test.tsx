// The unsaved-changes prompt's state machine (task ee577900). A member who
// asks to leave a dirty form gets the prompt, and the exit waits on it. When
// the form turns clean while the prompt is open (the save it raced has
// landed), the prompt closes and the exit runs - except in a caller that opts
// out, where the prompt guards something other than unsaved text.
//
// The harness drives the hook the way its callers do: a parent calls the
// closeRef (or the form calls request), the form's own state turns dirty or
// clean, and the member clicks the prompt's buttons.

import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { createElement, useState } = await import("react");
const { flushSync } = await import("react-dom");
const { UnsavedChangesPrompt, useUnsavedChangesPrompt } =
  await import("./UnsavedChangesPrompt.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");

afterEach(cleanup);

type Close = (after?: () => void) => void;

/** One mounted form: its dirty switch, its prompt, and what ran, in order. */
function mount({ resumeWhenClean }: { resumeWhenClean?: boolean } = {}) {
  const ran: string[] = [];
  const closeRef: { current: Close | null } = { current: null };
  let setDirty!: (dirty: boolean) => void;
  let request!: Close;

  function Form() {
    const [dirty, set] = useState(true);
    setDirty = set;
    const prompt = useUnsavedChangesPrompt(dirty, {
      closeRef,
      // Discard resets the fields, as every caller's onDiscard does.
      onDiscard: () => {
        ran.push("discard");
        set(false);
      },
      onLeave: () => ran.push("leave"),
      ...(resumeWhenClean !== undefined && { resumeWhenClean }),
    });
    request = prompt.request;
    return prompt.open
      ? createElement(UnsavedChangesPrompt, {
          onDiscard: prompt.discard,
          onCancel: prompt.cancel,
        })
      : null;
  }

  const view = render(onLanguage("en", createElement(Form)));
  const exit = () => ran.push("exit");
  return {
    ran,
    exit,
    open: () => view.queryByText(t("common.discardPrompt")) !== null,
    /** The parent's navigation, through the ref the hook fills. */
    leave: async () => {
      await act(async () => closeRef.current!(exit));
    },
    /** The form's own close button, through the returned request. */
    leaveFromForm: async () => {
      await act(async () => request(exit));
    },
    /** Commits the render and its effects before it returns. */
    setDirtyNow: (next: boolean) => flushSync(() => setDirty(next)),
    dirty: async (next: boolean) => {
      await act(async () => setDirty(next));
    },
    click: async (label: string) => {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: label }));
      });
    },
    /** Lets the deferred close fire. */
    tick: async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

describe("a prompt opened while the form is dirty", () => {
  it("closes and runs the exit once when the form turns clean", async () => {
    const form = mount();
    await form.leave();
    expect(form.open()).toBe(true);
    expect(form.ran).toStrictEqual([]);

    await form.dirty(false);
    await form.tick();
    expect(form.open()).toBe(false);
    expect(form.ran).toStrictEqual(["leave", "exit"]);

    // Nothing replays it later.
    await form.dirty(true);
    await form.dirty(false);
    await form.tick();
    expect(form.ran).toStrictEqual(["leave", "exit"]);
  });

  it("does the same for a request from the form's own close button", async () => {
    const form = mount();
    await form.leaveFromForm();
    expect(form.open()).toBe(true);
    await form.dirty(false);
    await form.tick();
    expect(form.open()).toBe(false);
    expect(form.ran).toStrictEqual(["leave", "exit"]);
  });

  it("stays open with its exit when the form turns dirty again before the close fires", async () => {
    const form = mount();
    await form.leave();
    // Clean, committed with its effects, then dirty again (more typing), all
    // in one synchronous act, so the deferred close cannot fire in between.
    act(() => {
      form.setDirtyNow(false);
      form.setDirtyNow(true);
    });
    await form.tick();
    expect(form.open()).toBe(true);
    expect(form.ran).toStrictEqual([]);

    // The exit is still the one the member asked for.
    await form.click(t("common.discard"));
    expect(form.ran).toStrictEqual(["discard", "leave", "exit"]);
  });

  it("on Discard resets the form, then leaves, once", async () => {
    const form = mount();
    await form.leave();
    await form.click(t("common.discard"));
    expect(form.open()).toBe(false);
    // onDiscard turned the form clean: that must not run the exit again.
    await form.tick();
    expect(form.ran).toStrictEqual(["discard", "leave", "exit"]);
  });

  it("on Cancel drops the exit, and a later save does not run it", async () => {
    const form = mount();
    await form.leave();
    await form.click(t("common.cancel"));
    expect(form.open()).toBe(false);
    await form.dirty(false);
    await form.tick();
    expect(form.ran).toStrictEqual([]);
  });

  it("closes without running the exit in a caller that opts out", async () => {
    const form = mount({ resumeWhenClean: false });
    await form.leave();
    expect(form.open()).toBe(true);
    await form.dirty(false);
    await form.tick();
    expect(form.open()).toBe(false);
    expect(form.ran).toStrictEqual([]);
  });
});

it("leaves a clean form at once, with no prompt", async () => {
  const form = mount();
  await form.dirty(false);
  await form.tick();
  await form.leave();
  await form.leaveFromForm();
  expect(form.open()).toBe(false);
  expect(form.ran).toStrictEqual(["leave", "exit", "leave", "exit"]);
});
