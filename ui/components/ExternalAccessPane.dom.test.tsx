import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { ExternalAccessPane } = await import("./ExternalAccessPane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
afterAll(() => setApiShim(null));

it("shows the hosted address with no URL input, toggle or save", async () => {
  setApiShim(async () => ({
    hosted: true,
    externalAccess: true,
    publicOrigin: "https://acme.isomux.app",
    boundLoopback: false,
  }));
  const view = render(onLanguage(null, <ExternalAccessPane />));
  await act(async () => {});
  expect(view.getByText("https://acme.isomux.app")).toBeTruthy();
  expect(
    view.getByText(
      "Hosted Isomux manages this office's address; it cannot be changed.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("textbox")).toBeNull();
  expect(view.queryByRole("checkbox")).toBeNull();
  expect(view.queryByRole("button", { name: "Save" })).toBeNull();
  expect(view.queryByText(/Control whether this office/)).toBeNull();
  expect(view.queryByText(/restart isomux/)).toBeNull();
});

it("keeps self-hosted controls and the restart instructions after a save", async () => {
  setApiShim(async (method) =>
    method === "GET"
      ? {
          hosted: false,
          externalAccess: true,
          publicOrigin: "https://office.example",
          boundLoopback: false,
        }
      : { signInUrl: null, restartRequired: true },
  );
  const view = render(onLanguage(null, <ExternalAccessPane />));
  await act(async () => {});
  expect(view.getByRole("textbox")).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole("checkbox"));
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  expect(view.getByText("sudo systemctl restart isomux")).toBeTruthy();
  expect(view.getAllByText("systemctl --user restart isomux")).toHaveLength(1);
});

it("shows the form it last loaded on this device while the settings load, with nothing to act on", async () => {
  const answers = {
    hosted: false,
    externalAccess: false,
    publicOrigin: null,
    boundLoopback: true,
  };
  let resolve!: (value: unknown) => void;
  setApiShim(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const mount = () => render(onLanguage(null, <ExternalAccessPane />));

  // A device that never loaded the pane holds the switched-on form.
  window.localStorage.clear();
  let view = mount();
  let box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.indeterminate).toBe(true);
  expect(box.disabled).toBe(true);
  expect((view.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  expect(
    view.container.querySelector<HTMLButtonElement>(
      '[aria-busy="true"] button',
    )!.disabled,
  ).toBe(true);
  await act(async () => resolve(answers));
  box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.indeterminate).toBe(false);
  expect(box.checked).toBe(false);
  expect(view.queryByRole("textbox")).toBeNull();
  view.unmount();

  // The next load holds what this one showed: switched off, no URL field.
  view = mount();
  expect(view.queryByRole("textbox")).toBeNull();
  await act(async () => resolve(answers));
  view.unmount();
});
