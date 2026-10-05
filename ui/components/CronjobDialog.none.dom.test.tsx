// The "none" schedule in the cronjob dialog (ruling 7 of
// internal-docs/webhooks-loop.md): the dialog offers it, it has no time or
// interval inputs, and a save sends `{ type: "none" }`.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { CronjobDialog } = await import("./CronjobDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");

const posted: { method: string; path: string; body: unknown }[] = [];
setApiShim(async (method, path, body) => {
  if (path === "/api/validate/cwd") return { ok: true };
  if (method === "POST" && path === "/api/cronjobs") {
    posted.push({ method, path, body });
    return {};
  }
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));

it('offers "none", which drops the clock inputs and saves { type: "none" }', async () => {
  let closed = false;
  const view = render(
    onLanguage(
      null,
      createElement(CronjobDialog, {
        onClose: () => {
          closed = true;
        },
      }),
      { rooms: [], hasReceivedInitialState: true },
    ),
  );
  const option = view.container.querySelector('option[value="none"]');
  expect(option).not.toBeNull();
  const select = option!.closest("select") as HTMLSelectElement;
  // The default schedule has a clock.
  expect(view.container.querySelectorAll('input[type="number"]').length).toBe(
    2,
  );
  act(() => {
    fireEvent.change(select, { target: { value: "none" } });
  });
  expect(view.container.querySelectorAll('input[type="number"]').length).toBe(
    0,
  );

  const prompt = view.container.querySelector("textarea")!;
  act(() => {
    fireEvent.change(prompt, { target: { value: "Triage the PR." } });
  });
  const buttons = [...view.container.querySelectorAll("button")];
  const save = buttons.at(-1)!;
  act(() => {
    fireEvent.click(save);
  });
  await waitFor(() => expect(posted).toHaveLength(1));
  expect((posted[0].body as { schedule: unknown }).schedule).toEqual({
    type: "none",
  });
  await waitFor(() => expect(closed).toBe(true));
});
