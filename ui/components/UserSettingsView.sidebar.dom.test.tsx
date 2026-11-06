// The Settings sidebar regrouped (task db800fd8): Sessions, Audit log, Usage
// and Storage leave the Office group for a group after Members; Pager and API
// tokens left for Integrations; Rooms and Members start collapsed. A header
// click opens or closes its group and is kept on the device; a selection
// inside a closed group opens it for this visit only. The New member row
// shows in both states, so selecting it opens nothing (task 65542daf).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { UserSettingsView } = await import("./UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");

// Anything unlisted rejects, which every pane that loads here catches.
// The GETs of the removed-members list (task 321e7b8e).
const removedSeeds: string[] = [];
// Every DELETE, in order (Sign out, task c6589760).
const deletes: string[] = [];
setApiShim(async (method, path) => {
  if (method === "DELETE") {
    deletes.push(path);
    return undefined;
  }
  if (path === "/api/removed-members") {
    removedSeeds.push(method);
    return { members: [] };
  }
  // A create answers with an id already on the roster: the broadcast that
  // adds a new record is not part of this fixture.
  if (method === "POST" && path === "/api/users")
    return { user: { id: MEMBER.id } };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/office/settings")
    return { name: "", prompt: "", version: "1" };
  if (path.startsWith("/api/rooms/") && path.endsWith("/settings"))
    return { prompt: "", version: "1" };
  if (path.endsWith("/instructions")) return { instructions: "", version: "1" };
  throw new Error(`no shim for ${path}`);
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  removedSeeds.length = 0;
  deletes.length = 0;
});

type View = ReturnType<typeof render>;
type Props = Record<string, unknown>;

const ROOM = {
  id: "r1",
  name: "Sala Nord",
  prompt: null,
  canCloseWhenEmpty: true,
};
const MEMBER = {
  ...selfUserRecord(null),
  id: "u2",
  name: "Stephen",
  role: "member" as const,
};

