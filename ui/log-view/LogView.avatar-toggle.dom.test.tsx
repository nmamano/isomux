// Task 7b13ace6: the chat bar has one avatar control. The agent icon shows or
// hides the agent's avatar (it used to open the agent settings, and an eye
// button toggled the avatar); the settings open from a click on the shown
// avatar. The bar and the narrow layout's "..." menu share the same entries.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { AgentIcon } = await import("../components/NavIcons.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { setApiShim } = await import("../api.ts");

type AgentInfo = import("../../shared/types.ts").AgentInfo;
const EN = translatorFor("en");
const AVATAR_KEY = "isomux-show-avatar";

const agent = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  queue: [],
  pendingPrompt: null,
  contextUsage: null,
  capabilities: { edit: true },
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));
afterEach(() => localStorage.removeItem(AVATAR_KEY));

// The markup of the agent icon, to recognise it inside a bar entry.
function agentIconSvg(): string {
  const view = render(createElement("span", null, AgentIcon));
  const svg = view.container.querySelector("svg")!.outerHTML;
  view.unmount();
  return svg;
}

function mount(narrow: boolean, edits: { count: number }) {
  return render(
    onLanguage(
      null,
      createElement(LogView, {
        agent,
        logs: [],
        onBack() {},
        onEditAgent() {
          edits.count += 1;
        },
      }),
      { isMobile: narrow, hasReceivedInitialState: true, connected: true },
    ),
  );
}

// The bar's entries: the buttons in the header on a wide layout, the items of
// the "..." menu (a portal) on a narrow one.
async function entries(narrow: boolean): Promise<HTMLButtonElement[]> {
  if (!narrow)
    return [
      ...document.querySelectorAll<HTMLButtonElement>(
        "button[data-nav-action]",
      ),
    ];
  const more = document.querySelector<HTMLButtonElement>(
    `button[title="${EN.t("common.moreActions")}"]`,
  );
  expect(more === null).toBe(false);
  const before = new Set(document.querySelectorAll("button"));
  await act(async () => {
    fireEvent.click(more!);
  });
  const opened = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter((b) => !before.has(b))
    .filter((b) => b.querySelector("svg") !== null);
  // The condition the narrow case needs: the menu opened.
  expect(opened.length > 0).toBe(true);
  return opened;
}

function carriesAgentIcon(b: HTMLButtonElement): boolean {
  return b.querySelector("svg")?.outerHTML === agentIconSvg();
}

// The floating avatar: the box that holds the agent's character. The agent's
// name in the header has the same tooltip, but it is a span.
function avatars(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `div[title="${EN.t("logView.editAgent")}"]`,
    ),
  ].filter((el) => el.querySelector("svg") !== null);
}

async function avatarControl(narrow: boolean): Promise<HTMLButtonElement> {
  const withIcon = (await entries(narrow)).filter(carriesAgentIcon);
  expect(withIcon.length).toBe(1);
  return withIcon[0]!;
}

describe.each([
  ["wide", false],
  ["narrow", true],
])("chat bar avatar control (%s)", (_name, narrow) => {
  it("the agent icon is the one avatar control: it shows and hides the avatar and never opens the agent settings", async () => {
    const edits = { count: 0 };
    mount(narrow, edits);
    // Shown by default.
    expect(avatars().length).toBe(1);

    // One entry carries the agent icon, and it is the avatar toggle: no
    // other entry (the old eye button) toggles the avatar.
    const list = await entries(narrow);
    const withIcon = list.filter(carriesAgentIcon);
    const toggles = list.filter(
      (b) => b.title === EN.t("logView.nav.avatarTitle"),
    );
    expect(withIcon.length).toBe(1);
    expect(toggles.length).toBe(1);
    expect(withIcon[0] === toggles[0]).toBe(true);

    let control = withIcon[0]!;
    await act(async () => {
      fireEvent.click(control);
    });
    expect(avatars().length).toBe(0);
    expect(localStorage.getItem(AVATAR_KEY)).toBe("false");
    expect(edits.count).toBe(0);

    control = await avatarControl(narrow);
    await act(async () => {
      fireEvent.click(control);
    });
    expect(avatars().length).toBe(1);
    expect(localStorage.getItem(AVATAR_KEY)).toBe("true");
    expect(edits.count).toBe(0);
  });

  it("a click on the shown avatar opens the agent settings", async () => {
    const edits = { count: 0 };
    mount(narrow, edits);
    const shown = avatars();
    expect(shown.length).toBe(1);
    await act(async () => {
      fireEvent.click(shown[0]!);
    });
    expect(edits.count).toBe(1);
  });
});
