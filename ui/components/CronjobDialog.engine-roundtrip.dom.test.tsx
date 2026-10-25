// New schedule: an engine round trip (Claude, Codex, Claude) leaves nothing to
// discard, and the Codex leg picks the model defaultBackendModel picks from
// the fetched list (task be07770f).

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { CronjobDialog } = await import("./CronjobDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
const { CODEX_MODELS, DEFAULT_EFFORT } = await import("../../shared/types.ts");

// The login's default is neither first in the list nor Isomux's canonical
// Codex model, so only the defaultBackendModel rule picks it.
const efforts = [{ level: DEFAULT_EFFORT }];
const models = [
  { id: "m-first", label: "First", supportedEfforts: efforts },
  {
    id: "m-default",
    label: "Default",
    isDefault: true,
    supportedEfforts: efforts,
  },
];
expect(models.map((m) => m.id)).not.toContain(CODEX_MODELS[0].value);

let modelFetches = 0;
setApiShim(async (method, path) => {
  if (path === "/api/validate/cwd") return { ok: true };
  if (method === "POST" && path === "/api/backends/codex/models") {
    modelFetches++;
    return { models };
  }
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));

function pressEscape() {
  act(() => {
    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
  });
}

it("closes on Escape after Claude, Codex, Claude, and picks the login's default Codex model", async () => {
  let closes = 0;
  const view = render(
    onLanguage(
      null,
      createElement(CronjobDialog, {
        onClose: () => {
          closes++;
        },
      }),
      { rooms: [], hasReceivedInitialState: true },
    ),
  );
  const engine = view.container
    .querySelector('option[value="codex"]')!
    .closest("select") as HTMLSelectElement;
  expect(engine.value).toBe("claude");

  act(() => {
    fireEvent.change(engine, { target: { value: "codex" } });
  });
  // The model list loaded and the dialog picked from it: the condition under
  // which the old code re-stamped the discard baseline.
  await waitFor(() => {
    const picked = view.container
      .querySelector('option[value="m-default"]')
      ?.closest<HTMLSelectElement>("select");
    expect(picked?.value).toBe("m-default");
  });
  expect(modelFetches).toBe(1);

  // On Codex the form differs from how it opened, so Escape asks first.
  pressEscape();
  expect(closes).toBe(0);
  pressEscape(); // dismisses the discard prompt

  act(() => {
    fireEvent.change(engine, { target: { value: "claude" } });
  });
  expect(engine.value).toBe("claude");
  pressEscape();
  expect(closes).toBe(1);
});