async function mount(
  props: Props = {},
  role: "owner" | "member" = "owner",
  state: Record<string, unknown> = {},
): Promise<View> {
  const self = { ...selfUserRecord(null), role };
  const view = render(
    onLanguage(
      null,
      createElement(UserSettingsView, {
        onSwitchUser: () => {},
        onClose: () => {},
        ...props,
      }),
      {
        rooms: [ROOM],
        hasReceivedInitialState: true,
        users: new Map([
          ["tester", self],
          ["stephen", MEMBER],
        ]),
        ...(role === "member"
          ? {
              sessionContext: {
                userId: "u1",
                username: "Tester",
                role: "member",
                currentSessionPrefix: "00000000",
                connectionId: "c1",
              },
            }
          : {}),
        ...state,
      },
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

/** The sidebar button that reads `label`, or null. Text inside an
 *  aria-hidden subtree (a picker tile's preview) is not a row. */
function row(view: View, label: string): HTMLElement | null {
  return (
    view
      .queryAllByText(label)
      .filter((el) => !el.closest('[aria-hidden="true"]'))
      .map((el) => el.closest("button"))
      .find((el): el is HTMLButtonElement => el !== null) ?? null
  );
}

const toggle = (view: View, group: "rooms" | "members") =>
  view.container.querySelector<HTMLElement>(
    `[data-sidebar-group-toggle="${group}"]`,
  );
const expanded = (view: View, group: "rooms" | "members") =>
  toggle(view, group)?.getAttribute("aria-expanded") ?? null;
// The Rooms group's row and the Members group's row for the other member.
const roomRow = (view: View) => row(view, ROOM.name);
const memberRow = (view: View) => row(view, MEMBER.name);
const newMemberRow = (view: View) => row(view, t("settings.members.newMember"));

async function clickToggle(view: View, group: "rooms" | "members") {
  const el = toggle(view, group);
  if (!el) throw new Error(`no ${group} header to click`);
  await act(async () => {
    fireEvent.click(el);
  });
}

const before = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("the groups", () => {
  it("puts Sessions, Audit log, Usage and Storage in Housekeeping after Members, and keeps Pager and API tokens out", async () => {
    const view = await mount();
    const members = toggle(view, "members")!;
    expect(members).not.toBeNull();
    const housekeeping = view.getByText(t("settings.sidebar.housekeeping"));
    expect(before(members, housekeeping)).toBe(true);
    for (const key of [
      "settings.sidebar.sessions",
      "audit.title",
      "settings.sidebar.usage",
      "settings.sidebar.storage",
    ] as const) {
      const r = row(view, t(key));
      expect(r, key).not.toBeNull();
      expect(before(housekeeping, r!), key).toBe(true);
    }
    for (const key of [
      "settings.sidebar.access",
      "settings.sidebar.invites",
      "settings.sidebar.updates",
    ] as const) {
      const r = row(view, t(key));
      expect(r, key).not.toBeNull();
      expect(before(r!, members), key).toBe(true);
    }
    // The Language row, and no Pager or API tokens row.
    expect(row(view, t("settings.sidebar.language"))).not.toBeNull();
    expect(row(view, t("settings.sidebar.pager"))).toBeNull();
    expect(row(view, t("settings.sidebar.apiTokens"))).toBeNull();
    // The You group still holds Sign-in links.
    expect(row(view, t("settings.sidebar.signInLinks"))).not.toBeNull();
  });

  it("shows a member only Usage in Housekeeping", async () => {
    const view = await mount({}, "member");
    const usage = row(view, t("settings.sidebar.usage"))!;
    expect(usage).not.toBeNull();
    expect(before(toggle(view, "members")!, usage)).toBe(true);
    for (const key of [
      "settings.sidebar.sessions",
      "audit.title",
      "settings.sidebar.storage",
    ] as const)
      expect(row(view, t(key)), key).toBeNull();
  });
});

describe("Rooms and Members", () => {
  it("start collapsed on a new device, even on your own profile", async () => {
    const view = await mount();
    // Desktop opens on your own profile, which is the You > Profile row.
    expect(
      row(view, t("settings.sidebar.profile"))!.getAttribute("aria-current"),
    ).toBe("true");
    expect(expanded(view, "rooms")).toBe("false");
    expect(expanded(view, "members")).toBe("false");
    expect(roomRow(view)).toBeNull();
    expect(memberRow(view)).toBeNull();
  });

  it("open and close from the header, and the device keeps the choice", async () => {
    const first = await mount();
    await clickToggle(first, "rooms");
    expect(expanded(first, "rooms")).toBe("true");
    expect(roomRow(first)).not.toBeNull();
    expect(expanded(first, "members")).toBe("false");
    first.unmount();

    const second = await mount();
    expect(expanded(second, "rooms")).toBe("true");
    expect(roomRow(second)).not.toBeNull();
    expect(memberRow(second)).toBeNull();
    await clickToggle(second, "members");
    expect(memberRow(second)).not.toBeNull();
    await clickToggle(second, "rooms");
    expect(roomRow(second)).toBeNull();
    second.unmount();

    const third = await mount();
    expect(expanded(third, "rooms")).toBe("false");
    expect(roomRow(third)).toBeNull();
    expect(expanded(third, "members")).toBe("true");
    expect(memberRow(third)).not.toBeNull();
  });

  it("open for a room selection, close from the header, and keep nothing", async () => {
    const view = await mount({
      initialTarget: { kind: "room", roomId: ROOM.id },
    });
    expect(expanded(view, "rooms")).toBe("true");
    expect(roomRow(view)!.getAttribute("aria-current")).toBe("true");
    expect(expanded(view, "members")).toBe("false");
    // Never a dead header: the click closes the group the selection opened.
    await clickToggle(view, "rooms");
    expect(expanded(view, "rooms")).toBe("false");
    expect(roomRow(view)).toBeNull();
    view.unmount();

    // The selection opened the group for that visit only.
    const fresh = await mount({
      initialTarget: { kind: "room", roomId: ROOM.id },
    });
    fresh.unmount();
    const plain = await mount();
    expect(expanded(plain, "rooms")).toBe("false");
  });

  it("open Members for another member's editor", async () => {
    const other = await mount({ initialUserId: MEMBER.id });
    expect(expanded(other, "members")).toBe("true");
    expect(memberRow(other)!.getAttribute("aria-current")).toBe("true");
    expect(expanded(other, "rooms")).toBe("false");
  });
});

// Task 65542daf: the New member row does not hide with the roster.
describe("New member", () => {
  it("shows to an owner under the Members header when collapsed, and after the rows when open", async () => {
    const view = await mount();
    const housekeeping = view.getByText(t("settings.sidebar.housekeeping"));
    expect(expanded(view, "members")).toBe("false");
    expect(memberRow(view)).toBeNull();
    const collapsed = newMemberRow(view);
    expect(collapsed).not.toBeNull();
    expect(before(toggle(view, "members")!, collapsed!)).toBe(true);
    expect(before(collapsed!, housekeeping)).toBe(true);

    await clickToggle(view, "members");
    expect(expanded(view, "members")).toBe("true");
    const open = newMemberRow(view);
    expect(open).not.toBeNull();
    // Both roster rows, sorted by name, sit between the header and the row.
    const rows = view
      .queryAllByText(new RegExp(`^(${MEMBER.name}|Tester)$`))
      .filter(
        (el) =>
          before(toggle(view, "members")!, el) && before(el, housekeeping),
      );
    expect(rows.length).toBe(2);
    for (const r of rows) expect(before(r, open!)).toBe(true);
    expect(before(open!, housekeeping)).toBe(true);
  });

  it("never shows to a member, open or collapsed", async () => {
    const view = await mount({}, "member");
    expect(expanded(view, "members")).toBe("false");
    expect(newMemberRow(view)).toBeNull();
    await clickToggle(view, "members");
    // A member's roster rows are not buttons: the open list shows the name.
    expect(expanded(view, "members")).toBe("true");
    expect(view.queryAllByText(MEMBER.name).length).toBeGreaterThan(0);
    expect(newMemberRow(view)).toBeNull();
  });

  it("keeps Members collapsed when selected", async () => {
    const view = await mount({ initialTarget: { kind: "newMember" } });
    expect(expanded(view, "members")).toBe("false");
    expect(memberRow(view)).toBeNull();
    expect(newMemberRow(view)!.getAttribute("aria-current")).toBe("true");
  });

  it("stays in place on a click, and the member it creates opens Members", async () => {
    const view = await mount();
    expect(expanded(view, "members")).toBe("false");
    expect(newMemberRow(view)).not.toBeNull();
    expect(newMemberRow(view)!.getAttribute("aria-current")).toBeNull();
    await act(async () => {
      fireEvent.click(newMemberRow(view)!);
    });
    expect(newMemberRow(view)!.getAttribute("aria-current")).toBe("true");
    expect(expanded(view, "members")).toBe("false");
    expect(memberRow(view)).toBeNull();

    const detail = view.getByTestId("settings-content");
    fireEvent.change(detail.querySelector("input")!, {
      target: { value: "Pia" },
    });
    await act(async () => {
      fireEvent.click(
        within(detail).getByRole("button", {
          name: t("settings.members.create"),
        }),
      );
    });
    // The new member's row is selected and in view.
    expect(expanded(view, "members")).toBe("true");
    expect(memberRow(view)!.getAttribute("aria-current")).toBe("true");
  });
});

// Task 321e7b8e: the Removed members row is an owner's, and only when someone
// is in the list. The list is fetched once for an owner, never for a member.
describe("Removed members (task 321e7b8e)", () => {
  const REMOVED = {
    user: { ...MEMBER, id: "u9", name: "Mia" },
    removedAt: 1_760_000_000_000,
    expiresAt: 1_762_592_000_000,
    removedBy: "Tester",
    heirName: "Tester",
    passed: { agents: 1, schedules: 0, webhooks: 0 },
  };
  const removedRow = (view: View) =>
    view.container.querySelector<HTMLElement>("[data-removed-members-row]");

  it("an owner with someone in the list gets the row, and it opens the list", async () => {
    const view = await mount({}, "owner", {
      removedMembers: [REMOVED],
      removedMembersLoaded: true,
    });
    expect(removedSeeds).toEqual([]);
    await act(async () => {
      fireEvent.click(removedRow(view)!);
    });
    expect(
      view.container.querySelector('[data-removed-member="u9"]'),
    ).not.toBeNull();
  });

  it("an owner with an empty list has no row; the list is fetched once", async () => {
    const view = await mount({}, "owner", { removedMembersLoaded: false });
    expect(removedRow(view)).toBeNull();
    expect(removedSeeds).toEqual(["GET"]);
  });

  // The removal's consequences are shown while Delete waits for its
  // confirm, and not before.
  it("a member's Delete shows the removal note only while it waits to be confirmed", async () => {
    const view = await mount({ initialUserId: MEMBER.id });
    const note = () =>
      view.container.querySelector("[data-delete-member-note]");
    const del = view.container.querySelector<HTMLButtonElement>(
      `button[title="${t("settings.profile.deleteHint")}"]`,
    )!;
    expect(del).not.toBeNull();
    expect(note()).toBeNull();
    await act(async () => {
      fireEvent.click(del);
    });
    expect(note()).not.toBeNull();
    await act(async () => {
      fireEvent.blur(del);
    });
    expect(note()).toBeNull();
  });

  it("a member has no row and fetches nothing", async () => {
    const view = await mount({}, "member", {
      removedMembers: [REMOVED],
      removedMembersLoaded: false,
    });
    expect(removedRow(view)).toBeNull();
    expect(removedSeeds).toEqual([]);
  });
});

// Signing out ends this device's session: it needs a new invite link to come
// back, with no Undo (task c6589760). Sign out asks first.
describe("Sign out", () => {
  it("arms on the first click and sends nothing; the second ends this session once", async () => {
    const view = await mount({}, "member");
    const signOut = row(view, t("common.signOut"));
    expect(signOut).not.toBeNull();
    await act(async () => {
      fireEvent.click(signOut!);
    });
    expect(deletes).toEqual([]);
    expect(signOut!.hasAttribute("data-confirm-armed")).toBe(true);
    await act(async () => {
      fireEvent.click(signOut!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(deletes).toEqual(["/api/sessions/current"]);
    view.unmount();
  });

  // The page leaves on Escape from a window listener; an armed confirm takes
  // Escape to end itself, and the next Escape leaves.
  it("Escape on an armed Sign out ends the confirm and keeps the page", async () => {
    let closes = 0;
    const view = await mount({ onClose: () => closes++ }, "member");
    const signOut = row(view, t("common.signOut"))!;
    await act(async () => {
      fireEvent.click(signOut);
    });
    expect(signOut.hasAttribute("data-confirm-armed")).toBe(true);
    await act(async () => {
      fireEvent.keyDown(signOut, { key: "Escape" });
    });
    expect([signOut.hasAttribute("data-confirm-armed"), closes]).toEqual([
      false,
      0,
    ]);
    await act(async () => {
      fireEvent.keyDown(signOut, { key: "Escape" });
    });
    expect(closes).toBe(1);
    expect(deletes).toEqual([]);
    view.unmount();
  });
});
