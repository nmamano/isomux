// The lobby elevator's dialog (task 5a1891f9): the floors from the store, a
// click that opens one, a remove that opens nothing, and an add field that
// refuses this office and shows the server's refusals inline.
//
// The panel (task 42be5397): the offices this browser rode through and their
// floors, this office lit and not a ride, a personal remove that stays in this
// browser, rides that carry the panel, and names this office's server looks
// up (never more than four at a time; a failed one is kept, a busy one is
// asked again).
//
// Markers the dialog carries: each panel button is an element with
// data-panel-url and data-panel-kind ("here", "floor", "visited",
// "snapshot"); an office floor also has data-floor-id; the open and remove
// controls are buttons with data-floor-action="open" and "remove"; the add
// button has data-floor-action="add"; an inline error has role="alert".
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ElevatorDialog } = await import("./ElevatorDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { normaliseFloorUrl } = await import("../../shared/floors.ts");
const { createElement } = await import("react");
const { commitPanel, readPanel, rememberName, PANEL_NAME_TTL_MS } =
  await import("../elevator-panel-store.ts");
const { mergePanels, panelButtons, readPanelFragment, sanitisePanel } =
  await import("../../shared/elevator-panel.ts");
afterAll(() => setApiShim(null));
afterEach(() => localStorage.clear());

import type { Floor } from "../../shared/floors.ts";
import type { Panel } from "../../shared/elevator-panel.ts";

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
  let closes = 0;
  const view = render(
    onLanguage(
      null,
      createElement(ElevatorDialog, {
        onClose: () => {
          closes++;
        },
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
  return {
    view,
    calls,
    opened,
    rows,
    action,
    field,
    alertText,
    submit,
    closes: () => closes,
  };
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
    expect(d.opened.map((u) => new URL(u).origin)).toEqual([unnamed.url]);

    const remove = d.action(d.rows()[0], "remove");
    // An icon button still has a name for a screen reader.
    expect(
      (remove.getAttribute("aria-label") ?? remove.getAttribute("title") ?? "")
        .length,
    ).toBeGreaterThan(0);
    // Remove asks first (task c6589760): the first click arms it.
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(d.calls).toEqual([]);
    expect(remove.hasAttribute("data-confirm-armed")).toBe(true);
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(d.calls).toEqual([
      { method: "DELETE", path: "/api/floors/f1", body: undefined },
    ]);
    expect(d.opened.map((u) => new URL(u).origin)).toEqual([unnamed.url]);
    d.view.unmount();
  });

  // The dialog closes on Escape from a window listener (task c6589760): on
  // an armed remove, Escape ends the confirm and the dialog stays.
  it("Escape on an armed remove ends the confirm and keeps the dialog; the next Escape closes it", async () => {
    const d = open([named]);
    const remove = d.action(d.rows()[0], "remove");
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(remove.hasAttribute("data-confirm-armed")).toBe(true);
    await act(async () => {
      fireEvent.keyDown(remove, { key: "Escape" });
    });
    expect([remove.hasAttribute("data-confirm-armed"), d.closes()]).toEqual([
      false,
      0,
    ]);
    await act(async () => {
      fireEvent.keyDown(remove, { key: "Escape" });
    });
    expect(d.closes()).toBe(1);
    expect(d.calls).toEqual([]);
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

// Offices only this browser's panel holds.
const ATLAS = "https://atlas.example.com";
const COVE = "https://cove.example.com";
const DOCK = "http://dock.example.org:4000";

const panelOf = (p: Partial<Panel>): Panel => ({
  visited: p.visited ?? [],
  removed: p.removed ?? [],
  snapshots: p.snapshots ?? [],
});
// Atlas was visited first, with Cove as its floor; then this office.
const trip = panelOf({
  visited: [
    { url: ATLAS, addedAt: 1 },
    { url: OWN, addedAt: 2 },
  ],
  snapshots: [{ origin: ATLAS, rev: 1, floors: [COVE] }],
});
const seed = (p: Panel) => commitPanel(() => p);

const isNameAsk = (c: Call) =>
  c.method === "GET" && c.path.startsWith("/api/floors/name");
const namesAsked = (calls: Call[]) =>
  calls
    .filter(isNameAsk)
    .map((c) => new URL(c.path, "http://x").searchParams.get("url"));
const notNameAsks = (calls: Call[]) => calls.filter((c) => !isNameAsk(c));
const urlOfAsk = (c: Call) =>
  new URL(c.path, "http://x").searchParams.get("url") ?? "";

function panelRows(view: ReturnType<typeof render>) {
  return [
    ...view.container.querySelectorAll("[data-panel-url]"),
  ] as HTMLElement[];
}
const rowFor = (view: ReturnType<typeof render>, url: string) =>
  panelRows(view).find((r) => r.getAttribute("data-panel-url") === url)!;
const shape = (view: ReturnType<typeof render>) =>
  panelRows(view).map((r) => [
    r.getAttribute("data-panel-url"),
    r.getAttribute("data-panel-kind"),
  ]);

describe("ElevatorDialog panel", () => {
  it("lists the offices this browser rode through, each followed by its floors, with this office lit and not a ride", async () => {
    seed(trip);
    const d = open([named], async (c) => (isNameAsk(c) ? { name: null } : {}));
    expect(shape(d.view)).toEqual([
      [ATLAS, "visited"],
      [COVE, "snapshot"],
      [OWN, "here"],
      [named.url, "floor"],
    ]);
    const here = rowFor(d.view, OWN);
    expect(d.action(here, "open")).toBeNull();
    expect(d.action(here, "remove")).toBeNull();
    expect(rowFor(d.view, named.url).getAttribute("data-floor-id")).toBe("f1");
    await act(async () => {});
    d.view.unmount();
  });

  it("removes a personal entry in this browser only, with its office's floors, and sends no call", async () => {
    seed(trip);
    const d = open([named], async (c) => (isNameAsk(c) ? { name: null } : {}));
    // A personal remove asks first too (task c6589760).
    await act(async () => {
      fireEvent.click(d.action(rowFor(d.view, ATLAS), "remove"));
    });
    expect(
      d
        .action(rowFor(d.view, ATLAS), "remove")
        .hasAttribute("data-confirm-armed"),
    ).toBe(true);
    await act(async () => {
      fireEvent.click(d.action(rowFor(d.view, ATLAS), "remove"));
    });
    expect(notNameAsks(d.calls)).toEqual([]);
    expect(d.opened).toEqual([]);
    expect(shape(d.view)).toEqual([
      [OWN, "here"],
      [named.url, "floor"],
    ]);
    const kept = readPanel();
    expect(panelButtons(kept, OWN, [named]).map((b) => b.url)).toEqual([
      OWN,
      named.url,
    ]);
    d.view.unmount();
  });

  it("opens a ride that carries the panel as it is at the click, from this office", async () => {
    seed(trip);
    const d = open([named], async (c) => (isNameAsk(c) ? { name: null } : {}));
    // Another tab rode to Dock after this dialog opened.
    commitPanel((p) =>
      mergePanels(
        p,
        panelOf({ visited: [{ url: DOCK, addedAt: 3 }] }),
        Date.now(),
      ),
    );
    await act(async () => {
      fireEvent.click(d.action(rowFor(d.view, COVE), "open"));
    });
    await act(async () => {
      fireEvent.click(d.action(rowFor(d.view, named.url), "open"));
    });
    expect(d.opened.map((u) => new URL(u).origin)).toEqual([COVE, named.url]);
    for (const url of d.opened) {
      const read = readPanelFragment(new URL(url).hash);
      expect(read?.from).toBe(OWN);
      const carried = sanitisePanel(read?.panel, Date.now());
      expect(carried.visited.map((x) => x.url).sort()).toEqual(
        [ATLAS, DOCK, OWN].sort(),
      );
      expect(carried.snapshots.find((x) => x.origin === ATLAS)?.floors).toEqual(
        [COVE],
      );
    }
    d.view.unmount();
  });

  it("asks this office's server for each personal entry's name, and shows the host until it answers", async () => {
    seed(trip);
    const answers = new Map<string, (v: unknown) => void>();
    const d = open([named], (c) =>
      isNameAsk(c)
        ? new Promise((resolve) => answers.set(urlOfAsk(c), resolve))
        : Promise.resolve({}),
    );
    await waitFor(() => expect(answers.size).toBe(2));
    // Never for this office or its own floors.
    expect(namesAsked(d.calls).sort()).toEqual([ATLAS, COVE].sort());
    expect(rowFor(d.view, ATLAS).textContent).toContain("atlas.example.com");
    await act(async () => {
      answers.get(ATLAS)!({ name: "Atlas Works" });
    });
    await waitFor(() =>
      expect(rowFor(d.view, ATLAS).textContent).toContain("Atlas Works"),
    );
    d.view.unmount();

    // A fresh answer is not asked again.
    const again = open([named], async (c) =>
      isNameAsk(c) ? { name: "Cove" } : {},
    );
    expect(rowFor(again.view, ATLAS).textContent).toContain("Atlas Works");
    await act(async () => {});
    expect(namesAsked(again.calls)).toEqual([COVE]);
    again.view.unmount();
  });

  it("keeps a failed name until it is stale, and asks a busy one again at the next open", async () => {
    seed(trip);
    const answer = async (c: Call) => {
      if (!isNameAsk(c)) return {};
      if (urlOfAsk(c) === ATLAS)
        throw new ApiError(422, "office_unreachable", "unreachable");
      throw new ApiError(429, "too_many_requests", "busy");
    };
    const first = open([named], answer);
    await waitFor(() => expect(namesAsked(first.calls).length).toBe(2));
    await act(async () => {});
    expect(rowFor(first.view, ATLAS).textContent).toContain(
      "atlas.example.com",
    );
    first.view.unmount();

    const second = open([named], answer);
    await waitFor(() => expect(namesAsked(second.calls)).toEqual([COVE]));
    await act(async () => {});
    second.view.unmount();

    rememberName(
      ATLAS,
      null,
      [ATLAS, COVE, OWN],
      Date.now() - PANEL_NAME_TTL_MS - 1000,
    );
    const third = open([named], answer);
    await waitFor(() =>
      expect(namesAsked(third.calls).sort()).toEqual([ATLAS, COVE].sort()),
    );
    await act(async () => {});
    third.view.unmount();
  });

  it("asks at most four names at a time", async () => {
    const many = Array.from(
      { length: 6 },
      (_, i) => `https://office${i}.example.com`,
    );
    seed(
      panelOf({
        visited: [
          ...many.map((url, i) => ({ url, addedAt: i + 1 })),
          { url: OWN, addedAt: 10 },
        ],
      }),
    );
    const answers: Array<(v: unknown) => void> = [];
    const d = open([], (c) =>
      isNameAsk(c)
        ? new Promise((resolve) => answers.push(resolve))
        : Promise.resolve({}),
    );
    await waitFor(() => expect(answers.length).toBe(4));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(answers.length).toBe(4);
    await act(async () => {
      answers[0]({ name: "First" });
    });
    await waitFor(() => expect(answers.length).toBe(5));
    await act(async () => {
      for (const resolve of answers) resolve({ name: null });
    });
    await waitFor(() => expect(answers.length).toBe(6));
    await act(async () => {
      answers[5]({ name: null });
    });
    d.view.unmount();
  });
});
