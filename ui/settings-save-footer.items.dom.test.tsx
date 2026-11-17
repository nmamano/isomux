// One save footer for every Settings part that saves (task f0d50877): the
// parts of a member and a room (an agent's in
// settings-save-footer.agent.dom.test.tsx). A room opened with Save enabled
// before anything changed; a member read Saved on open. Now every part opens
// with Cancel and Save disabled and Save reading Save
// (ui/test-support/save-footer-contract.ts).

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("./api.ts");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const { room } = await import("./test-support/claude-limits-fixture.tsx");
const {
  expectFooterPlacement,
  expectSaveCycle,
  footerState,
  mountSettingsAt,
  OPENED,
  settle,
  shimItemApi,
} = await import("./test-support/save-footer-contract.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");

const { t } = translatorFor("en");
type UserRecord = import("../shared/types.ts").UserRecord;

afterAll(() => setApiShim(null));

const OWNER = { ...selfUserRecord(null), id: "owner", name: "Owner" };
const BRU: UserRecord = {
  ...selfUserRecord(null),
  id: "u2",
  name: "Bru",
  role: "member",
  allowedRooms: [room.id],
};

it("a member's part: opens with nothing to save, and saves, edits and cancels like every part", async () => {
  const writes = shimItemApi();
  const { view, update } = mountSettingsAt(
    { kind: "user", id: BRU.id, part: "chat" },
    { users: [OWNER, BRU], agents: [] },
  );
  await settle();
  const box = () =>
    view.container.querySelector<HTMLInputElement>(
      "input[data-show-tool-calls]",
    )!;
  expectFooterPlacement(view.container);
  await expectSaveCycle({
    root: view.container,
    value: () => box().checked,
    edit: async () => {
      await act(async () => {
        fireEvent.click(box());
      });
    },
    broadcast: () =>
      update({ users: [OWNER, { ...BRU, showToolCalls: true }] }),
  });
  // The cycle saved once: the change it made, to the member.
  expect(writes.map((w) => [w.method, w.path, w.body])).toEqual([
    ["PATCH", "/api/users/Bru/chat", { showToolCalls: true }],
  ]);
  view.unmount();
});

it("New member: Save reads Create, and is off until the form can create", async () => {
  shimItemApi();
  const { view } = mountSettingsAt(
    { kind: "newMember", part: "general" },
    { users: [OWNER], agents: [] },
  );
  await settle();
  expectFooterPlacement(view.container);
  expect(footerState(view.container)).toEqual({
    ...OPENED,
    label: t("settings.members.create"),
  });
  const name = view
    .getByTestId("settings-content")
    .querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    fireEvent.change(name, { target: { value: "Pia" } });
  });
  expect(footerState(view.container)).toEqual({
    save: "enabled",
    cancel: "enabled",
    label: t("settings.members.create"),
  });
  view.unmount();
});

it("a room's part: opens with nothing to save, and saves, edits and cancels like every part", async () => {
  shimItemApi();
  const { view } = mountSettingsAt(
    { kind: "room", roomId: room.id, part: "general" },
    { users: [OWNER], agents: [] },
  );
  await settle();
  const name = () =>
    view
      .getByTestId("settings-content")
      .querySelector<HTMLInputElement>("input")!;
  expect(name().value).toBe(room.name);
  expectFooterPlacement(view.container);
  await expectSaveCycle({
    root: view.container,
    value: () => name().value,
    edit: async (step) => {
      await act(async () => {
        fireEvent.change(name(), { target: { value: `Studio ${step}` } });
      });
    },
  });
  view.unmount();
});
