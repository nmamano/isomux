// The schedule instructions dialog writes through GET/PUT /api/cron-instructions
// with the version of the text it opened on (task 379ae5db): a write from a
// stale tab is refused and the dialog stays open with the draft.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { CronjobsPromptDialog } = await import("./CronjobsPromptDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { versionOf } = await import("../../shared/blob-version.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { createElement } = await import("react");
afterAll(() => setApiShim(null));

function open(conflict: boolean) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path === "/api/cron-instructions")
      return { instructions: "Stored", version: versionOf("Stored") };
    writes.push({ method, path, body });
    if (conflict)
      throw new ApiError(409, "version_conflict", "conflict", {
        version: versionOf("Other"),
      });
    const b = body as { instructions: string | null };
    return {
      instructions: b.instructions,
      version: versionOf(b.instructions ?? ""),
    };
  });
  let closed = 0;
  const view = render(
    onLanguage(
      null,
      createElement(CronjobsPromptDialog, { onClose: () => closed++ }),
      { cronjobsPrompt: "Stored" },
    ),
  );
  return { view, writes, closed: () => closed };
}

async function editAndSave(view: ReturnType<typeof render>) {
  const { t } = translatorFor("en");
  await act(async () => {});
  await act(async () => {
    fireEvent.change(view.container.querySelector("textarea")!, {
      target: { value: "Edited" },
    });
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  });
}

it("saves the text with the version of the text it opened on", async () => {
  const d = open(false);
  await editAndSave(d.view);
  await waitFor(() => expect(d.closed()).toBe(1));
  expect(d.writes).toEqual([
    {
      method: "PUT",
      path: "/api/cron-instructions",
      body: { instructions: "Edited", version: versionOf("Stored") },
    },
  ]);
  d.view.unmount();
});

it("stays open with the draft when the write is refused", async () => {
  const d = open(true);
  await editAndSave(d.view);
  await waitFor(() => expect(d.writes.length).toBe(1));
  await act(async () => {});
  expect(d.closed()).toBe(0);
  expect(d.view.container.querySelector("textarea")!.value).toBe("Edited");
  d.view.unmount();
});

// The text comes from the read on open, so nothing typed before it lands may
// be overwritten, and a language switch must not read again over the draft.
it("holds the field until the read lands, and reads only once", async () => {
  let reads = 0;
  let answer: (value: unknown) => void = () => {};
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/cron-instructions") {
      reads++;
      return reads === 1
        ? new Promise((resolve) => (answer = resolve))
        : { instructions: "Re-read", version: versionOf("Re-read") };
    }
    throw new Error(`no shim for ${method} ${path}`);
  });
  const dialog = (language: "es" | null) =>
    onLanguage(
      language,
      createElement(CronjobsPromptDialog, { onClose: () => {} }),
      { cronjobsPrompt: "Stored" },
    );
  const view = render(dialog(null));
  const field = () => view.container.querySelector("textarea")!;
  await act(async () => {});
  expect(field().readOnly).toBe(true);
  await act(async () => {
    answer({ instructions: "Stored", version: versionOf("Stored") });
  });
  expect(field().readOnly).toBe(false);
  await act(async () => {
    fireEvent.change(field(), { target: { value: "Draft" } });
  });
  view.rerender(dialog("es"));
  await act(async () => {});
  expect(reads).toBe(1);
  expect(field().value).toBe("Draft");
  view.unmount();
});
