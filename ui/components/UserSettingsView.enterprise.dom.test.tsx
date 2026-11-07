// Nil at sign-off (task f1304a60): the Enterprise Contract box leaves the
// Office pane for its own group in the Settings sidebar, right after the
// Office group, owners only. The UI has no Hosted flag, so the group shows
// when the setting says it is available, and when the setting cannot be read
// (the section offers a retry).

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

// The answer to GET /api/office/enterprise; null rejects it. Anything else
// unlisted rejects too, which every pane that loads here catches.
let enterprise: { available: boolean } | null = null;
setApiShim(async (method, path) => {
  if (path === "/api/office/enterprise" && enterprise)
    return {
      ...enterprise,
      enabled: false,
      locked: false,
      connected: null,
      problem: null,
    };
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

const groupHeader = (view: View) =>
  view.queryAllByText(t("settings.sidebar.enterprise"))[0] ?? null;
const contractRow = (view: View) =>
  row(view, t("settings.sidebar.enterpriseContract"));
const enterpriseBox = (view: View) =>
  view.queryByLabelText(t("settings.office.enterprise.label"));

describe("the Enterprise group", () => {
  it("sits right after the Office group for an owner, and its row opens the Enterprise Contract box", async () => {
    enterprise = { available: true };
    const view = await mount();
    const header = groupHeader(view);
    const r = contractRow(view);
    expect(header).not.toBeNull();
    expect(r).not.toBeNull();
    // After the Office group's last row, before the You group's first row.
    expect(before(row(view, t("settings.sidebar.updates"))!, header!)).toBe(
      true,
    );
    expect(before(r!, row(view, t("settings.sidebar.profile"))!)).toBe(true);

    expect(enterpriseBox(view)).toBeNull();
    await act(async () => {
      fireEvent.click(r!);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(r!.getAttribute("aria-current")).toBe("true");
    expect(enterpriseBox(view)).not.toBeNull();
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
    expect(contractRow(view)).not.toBeNull();
  });

  it("does not show where the setting is not available (Hosted) or for a member", async () => {
    enterprise = { available: false };
    const hosted = await mount();
    // The sidebar drew: the Office group is there.
    expect(row(hosted, t("settings.sidebar.updates"))).not.toBeNull();
    expect(groupHeader(hosted)).toBeNull();
    expect(contractRow(hosted)).toBeNull();
    hosted.unmount();

    enterprise = { available: true };
    const member = await mount({}, "member");
    expect(row(member, t("settings.sidebar.usage"))).not.toBeNull();
    expect(groupHeader(member)).toBeNull();
    expect(contractRow(member)).toBeNull();
  });
});
