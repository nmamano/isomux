// The lobby elevator's dialog (task 5a1891f9): the floors from the store, a
// click that opens one, a remove that opens nothing, and an add field that
// refuses this office and shows the server's refusals inline.
//
// Markers the dialog carries: each floor is an element with data-floor-id;
// its open and remove controls are buttons with data-floor-action="open" and
// "remove"; the add button has data-floor-action="add"; an inline error has
// role="alert".
import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ElevatorDialog } = await import("./ElevatorDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { normaliseFloorUrl } = await import("../../shared/floors.ts");
const { createElement } = await import("react");
afterAll(() => setApiShim(null));

import type { Floor } from "../../shared/floors.ts";

const OWN = "https://here.example.com";
const named: Floor = {
  id: "f1",
  url: "https://harbor.example.com",
  name: "Harbor",
  addedAt: 1,
};
const unnamed: Floor = {
  id: "f2",
  url: "http://lab.example.org:4000",
  name: null,
  addedAt: 2,
};

type Call = { method: string; path: string; body: unknown };

function open(
  floors: Floor[],
  answer: (call: Call) => Promise<unknown> = async () => ({}),
) {
  const calls: Call[] = [];
  setApiShim(async (method, path, body) => {
    const call = { method, path, body };
    calls.push(call);
    return answer(call);
  });
  const opened: string[] = [];
  const view = render(
    onLanguage(
      null,
      createElement(ElevatorDialog, {
        onClose: () => {},
        ownOrigin: OWN,
        openFloor: (url: string) => opened.push(url),
      }),
      { floors },
    ),
  );
  const rows = () =>
    [...view.container.querySelectorAll("[data-floor-id]")] as HTMLElement[];
  const action = (el: ParentNode, name: string) =>
    el.querySelector(`[data-floor-action="${name}"]`) as HTMLElement;
  const field = () => view.getByRole("textbox") as HTMLInputElement;
  const alertText = () =>
    view.queryByRole("alert")?.textContent?.trim() ?? null;
  async function submit(text: string) {
    await act(async () => {
      fireEvent.change(field(), { target: { value: text } });
    });
    await act(async () => {
      fireEvent.click(action(view.container, "add"));
    });
  }
  return { view, calls, opened, rows, action, field, alertText, submit };
}

describe("ElevatorDialog", () => {
  it("lists the floors in order, with the host when a floor has no name", () => {
    const d = open([named, unnamed]);
    const rows = d.rows();
    expect(rows.map((r) => r.getAttribute("data-floor-id"))).toEqual([
      "f1",
      "f2",
    ]);
    expect(rows[0].textContent).toContain("Harbor");
    expect(rows[0].textContent).toContain("harbor.example.com");
    expect(rows[1].textContent).toContain("lab.example.org:4000");
    d.view.unmount();
  });

  it("opens a floor on a click, and a remove sends DELETE and opens nothing", async () => {
    const d = open([named, unnamed]);
    expect(d.rows().length).toBe(2);
    await act(async () => {
      fireEvent.click(d.action(d.rows()[1], "open"));
    });
    expect(d.opened).toEqual([unnamed.url]);

    const remove = d.action(d.rows()[0], "remove");
    // An icon button still has a name for a screen reader.
    expect(
      (remove.getAttribute("aria-label") ?? remove.getAttribute("title") ?? "")
        .length,
    ).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(d.calls).toEqual([
      { method: "DELETE", path: "/api/floors/f1", body: undefined },
    ]);
    expect(d.opened).toEqual([unnamed.url]);
    d.view.unmount();
  });

  it("adds a bare host as an https office and clears the field", async () => {
    const d = open([], async () => ({ floor: named }));
    await d.submit("harbor.example.com");
    await waitFor(() => expect(d.calls.length).toBe(1));
    const [call] = d.calls;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/floors");
    const url = (call.body as { url: string }).url;
    expect(normaliseFloorUrl(url)).toBe("https://harbor.example.com");
    // The server takes the name from the other office, never from the body.
    expect(Object.keys(call.body as object)).toEqual(["url"]);
    await waitFor(() => expect(d.field().value).toBe(""));
    expect(d.alertText()).toBeNull();
    d.view.unmount();
  });

  it("refuses this office and an address that is not http(s) without a call", async () => {
    const d = open([]);
    await d.submit("HERE.example.com/lobby");
    const own = d.alertText();
    expect(own).toBeTruthy();
    await d.submit("ftp://files.example.com");
    expect(d.alertText()).toBeTruthy();
    expect(d.calls).toEqual([]);
    d.view.unmount();
  });

  it("shows each refusal inline, keeps the address, and tells them apart", async () => {
    let refusal = new ApiError(500, "unset", "unset");
    const d = open([], async () => {
      throw refusal;
    });
    const texts: string[] = [];
    for (const [i, [status, code]] of (
      [
        [422, "office_unreachable"],
        [409, "floor_exists"],
      ] as const
    ).entries()) {
      refusal = new ApiError(status, code, code);
      await d.submit("harbor.example.com");
      // The refusal of this round, not the alert left from the one before.
      await waitFor(() => expect(d.calls.length).toBe(i + 1));
      await act(async () => {});
      expect(d.alertText()).toBeTruthy();
      expect(d.field().value).toBe("harbor.example.com");
      texts.push(d.alertText()!);
    }
    await d.submit(OWN);
    expect(d.calls.length).toBe(2);
    texts.push(d.alertText()!);
    expect(new Set(texts).size).toBe(3);
    d.view.unmount();
  });

  // An unknown code falls back to the server's English detail, so a text that
  // differs from the unreachable one is not enough: the outdated text must come
  // from the catalog, which a second language shows.
  it("shows its own translated message for an office that must update first", async () => {
    const SERVER_DETAIL = "server detail";
    const shown = async (
      language: "en" | "ca",
      code: "office_outdated" | "office_unreachable",
    ) => {
      const calls: Call[] = [];
      setApiShim(async (method, path, body) => {
        calls.push({ method, path, body });
        throw new ApiError(422, code, SERVER_DETAIL);
      });
      const view = render(
        onLanguage(
          language,
          createElement(ElevatorDialog, {
            onClose: () => {},
            ownOrigin: OWN,
            openFloor: () => {},
          }),
          { floors: [] },
        ),
      );
      await act(async () => {
        fireEvent.change(view.getByRole("textbox"), {
          target: { value: "harbor.example.com" },
        });
      });
      await act(async () => {
        fireEvent.click(
          view.container.querySelector(
            '[data-floor-action="add"]',
          ) as HTMLElement,
        );
      });
      await waitFor(() => expect(calls.length).toBe(1));
      await act(async () => {});
      const text = view.queryByRole("alert")?.textContent?.trim() ?? "";
      view.unmount();
      return text;
    };
    const outdated = await shown("en", "office_outdated");
    const unreachable = await shown("en", "office_unreachable");
    const outdatedCa = await shown("ca", "office_outdated");
    expect(outdated.length).toBeGreaterThan(0);
    expect(outdated).not.toBe(SERVER_DETAIL);
    expect(outdated).not.toBe(unreachable);
    expect(outdatedCa.length).toBeGreaterThan(0);
    expect(outdatedCa).not.toBe(outdated);
  });

  it("sends one add while the server checks the address", async () => {
    let settle: (v: unknown) => void = () => {};
    const d = open(
      [],
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await d.submit("harbor.example.com");
    await act(async () => {
      fireEvent.click(d.action(d.view.container, "add"));
    });
    expect(d.calls.length).toBe(1);
    await act(async () => {
      settle({ floor: named });
    });
    d.view.unmount();
  });
});
