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
    publicOrigin: "https://office.isomux.app",
    envOriginSet: false,
    envOrigin: null,
    boundLoopback: false,
  }));
  const view = render(onLanguage(null, <ExternalAccessPane />));
  await act(async () => {});
  expect(view.getByText("https://office.isomux.app")).toBeTruthy();
  expect(
    view.getByText(
      "Hosted Isomux manages this office's address; it cannot be changed here.",
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
          envOriginSet: false,
          envOrigin: null,
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
