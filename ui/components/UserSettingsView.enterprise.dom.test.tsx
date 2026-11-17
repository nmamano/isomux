// Nil at sign-off (tasks f1304a60 and ce8878c8): the Enterprise Contract box
// has its own row, Enterprise, in the Office group of the Settings sidebar,
// owners only, and no group of its own. The UI has no Hosted flag, so the row
// shows when the setting says it is available, and when the setting cannot be
// read (the section offers a retry).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type { EnterpriseViewRes } from "../../shared/contract-shapes.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { UserSettingsView } = await import("./UserSettingsView.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

const { t } = translatorFor("en");

// The answer to GET /api/office/enterprise; null rejects it, "pending" never
// answers. Anything else unlisted rejects too, which every pane that loads
// here catches.
let enterprise:
  (Partial<EnterpriseViewRes> & { available: boolean }) | "pending" | null =
  null;
setApiShim(async (method, path) => {
  if (path === "/api/office/enterprise") {
    const answer = enterprise;
    if (answer === "pending") return new Promise(() => {});
    if (answer === null) throw new Error("the setting cannot be read");
    return {
      enabled: false,
      locked: false,
      connected: null,
      problem: null,
      ...answer,
    };
  }
  if (path === "/api/removed-members") return { members: [] };
  if (path === "/api/office/settings")
    return { name: "", prompt: "", version: "1" };
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  enterprise = null;
});

type View = ReturnType<typeof render>;

async function mount(
  props: Record<string, unknown> = {},
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
        hasReceivedInitialState: true,
        users: new Map([["tester", self]]),
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

// The sidebar button that reads `label`, or null.
function row(view: View, label: string): HTMLElement | null {
  return (
    view
      .queryAllByText(label)
      .filter((el) => !el.closest('[aria-hidden="true"]'))
      .map((el) => el.closest("button"))
      .find((el): el is HTMLButtonElement => el !== null) ?? null
  );
}

const before = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// Every element whose whole text is the Enterprise label, outside hidden
// copies: the row, and the pane header once the row is open.
const enterpriseTexts = (view: View) =>
  view
    .queryAllByText(t("settings.sidebar.enterprise"))
    .filter((el) => !el.closest('[aria-hidden="true"]'));
const enterpriseRow = (view: View) =>
  row(view, t("settings.sidebar.enterprise"));
const enterpriseBox = (view: View) =>
  view.queryByLabelText(t("settings.office.enterprise.label"));

describe("the Enterprise row", () => {
  it("sits in the Office group for an owner, with no group of its own, and opens the Enterprise Contract box", async () => {
    enterprise = { available: true };
    const view = await mount();
    const r = enterpriseRow(view);
    expect(r).not.toBeNull();
    // Between two Office rows, so no group header comes before it.
    expect(before(row(view, t("settings.sidebar.invites"))!, r!)).toBe(true);
    expect(before(r!, row(view, t("settings.sidebar.updates"))!)).toBe(true);
    // The row is the only Enterprise text: no group header names it.
    const texts = enterpriseTexts(view);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.closest("button") === r).toBe(true);

    expect(enterpriseBox(view)).toBeNull();
    await act(async () => {
      fireEvent.click(r!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(r!.getAttribute("aria-current")).toBe("true");
    expect(enterpriseBox(view)).not.toBeNull();
    // The pane's header is the row's label, as for every other pane.
    expect(
      enterpriseTexts(view).filter((el) => el.closest("button") === null),
    ).toHaveLength(1);
  });

  it("is gone from the Office pane", async () => {
    enterprise = { available: true };
    const view = await mount({
      initialTarget: { kind: "section", section: "office" },
    });
    expect(
      row(view, t("settings.sidebar.office"))!.getAttribute("aria-current"),
    ).toBe("true");
    expect(enterpriseBox(view)).toBeNull();
  });

  it("shows when the setting cannot be read", async () => {
    const view = await mount();
    expect(enterpriseRow(view)).not.toBeNull();
  });

  it("does not show where the setting is not available (Hosted) or for a member", async () => {
    enterprise = { available: false };
    const hosted = await mount();
    // The sidebar drew: the Office group is there.
    expect(row(hosted, t("settings.sidebar.updates"))).not.toBeNull();
    expect(enterpriseTexts(hosted)).toHaveLength(0);
    hosted.unmount();

    enterprise = { available: true };
    const member = await mount({}, "member");
    expect(row(member, t("settings.sidebar.usage"))).not.toBeNull();
    expect(enterpriseTexts(member)).toHaveLength(0);
  });
});

// The UI rule that a view keeps its layout while it loads (task 3755fad4):
// the row must not be inserted, and every row under it pushed down, when the
// setting answers. The device remembers the last answer; before the first
// one, an office has the box (only Hosted does not).
describe("the Enterprise row before the setting answers", () => {
  it("shows on a device that never read the setting", async () => {
    enterprise = "pending";
    const view = await mount();
    expect(row(view, t("settings.sidebar.updates"))).not.toBeNull();
    expect(enterpriseRow(view)).not.toBeNull();
  });

  it("stays away on a device that last read a Hosted answer", async () => {
    enterprise = { available: false };
    const first = await mount();
    expect(enterpriseRow(first)).toBeNull();
    first.unmount();

    enterprise = "pending";
    const again = await mount();
    expect(row(again, t("settings.sidebar.updates"))).not.toBeNull();
    expect(enterpriseRow(again)).toBeNull();
  });

  it("keeps the last answer when a read fails", async () => {
    enterprise = { available: false };
    (await mount()).unmount();

    // A failed read shows the row, for the retry, but is no answer.
    enterprise = null;
    const failed = await mount();
    expect(enterpriseRow(failed)).not.toBeNull();
    failed.unmount();

    enterprise = "pending";
    const again = await mount();
    expect(row(again, t("settings.sidebar.updates"))).not.toBeNull();
    expect(enterpriseRow(again)).toBeNull();
  });

  it("the sidebar's read is enough for the pane to hold its form", async () => {
    // Settings opens on another pane: only the sidebar reads the setting.
    enterprise = { available: true, enabled: true, locked: true };
    const first = await mount();
    expect(enterpriseBox(first)).toBeNull();
    first.unmount();

    enterprise = "pending";
    const view = await mount({
      initialTarget: { kind: "section", section: "enterprise" },
    });
    const box = enterpriseBox(view) as HTMLInputElement | null;
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(true);
    expect(box!.disabled).toBe(true);
    const secret = view.container.ownerDocument.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(secret).not.toBeNull();
    expect(secret!.disabled).toBe(true);
  });
});
