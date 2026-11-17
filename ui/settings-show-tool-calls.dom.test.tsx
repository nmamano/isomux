// "Show tool calls" (task e7579473) and "Show agent messages" (task
// d5c0f33d): a member turns each on in their own Settings pane, and an
// office owner on a member's page or in the New member form, because the
// member this protects will not go looking for it. Each form sends the
// choice to its route; the routes are pinned in
// server/test-support/routes-member-voice.test.ts and
// preferences-routes.test.ts.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { PreferencesPane } = await import("./components/PreferencesPane.tsx");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { en } = await import("../shared/i18n/en.ts");
const { openPart } = await import("./test-support/settings-item.tsx");
type MemberPart = import("./settings-parts.ts").MemberPart;

const calls: { method: string; path: string; body: unknown }[] = [];
beforeEach(() => {
  calls.length = 0;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (method === "POST" && path === "/api/users")
      return { user: { id: "u9" } };
    if (path.endsWith("/instructions"))
      return { instructions: "", version: "1" };
    return {};
  });
});
afterAll(() => setApiShim(null));

// Each choice: its checkbox and the record key it writes.
const CHOICES = [
  ["input[data-show-tool-calls]", "showToolCalls"],
  ["input[data-show-agent-messages]", "showAgentMessages"],
] as const;
const writes = () => calls.filter((c) => c.method !== "GET");

const self = selfUserRecord("en");
const users = (record = self, ...more: (typeof self)[]) =>
  new Map([record, ...more].map((u) => [u.name.toLowerCase(), u]));

for (const [BOX, key] of CHOICES) {
  const box = (root: ParentNode) => {
    const el = root.querySelector<HTMLInputElement>(BOX);
    if (!el) throw new Error(`no ${key} checkbox`);
    return el;
  };

  it(`${key}, the member's own pane: off by default; ticked and saved, it sends ${key} true; unticked, false`, async () => {
    const pane = (record: typeof self) =>
      onLanguage("en", createElement(PreferencesPane), {
        users: users(record),
      });
    const view = render(pane(self));
    expect(box(view.container).checked).toBe(false);
    await act(async () => {
      fireEvent.click(box(view.container));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: en["common.save"] }));
    });
    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: "/api/me/preferences",
        body: expect.objectContaining({ [key]: true }),
      },
    ]);
    // The saved record comes back over the socket.
    view.rerender(pane({ ...self, [key]: true }));
    expect(box(view.container).checked).toBe(true);
    calls.length = 0;
    await act(async () => {
      fireEvent.click(box(view.container));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: en["common.save"] }));
    });
    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: "/api/me/preferences",
        body: expect.objectContaining({ [key]: false }),
      },
    ]);
    view.unmount();
  });

  const pia = {
    ...selfUserRecord(null),
    id: "u2",
    name: "Pia",
    role: "member" as const,
  };

  // On a member's part (task 1f79f2e3): Chat unless the test names one.
  function settings(
    state: Record<string, unknown>,
    memberId?: string,
    part: MemberPart = "chat",
  ) {
    return onLanguage(
      "en",
      createElement(UserSettingsView, {
        onSwitchUser: () => {},
        onClose: () => {},
        ...(memberId
          ? { initialTarget: { kind: "user" as const, id: memberId, part } }
          : {}),
      }),
      state,
    );
  }

  it(`${key}, an owner on a member's page: the choice saves through the member's chat route, and only when changed`, async () => {
    const view = render(settings({ users: users(self, pia) }, "u2"));
    await act(async () => {});
    const detail = view.getByTestId("settings-content");
    expect(
      view.container
        .querySelector("[data-settings-item]")
        ?.getAttribute("data-settings-item"),
    ).toBe("user:u2");
    expect(box(detail).checked).toBe(false);
    await act(async () => {
      fireEvent.click(box(detail));
    });
    calls.length = 0;
    await act(async () => {
      fireEvent.click(
        within(detail).getByRole("button", { name: en["common.save"] }),
      );
    });
    expect(writes().filter((c) => c.path.endsWith("/chat"))).toEqual([
      {
        method: "PATCH",
        path: "/api/users/Pia/chat",
        body: { [key]: true },
      },
    ]);
    view.unmount();

    // A save that leaves the choice alone does not send it.
    const again = render(
      settings({ users: users(self, pia) }, "u2", "profile"),
    );
    await act(async () => {});
    const page = again.getByTestId("settings-content");
    const name = page.querySelector("input")!;
    fireEvent.change(name, { target: { value: "Pia Two" } });
    calls.length = 0;
    await act(async () => {
      fireEvent.click(
        within(page).getByRole("button", { name: en["common.save"] }),
      );
    });
    expect(writes().length).toBeGreaterThan(0);
    expect(writes().filter((c) => c.path.endsWith("/chat")).length).toBe(0);
    again.unmount();
  });

  it(`${key}, an owner's own page has no checkbox: their own Settings pane holds it`, async () => {
    const view = render(settings({ users: users(self, pia) }, "u1", "profile"));
    await act(async () => {});
    // Your own rows, each part of them: no Chat part and no box.
    const ids = [
      ...view.container.querySelectorAll("button[data-settings-part]"),
    ].map((b) => b.getAttribute("data-settings-part")!);
    expect(ids).toEqual(["profile", "access", "rooms", "instructions"]);
    for (const id of ids) {
      await act(async () => {
        await openPart(view.container, id);
      });
      expect(view.container.querySelectorAll(BOX).length).toBe(0);
    }
    view.unmount();
  });

  it(`${key}, the New member form: ticked, the create body carries ${key} true`, async () => {
    const view = render(settings({ users: users(self) }));
    await act(async () => {});
    const members = view.container.querySelector(
      '[data-sidebar-group-toggle="members"][aria-expanded="false"]',
    );
    if (members) fireEvent.click(members);
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: en["settings.members.newMember"] }),
      );
    });
    const detail = view.getByTestId("settings-content");
    fireEvent.change(detail.querySelector("input")!, {
      target: { value: "Pia" },
    });
    await act(async () => {
      await openPart(view.container, "chat");
    });
    expect(box(detail).checked).toBe(false);
    await act(async () => {
      fireEvent.click(box(detail));
    });
    calls.length = 0;
    await act(async () => {
      fireEvent.click(
        within(detail).getByRole("button", {
          name: en["settings.members.create"],
        }),
      );
    });
    expect(writes().filter((c) => c.path === "/api/users")).toEqual([
      {
        method: "POST",
        path: "/api/users",
        body: expect.objectContaining({ name: "Pia", [key]: true }),
      },
    ]);
    view.unmount();
  });
}
