// Voice and Pager for another member (task 7a3b4114, Nil 2026-11-01: "make
// owners able to set Integrations for other users, including the voice
// selector"), and the member's own "changed for you" list.
//
// Pins: the two tabs show the member card with the picker and no office card;
// a picked member's tab reads and writes that member's route, never the
// owner's own; their Pager shows no push devices (those stay the member's
// own); the viewer's own card lists the changes others made for them, each on
// its own tab, and another member's card does not.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake } =
  await import("../test-support/integrations-fake.ts");
const { MEMBER, card, click, open, pick, selectedTab, tab, type } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
    "Lena",
  ]).install();
});

type View = Awaited<ReturnType<typeof open>>;
const personal = (view: View) => card(view, "personal");
const officeCard = (view: View) =>
  view.container.querySelector('[data-integrations-card="office"]');

const radio = (c: HTMLElement, name: string, value: string) => {
  const el = c.querySelector(
    `input[type="radio"][name="${name}"][value="${value}"]`,
  );
  if (!(el instanceof HTMLInputElement)) throw new Error(`no ${name}=${value}`);
  return el;
};

describe("Voice and Pager for a member", () => {
  it("show the member card with the picker, and no office card", async () => {
    const view = await open();
    for (const id of ["voice", "pager"]) {
      await tab(view, id);
      expect(officeCard(view), id).toBeNull();
      expect(
        personal(view).querySelector("[data-integrations-picker]"),
        id,
      ).not.toBeNull();
    }
  });

  it("Voice reads and saves the picked member's choices, not the owner's", async () => {
    fake.voices.set("stephen", {
      voiceOutput: "openai",
      voiceName: "cedar",
      keySource: "member_variable",
      keyName: "OPENAI_VOICE_API_KEY",
    });
    const view = await open();
    await tab(view, "voice");
    await pick(view, "Stephen");
    const theirs = personal(view);
    expect(theirs.getAttribute("data-integrations-member")).toBe("Stephen");
    expect(fake.requests("GET", "/api/users/Stephen/voice")).toHaveLength(1);
    // Stephen's saved choices, while the owner's own record has none.
    expect(radio(theirs, "voiceOutput", "openai").checked).toBe(true);
    expect(radio(theirs, "voiceInput", "browser").checked).toBe(true);
    expect(
      theirs.querySelector<HTMLSelectElement>('select[name="voiceName"]')!
        .value,
    ).toBe("cedar");
    expect(
      theirs
        .querySelector("[data-key-source]")!
        .getAttribute("data-key-source"),
    ).toBe("member_variable");

    await act(async () => {
      fireEvent.click(radio(theirs, "voiceInput", "openai"));
    });
    await act(async () => {
      fireEvent.change(theirs.querySelector('select[name="voiceName"]')!, {
        target: { value: "ash" },
      });
    });
    expect(
      fake.requests("PATCH", "/api/users/Stephen/voice").map((c) => c.body),
    ).toEqual([{ voiceInput: "openai" }, { voiceName: "ash" }]);
    expect(fake.requests("PATCH", "/api/me/preferences")).toHaveLength(0);
    expect(fake.requests("PATCH", "/api/users/Ricky/voice")).toHaveLength(0);
    expect(radio(personal(view), "voiceInput", "openai").checked).toBe(true);
  });

  it("Voice's Variables link opens the same member's Variables", async () => {
    const view = await open();
    await tab(view, "voice");
    await pick(view, "Stephen");
    await click(personal(view).querySelector("[data-key-source] a"));
    expect(selectedTab(view)).toBe("variables");
    expect(personal(view).getAttribute("data-integrations-member")).toBe(
      "Stephen",
    );
  });

  it("Pager reads and saves the picked member's settings, and shows none of their push devices", async () => {
    const view = await open();
    await tab(view, "pager");
    await pick(view, "Stephen");
    expect(
      fake.requests("GET", "/api/users/Stephen/pager-settings"),
    ).toHaveLength(1);
    const theirs = personal(view);
    await type(
      theirs.querySelector('[data-testid="pager-user-id"]'),
      "112233445566778899",
    );
    await click(theirs.querySelector('[data-testid="pager-save"]'));
    expect(
      fake
        .requests("PATCH", "/api/users/Stephen/pager-settings")
        .map((c) => c.body),
    ).toEqual([{ discordUserId: "112233445566778899" }]);
    expect(
      fake.requests("PATCH", "/api/users/Ricky/pager-settings"),
    ).toHaveLength(0);
    expect(fake.requests("GET", /\/api\/users\/Stephen\/push-devices/)).toEqual(
      [],
    );
  });

  it("the owner's own Pager keeps their push devices", async () => {
    const view = await open();
    await tab(view, "pager");
    expect(
      fake.requests("GET", "/api/users/Ricky/pager-settings"),
    ).toHaveLength(1);
    expect(
      fake.requests("GET", "/api/users/Ricky/push-devices"),
    ).not.toHaveLength(0);
  });
});

describe("changed for you", () => {
  const hoursAgo = (h: number) => Date.now() - h * 60 * 60 * 1000;
  const changes = () => [
    {
      time: hoursAgo(1),
      by: "Ricky",
      kind: "variable",
      action: "set",
      name: "OPENAI_VOICE_API_KEY",
    },
    {
      time: hoursAgo(2),
      by: "Ricky",
      kind: "secret",
      action: "removed",
      name: "GH_TOKEN",
    },
    { time: hoursAgo(3), by: "Ricky", kind: "voice", action: "set" },
  ];
  const listed = (view: View) =>
    [...personal(view).querySelectorAll("[data-integration-change]")].map(
      (el) => el.textContent ?? "",
    );

  it("the member's own card lists each change on its tab, with who made it", async () => {
    fake = new IntegrationsFake({ username: "Stephen", owner: false }, [
      "Ricky",
      "Stephen",
    ]).install();
    fake.changes = changes();
    const view = await open(MEMBER);
    await tab(view, "variables");
    const vars = listed(view);
    expect(vars).toHaveLength(1);
    expect(vars[0]).toContain("OPENAI_VOICE_API_KEY");
    expect(vars[0]).toContain("Ricky");
    await tab(view, "secrets");
    const secrets = listed(view);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toContain("GH_TOKEN");
    await tab(view, "voice");
    expect(listed(view)).toHaveLength(1);
    await tab(view, "mcp");
    expect(listed(view)).toHaveLength(0);
  });

  // The list is the viewer's own: an owner looking at a member's card does
  // not see it there.
  it("is on the viewer's own card only", async () => {
    fake.changes = [
      {
        time: hoursAgo(1),
        by: "Lena",
        kind: "variable",
        action: "set",
        name: "LENA_SET_THIS",
      },
    ];
    const view = await open();
    await tab(view, "variables");
    expect(listed(view)).toHaveLength(1);
    await pick(view, "Stephen");
    expect(listed(view)).toHaveLength(0);
    expect(view.container.textContent).not.toContain("LENA_SET_THIS");
  });
});
