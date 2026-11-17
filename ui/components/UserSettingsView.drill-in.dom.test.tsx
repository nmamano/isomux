// Settings drill-in for members (task 1f79f2e3; Nil, 2026-11-17: "Drill-in:
// a room, member or agent lists its parts in the sidebar"). Selecting another
// member replaces the Settings list column with that member's parts under a
// back row; the pane shows one part. The member is one form: an edit stays
// across parts, a part that holds an unsaved edit shows a dot, the one Save
// writes every part, and a refused save opens the part of the refused field.
// Leaving the member with an edit asks first. Yourself, rooms and the phone
// are in UserSettingsView.drill-in-self-room.dom.test.tsx; the agent in
// AgentSettingsPage.dom.test.tsx; the part lists in ui/settings-parts.test.ts;
// the setup and the DOM contract in ui/test-support/drill-in-fixture.tsx.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { ApiError, setApiShim } = await import("../api.ts");
const { en } = await import("../../shared/i18n/en.ts");
const {
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
  parts,
  resetDrillIn,
  save,
  setRefuse,
  textarea,
  type,
  writes,
} = await import("../test-support/drill-in-fixture.tsx");

beforeEach(resetDrillIn);
afterAll(() => setApiShim(null));

describe("a member, drilled in from Members", () => {
  it("replaces the list column with the member's parts under a back row, shows one part, and the back row returns to the Settings list", async () => {
    const view = await mount({ initialUserId: STEPHEN.id });
    expect({
      item: item(view),
      parts: parts(view),
      current: current(view),
      bodies: bodies(view),
      back: backRow(view) !== null,
      // The full list is gone while the member shows.
      officeRow: listRow(view, en["settings.sidebar.office"]) !== null,
    }).toEqual({
      item: "user:u2",
      parts: [
        "profile",
        "access",
        "osUser",
        "signIn",
        "rooms",
        "instructions",
        "chat",
      ],
      current: ["profile"],
      bodies: ["profile"],
      back: true,
      officeRow: false,
    });
    await click(backRow(view));
    expect({
      item: item(view),
      parts: parts(view).length,
      officeRow: listRow(view, en["settings.sidebar.office"]) !== null,
    }).toEqual({ item: null, parts: 0, officeRow: true });
    view.unmount();
  });

  it("puts each section in its part", async () => {
    const view = await mount({ initialUserId: STEPHEN.id });
    const seen: Record<string, boolean> = {};
    seen.nameInProfile = inputWith(body(view, "profile"), "Stephen") !== null;
    await openPart(view, "access");
    seen.accessInAccess =
      body(view, "access")?.querySelector("[data-member-access]") !== null;
    await openPart(view, "osUser");
    seen.osUserInOsUser =
      body(view, "osUser")?.querySelector('[data-testid="member-os-user"]') !==
      null;
    await openPart(view, "signIn");
    seen.tokensInSignIn =
      body(view, "signIn")?.textContent?.includes(
        en["settings.memberApiTokens.title"],
      ) === true;
    await openPart(view, "rooms");
    seen.pinsInRooms =
      body(view, "rooms")?.querySelector("[data-member-pins]") !== null;
    await openPart(view, "instructions");
    seen.promptInInstructions = textarea(body(view, "instructions")) !== null;
    await openPart(view, "chat");
    seen.choicesInChat =
      (body(view, "chat")?.querySelectorAll('input[type="checkbox"]').length ??
        0) === 2;
    expect(seen).toEqual({
      nameInProfile: true,
      accessInAccess: true,
      osUserInOsUser: true,
      tokensInSignIn: true,
      pinsInRooms: true,
      promptInInstructions: true,
      choicesInChat: true,
    });
    view.unmount();
  });

  it("keeps edits across parts and dots only their parts; the one Save, from a third part, writes both and clears the dots", async () => {
    const view = await mount({ initialUserId: STEPHEN.id });
    expect(dirty(view)).toEqual([]);
    await type(inputWith(body(view, "profile"), "Stephen"), "Steve");
    await openPart(view, "instructions");
    await type(textarea(body(view, "instructions")), "Be brief.");
    await openPart(view, "rooms");
    expect(dirty(view)).toEqual(["profile", "instructions"]);
    await openPart(view, "profile");
    expect(inputWith(body(view, "profile"), "Steve")).not.toBeNull();
    await openPart(view, "chat");
    await save(view);
    expect(
      writes()
        .map((c) => `${c.method} ${c.path}`)
        .sort(),
    ).toEqual([
      "PATCH /api/users/Stephen",
      "PUT /api/users/Stephen/instructions",
    ]);
    expect({
      rename: (
        writes().find((c) => c.method === "PATCH")?.body as {
          name?: string;
        }
      )?.name,
      item: item(view),
      current: current(view),
    }).toEqual({ rename: "Steve", item: "user:u2", current: ["chat"] });
    view.unmount();
  });

  it("an unsaved edit: the back row asks first, Cancel keeps the member, Discard goes to the Settings list", async () => {
    const view = await mount({ initialUserId: STEPHEN.id });
    await type(inputWith(body(view, "profile"), "Stephen"), "Steve");
    await openPart(view, "rooms");
    await click(backRow(view));
    const box = discardPrompt(view);
    expect({ prompt: box !== null, item: item(view) }).toEqual({
      prompt: true,
      item: "user:u2",
    });
    // The prompt's buttons: Discard first, then Cancel.
    await click(box!.querySelectorAll("button")[1]!);
    expect({ prompt: discardPrompt(view) !== null, item: item(view) }).toEqual({
      prompt: false,
      item: "user:u2",
    });
    await click(backRow(view));
    await click(discardPrompt(view)!.querySelector("button"));
    expect({
      item: item(view),
      officeRow: listRow(view, en["settings.sidebar.office"]) !== null,
    }).toEqual({ item: null, officeRow: true });
    view.unmount();
  });

  it("a taken name, saved from Instructions and memory, opens Profile; a stale instructions version, saved from Profile, opens Instructions and memory", async () => {
    setRefuse({
      route: "PATCH /api/users/Stephen",
      error: new ApiError(409, "name_taken", "fixture: taken"),
    });
    const view = await mount({ initialUserId: STEPHEN.id });
    await type(inputWith(body(view, "profile"), "Stephen"), "Tester");
    await openPart(view, "instructions");
    await save(view);
    expect({ item: item(view), current: current(view) }).toEqual({
      item: "user:u2",
      current: ["profile"],
    });
    view.unmount();

    setRefuse({
      route: "PUT /api/users/Stephen/instructions",
      error: new ApiError(409, "version_conflict", "fixture: stale"),
    });
    const second = await mount({ initialUserId: STEPHEN.id });
    await openPart(second, "instructions");
    await type(textarea(body(second, "instructions")), "Be brief.");
    await openPart(second, "profile");
    await save(second);
    expect(current(second)).toEqual(["instructions"]);
    second.unmount();
  });

  it("an owner who drafts the member as an owner loses the OS user part until the draft goes", async () => {
    const view = await mount({ initialUserId: STEPHEN.id });
    await openPart(view, "access");
    await click(
      body(view, "access")?.querySelector(
        'button[role="radio"][data-member-level="owner"]',
      ) ?? null,
    );
    expect(parts(view)).not.toContain("osUser");
    expect(dirty(view)).toEqual(["access"]);
    view.unmount();
  });
});

describe("New member", () => {
  it("drills in with the parts a member being created has, and Create keeps the part it was pressed on", async () => {
    const view = await mount({ initialTarget: { kind: "newMember" } });
    expect({ item: item(view), parts: parts(view) }).toEqual({
      item: "newMember",
      parts: ["profile", "access", "rooms", "instructions", "chat"],
    });
    await type(
      body(view, "profile")?.querySelector("input") ?? null,
      "Newcomer",
    );
    await openPart(view, "instructions");
    await save(view);
    // The create answers with an id on the roster (Stephen's).
    expect(item(view)).toBe("user:u2");
    expect(current(view)).toEqual(["instructions"]);
    view.unmount();
  });
});
