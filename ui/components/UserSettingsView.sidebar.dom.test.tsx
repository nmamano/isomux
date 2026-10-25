// The Settings sidebar regrouped (task db800fd8): Sessions, Audit log, Usage
// and Storage leave the Office group for a group after Members; Pager and API
// tokens left for Integrations; Rooms and Members start collapsed. A header
// click opens or closes its group and is kept on the device; a selection
// inside a closed group opens it for this visit only.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { UserSettingsView } = await import("./UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");

// Anything unlisted rejects, which every pane that loads here catches.
setApiShim(async (_method, path) => {
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

beforeEach(() => window.localStorage.clear());

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

  it("open Members for another member's editor and for New member", async () => {
    const other = await mount({ initialUserId: MEMBER.id });
    expect(expanded(other, "members")).toBe("true");
    expect(memberRow(other)!.getAttribute("aria-current")).toBe("true");
    expect(expanded(other, "rooms")).toBe("false");
    other.unmount();

    const created = await mount({ initialTarget: { kind: "newMember" } });
    expect(expanded(created, "members")).toBe("true");
    expect(memberRow(created)).not.toBeNull();
  });
});
