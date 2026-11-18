// The member picker (Nil, 2026-10-13: "it seems easy to forget that you're
// looking at someone else's and mess it up"): it starts on You, another
// member's card says whose it is, an answer for the member left behind never
// shows under the next one, and every form names the member (in
// ui/integrations/IntegrationsView.picker-forms.dom.test.tsx).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, secret } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { card, open, pick, tab } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
    "Lena",
  ]).install();
});

const personal = (view: Awaited<ReturnType<typeof open>>) =>
  card(view, "personal");

describe("the member picker", () => {
  it("starts on You, and another member's card names them, turns orange and offers the way back", async () => {
    const view = await open();
    const card = personal(view);
    const picker = card.querySelector<HTMLSelectElement>(
      "[data-integrations-picker]",
    )!;
    expect(picker.value).toBe("");
    expect(card.getAttribute("data-integrations-member")).toBeNull();
    expect(card.querySelector("[data-back-to-yours]")).toBeNull();
    // Every other member, never the owner twice.
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      t("common.you"),
      "Lena",
      "Stephen",
    ]);

    await pick(view, "Stephen");
    const other = personal(view);
    expect(other.getAttribute("data-integrations-member")).toBe("Stephen");
    expect(other.querySelector("[data-card-title]")!.textContent).toContain(
      t("integrations.memberTitle", { member: "Stephen" }),
    );
    expect(other.getAttribute("style")).toContain("var(--orange-border)");
    expect(other.textContent).toContain(
      t("integrations.personalWhoMember", { member: "Stephen" }),
    );

    await act(async () => {
      fireEvent.click(other.querySelector("[data-back-to-yours]")!);
    });
    expect(personal(view).getAttribute("data-integrations-member")).toBeNull();
    expect(
      personal(view).querySelector<HTMLSelectElement>(
        "[data-integrations-picker]",
      )!.value,
    ).toBe("");
  });

  it("keeps the member across tabs, and a new page starts on You", async () => {
    const view = await open();
    await pick(view, "Stephen");
    for (const id of [
      "mcp",
      "secrets",
      "variables",
      "providers",
      "voice",
      "pager",
    ]) {
      await tab(view, id);
      const theirs = personal(view);
      expect(theirs.getAttribute("data-integrations-member"), id).toBe(
        "Stephen",
      );
      expect(theirs.querySelector("[data-back-to-yours]"), id).not.toBeNull();
    }
    view.unmount();
    const again = await open();
    expect(personal(again).getAttribute("data-integrations-member")).toBeNull();
  });

  it("never shows an answer for the member left behind under the next one", async () => {
    fake.scope("Stephen").secrets.push(secret("STEPHEN_ONLY"));
    fake.scope("Lena").secrets.push(secret("LENA_ONLY"));
    const view = await open();
    await tab(view, "secrets");
    const release = fake.hold("/api/users/Stephen/secrets");
    await pick(view, "Stephen");
    expect(fake.requests("GET", "/api/users/Stephen/secrets")).toHaveLength(1);
    await pick(view, "Lena");
    await act(async () => {
      release();
    });
    const card = personal(view);
    expect(card.getAttribute("data-integrations-member")).toBe("Lena");
    expect(card.querySelector('[data-secret-name="LENA_ONLY"]')).not.toBeNull();
    expect(card.querySelector('[data-secret-name="STEPHEN_ONLY"]')).toBeNull();
    expect(view.container.textContent).not.toContain("STEPHEN_ONLY");
  });

  it("drops a revealed value and an open form when the picker moves", async () => {
    fake.scope("Ricky").secrets.push(secret("MINE", { value: "my-own-value" }));
    fake.scope("Stephen").secrets.push(secret("MINE"));
    const view = await open();
    await tab(view, "secrets");
    const card = personal(view);
    await act(async () => {
      fireEvent.click(card.querySelector("[data-secret-show]")!);
    });
    expect(card.textContent).toContain("my-own-value");
    await act(async () => {
      fireEvent.click(card.querySelector("[data-integrations-add]")!);
    });
    expect(card.querySelector("[data-secret-add]")).not.toBeNull();

    await pick(view, "Stephen");
    expect(view.container.textContent).not.toContain("my-own-value");
    expect(personal(view).querySelector("[data-secret-add]")).toBeNull();
    // Back on You, the value is masked again until Show.
    await pick(view, "");
    expect(view.container.textContent).not.toContain("my-own-value");
  });
});
