import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { blockShape } from "../test-support/held-shape.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { ExternalAccessPane } = await import("./ExternalAccessPane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const t = translatorFor("en").t;
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
  expect(view.queryByText("https://acme.isomux.app")).not.toBeNull();
  expect(view.queryByText(t("settings.externalAccess.managed"))).not.toBeNull();
  expect(view.queryByRole("textbox")).toBeNull();
  expect(view.queryByRole("checkbox")).toBeNull();
  expect(view.queryAllByRole("button")).toHaveLength(0);
  // No restart instructions: the office cannot change its bind.
  expect(view.container.querySelectorAll("code")).toHaveLength(0);
});

it("saves the switch off with no address and shows the restart commands", async () => {
  const puts: unknown[] = [];
  setApiShim(async (method, _path, body) => {
    if (method === "GET")
      return {
        hosted: false,
        externalAccess: true,
        publicOrigin: "https://office.example",
        boundLoopback: false,
      };
    puts.push(body);
    return { signInUrl: null, restartRequired: true };
  });
  const view = render(onLanguage(null, <ExternalAccessPane />));
  await act(async () => {});
  expect(view.queryByRole("textbox")).not.toBeNull();
  await act(async () => {
    fireEvent.click(view.getByRole("checkbox"));
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  });
  // Switched off, the address goes out empty.
  expect(puts).toStrictEqual([{ externalAccess: false, publicOrigin: "" }]);
  // The self-hosted switch stays, with a restart command per service kind.
  expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(
    [...view.container.querySelectorAll("code")].map((c) => c.textContent),
  ).toStrictEqual([
    "systemctl --user restart isomux",
    "sudo systemctl restart isomux",
  ]);
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

  // A device that never loaded the pane, on a public address, holds the
  // switched-on form: the office answers there only with external access on.
  window.localStorage.clear();
  const setURL = (url: string) =>
    (
      window as unknown as { happyDOM: { setURL: (url: string) => void } }
    ).happyDOM.setURL(url);
  setURL("https://office.example/settings");
  let view: ReturnType<typeof mount>;
  try {
    view = mount();
  } finally {
    setURL("http://localhost/");
  }
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

// Task ee577900: the page asks to leave while the address is unsaved, and the
// member saves - before the ask or from its prompt. When the save lands, the
// prompt goes away and the page leaves; when it fails, both stay.
for (const order of ["save first", "leave first"] as const) {
  it(`settles the discard prompt with the save it raced (${order})`, async () => {
    const held: {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
    }[] = [];
    setApiShim(async (method) => {
      if (method === "GET")
        return {
          hosted: false,
          externalAccess: true,
          publicOrigin: "https://office.example",
          boundLoopback: false,
        };
      return new Promise((resolve, reject) => held.push({ resolve, reject }));
    });
    const closeRef: {
      current: ((after?: () => void) => void) | null;
    } = { current: null };
    const prompt = (view: ReturnType<typeof render>) =>
      view.queryByText(t("settings.externalAccess.discardPrompt")) !== null;

    for (const outcome of ["saved", "failed"] as const) {
      const left: string[] = [];
      const view = render(
        onLanguage(null, <ExternalAccessPane closeRef={closeRef} />),
      );
      await act(async () => {});
      await act(async () => {
        fireEvent.change(view.getByRole("textbox"), {
          target: { value: "https://new.example" },
        });
      });
      const leave = async () => {
        await act(async () => closeRef.current!(() => left.push("left")));
      };
      const save = async () => {
        await act(async () => {
          fireEvent.click(view.getByRole("button", { name: t("common.save") }));
        });
      };
      for (const step of order === "save first" ? [save, leave] : [leave, save])
        await step();
      expect(held, outcome).toHaveLength(1);
      expect(prompt(view), outcome).toBe(true);
      expect(left, outcome).toStrictEqual([]);

      await act(async () => {
        if (outcome === "saved")
          held[0]!.resolve({ signInUrl: null, restartRequired: false });
        else held[0]!.reject(new Error("offline"));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (outcome === "saved") {
        expect(prompt(view), outcome).toBe(false);
        expect(left, outcome).toStrictEqual(["left"]);
      } else {
        expect(
          view.queryByText(t("settings.externalAccess.updateFailed")),
        ).not.toBeNull();
        expect(prompt(view), outcome).toBe(true);
        expect(left, outcome).toStrictEqual([]);
      }
      held.length = 0;
      view.unmount();
    }
  });
}

// Task 69c5f413: on a loopback address (the office binds 127.0.0.1 while
// external access is off), a first visit holds the switched-off form, so the
// URL field does not come and go when the settings arrive.
it("on a loopback address, a device that never loaded the pane holds the form without the URL field", async () => {
  let resolve!: (value: unknown) => void;
  setApiShim(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  window.localStorage.clear();
  expect(window.location.hostname).toBe("localhost");
  const view = render(onLanguage(null, <ExternalAccessPane />));
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.indeterminate).toBe(true);
  expect(view.queryByRole("textbox")).toBeNull();
  const held = blockShape(view.container);
  await act(async () =>
    resolve({
      hosted: false,
      externalAccess: false,
      publicOrigin: null,
      boundLoopback: true,
    }),
  );
  expect((view.getByRole("checkbox") as HTMLInputElement).indeterminate).toBe(
    false,
  );
  expect(blockShape(view.container)).toBe(held);
  view.unmount();
});

// One look per kind of control (AGENTS.md "UI rules"), as in the Office pane:
// the button says it saved only right after this pane's own save. A clean
// form that just loaded offers Save, disabled, the label it held while it
// loaded.
it("labels the button Saved only after its own save, and Save, disabled, on a clean load", async () => {
  setApiShim(async (method) => {
    if (method === "GET")
      return {
        hosted: false,
        externalAccess: true,
        publicOrigin: "https://office.example",
        boundLoopback: false,
      };
    return { signInUrl: null, restartRequired: false };
  });
  const view = render(onLanguage(null, <ExternalAccessPane />));
  // The pane's only button, with no prompt or restart box open.
  const button = () => {
    const buttons = view.getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.length).toBe(1);
    return buttons[0]!;
  };
  const heldLabel = button().textContent;
  await act(async () => {});
  expect(view.queryByRole("textbox")).not.toBeNull();
  expect({ label: button().textContent, disabled: button().disabled }).toEqual({
    label: heldLabel,
    disabled: true,
  });
  expect(heldLabel).toBe(t("common.save"));

  await act(async () => {
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "https://new.example" },
    });
  });
  expect(button().disabled).toBe(false);
  await act(async () => {
    fireEvent.click(button());
  });
  await act(async () => {});
  expect({ label: button().textContent, disabled: button().disabled }).toEqual({
    label: t("common.saved"),
    disabled: true,
  });

  // An edit after the save offers Save again.
  await act(async () => {
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "https://other.example" },
    });
  });
  expect(button().textContent).toBe(t("common.save"));
  view.unmount();
});
