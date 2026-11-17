// Settings drill-in (task 1f79f2e3), part two: your own member parts are flat
// rows of the You group, and Members > yourself selects You > Profile; a room
// drills in like a member; a phone goes Settings list > item parts > part.
// Members are in UserSettingsView.drill-in.dom.test.tsx; the setup and the DOM
// contract in ui/test-support/drill-in-fixture.tsx.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { ApiError, setApiShim } = await import("../api.ts");
const { en } = await import("../../shared/i18n/en.ts");
const { LOBBY_ROOM_ID } = await import("../../shared/types.ts");
const {
  ROOM,
  STEPHEN,
  backRow,
  body,
  bodies,
  click,
  current,
  dirty,
  discardPrompt,
  inputWith,
  item,
  listRow,
  mount,
  openPart,
  page,
  partRow,
  parts,
  phoneBack,
  resetDrillIn,
  save,
  settle,
  setRefuse,
  textarea,
  type,
} = await import("../test-support/drill-in-fixture.tsx");

beforeEach(resetDrillIn);
afterAll(() => setApiShim(null));

describe("yourself", () => {
  it("an owner: your parts are flat rows of the You group, before Language and chat; selecting one is not a drill-in", async () => {
    const view = await mount({
      initialTarget: { kind: "user", id: "u1", part: "rooms" },
    });
    const prefs = listRow(view, en["settings.sidebar.languageAndChat"]);
    const lastPart = partRow(view, "instructions");
    expect({
      item: item(view),
      parts: parts(view),
      current: current(view),
      bodies: bodies(view),
      back: backRow(view) !== null,
      officeRow: listRow(view, en["settings.sidebar.office"]) !== null,
      partsBeforePrefs:
        prefs !== null &&
        lastPart !== null &&
        (lastPart.compareDocumentPosition(prefs) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    }).toEqual({
      item: null,
      parts: ["profile", "access", "rooms", "instructions"],
      current: ["rooms"],
      bodies: ["rooms"],
      back: false,
      officeRow: true,
      partsBeforePrefs: true,
    });
    view.unmount();
  });

  it("a member gets Profile, Rooms, and Instructions and memory", async () => {
    const view = await mount(
      { initialTarget: { kind: "user", id: "u1" } },
      {},
      "member",
    );
    expect(parts(view)).toEqual(["profile", "rooms", "instructions"]);
    view.unmount();
  });

  it("Members > yourself selects You > Profile", async () => {
    const view = await mount({
      initialTarget: { kind: "section", section: "theme" },
    });
    // Open the roster, then click your own row in it.
    await click(
      view.baseElement.querySelector('[data-sidebar-group-toggle="members"]'),
    );
    const selfRow = [...view.baseElement.querySelectorAll("button")].find(
      (b) =>
        !b.hasAttribute("data-settings-part") &&
        b.textContent?.includes("Tester"),
    );
    await click(selfRow ?? null);
    expect({
      item: item(view),
      current: current(view),
      bodies: bodies(view),
    }).toEqual({ item: null, current: ["profile"], bodies: ["profile"] });
    view.unmount();
  });

  it("an edit moves with you between your rows with its dot; Language and chat asks first", async () => {
    const view = await mount({ initialTarget: { kind: "user", id: "u1" } });
    await type(inputWith(body(view, "profile"), "Tester"), "Testy");
    await openPart(view, "instructions");
    expect({
      dirty: dirty(view),
      prompt: discardPrompt(view) !== null,
    }).toEqual({ dirty: ["profile"], prompt: false });
    await openPart(view, "profile");
    expect(inputWith(body(view, "profile"), "Testy")).not.toBeNull();
    await click(listRow(view, en["settings.sidebar.languageAndChat"]));
    expect({
      prompt: discardPrompt(view) !== null,
      current: current(view),
    }).toEqual({ prompt: true, current: ["profile"] });
    view.unmount();
  });
  it("a change to your own record keeps the pane that shows and its unsaved edit", async () => {
    // Your record changes under the page (a tab reordered on your phone)
    // while you edit another pane: the page must not start again.
    const props = {
      initialTarget: { kind: "section", section: "deviceLabel" },
    };
    const view = await mount(props);
    const field = () =>
      view.container.querySelector<HTMLInputElement>(
        `input[placeholder="${en["settings.device.placeholder"]}"]`,
      );
    await type(field(), "Desk laptop");
    view.rerender(page(props, {}, "owner", { order: [ROOM.id] }));
    await settle();
    expect(field()?.value).toBe("Desk laptop");
    // The same while one of your own rows shows: its edit stays too.
    view.unmount();
    const own = await mount({ initialTarget: { kind: "user", id: "u1" } });
    await type(inputWith(body(own, "profile"), "Tester"), "Testy");
    own.rerender(
      page({ initialTarget: { kind: "user", id: "u1" } }, {}, "owner", {
        order: [ROOM.id],
      }),
    );
    await settle();
    expect(inputWith(body(own, "profile"), "Testy")).not.toBeNull();
    own.unmount();
  });
});

describe("a room, drilled in from Rooms", () => {
  it("lists General, Instructions and memory, Appearance, Your view, each with its fields; the lobby has no Appearance", async () => {
    const view = await mount({
      initialTarget: { kind: "room", roomId: ROOM.id },
    });
    const seen: Record<string, unknown> = {
      item: item(view),
      parts: parts(view),
      current: current(view),
      back: backRow(view) !== null,
      cwdInGeneral:
        body(view, "general")?.querySelector('[data-room-setting="cwd"]') !==
        null,
    };
    await openPart(view, "instructions");
    seen.promptInInstructions = textarea(body(view, "instructions")) !== null;
    await openPart(view, "appearance");
    seen.decorInAppearance =
      body(view, "appearance")?.querySelector("[data-room-decor]") !== null;
    await openPart(view, "view");
    seen.levelInView =
      body(view, "view")?.querySelector(
        '[role="radiogroup"][data-view-level]',
      ) !== null;
    expect(seen).toEqual({
      item: "room:r1",
      parts: ["general", "instructions", "appearance", "view"],
      current: ["general"],
      back: true,
      cwdInGeneral: true,
      promptInInstructions: true,
      decorInAppearance: true,
      levelInView: true,
    });
    view.unmount();

    const lobby = await mount({
      initialTarget: { kind: "room", roomId: LOBBY_ROOM_ID },
    });
    expect(parts(lobby)).toEqual(["general", "instructions"]);
    lobby.unmount();
  });

  it("a refused folder, saved from Appearance, opens General; the edit's dot stays", async () => {
    setRefuse({
      route: `PATCH /api/rooms/${ROOM.id}`,
      error: new ApiError(422, "invalid_request", "fixture: bad folder"),
    });
    const view = await mount({
      initialTarget: { kind: "room", roomId: ROOM.id },
    });
    await type(
      body(view, "general")?.querySelector('[data-room-setting="cwd"]') ?? null,
      "/nowhere",
    );
    await openPart(view, "appearance");
    expect(dirty(view)).toEqual(["general"]);
    await save(view);
    expect({ current: current(view), dirty: dirty(view) }).toEqual({
      current: ["general"],
      dirty: ["general"],
    });
    view.unmount();
  });
});

describe("on a phone", () => {
  it("Settings list > the member's parts > a part, and back up the same way", async () => {
    const view = await mount(
      { initialTarget: { kind: "user", id: STEPHEN.id, part: null } },
      { isMobile: true },
    );
    expect({
      item: item(view),
      parts: parts(view).length,
      bodies: bodies(view),
      back: backRow(view) !== null,
    }).toEqual({ item: "user:u2", parts: 7, bodies: [], back: true });
    await click(partRow(view, "osUser"));
    expect({
      parts: parts(view).length,
      bodies: bodies(view),
      phoneBack: phoneBack(view) !== null,
    }).toEqual({ parts: 0, bodies: ["osUser"], phoneBack: true });
    await click(phoneBack(view));
    expect({ parts: parts(view).length, bodies: bodies(view) }).toEqual({
      parts: 7,
      bodies: [],
    });
    await click(backRow(view));
    expect({
      item: item(view),
      officeRow: listRow(view, en["settings.sidebar.office"]) !== null,
    }).toEqual({ item: null, officeRow: true });
    view.unmount();
  });
});
