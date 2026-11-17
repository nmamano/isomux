// Integrations > Model providers > the Claude token for members with their
// own OS user (task 476fe892, Nil's sign-off of b94dfd25). The properties:
// - Remove asks first (AGENTS.md "UI rules": a removed token cannot come
//   back): one click sends nothing and arms the button; a second click sends
//   one DELETE;
// - in every language, the hint shows the setup command as code (the
//   integrations Data element), with no raw backtick or tag in the text.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { MemberTokenCard } = await import("./MemberTokenCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { SUPPORTED_LANGUAGES } = await import("../../shared/languages.ts");
import type { MemberTokenViewRes } from "../../shared/contract-shapes.ts";

const ROUTE = "/api/office/claude-member-token";
const DAY = 24 * 60 * 60 * 1000;

let view: MemberTokenViewRes;
let calls: { method: string; path: string }[] = [];

beforeEach(() => {
  calls = [];
  view = {
    set: true,
    inUse: true,
    madeAt: Date.now() - DAY,
    expiresAt: Date.now() + 300 * DAY,
  };
  setApiShim(async (method, path) => {
    calls.push({ method, path });
    if (path !== ROUTE) throw new Error(`unexpected ${method} ${path}`);
    if (method === "GET") return view;
    if (method === "DELETE") {
      view = { set: false, inUse: true, madeAt: null, expiresAt: null };
      return view;
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});
afterEach(() => cleanup());

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

async function mount(language: (typeof SUPPORTED_LANGUAGES)[number]["code"]) {
  const rendered = render(
    onLanguage(language, createElement(MemberTokenCard, {})),
  );
  await settle();
  const card = rendered.container.querySelector<HTMLElement>(
    "[data-member-token]",
  );
  return { rendered, card };
}

const deletes = () => calls.filter((c) => c.method === "DELETE").length;

it("Remove asks first: one click sends nothing and arms it, a second click sends one DELETE", async () => {
  const { card } = await mount("en");
  expect(card).not.toBeNull();
  // The enabling condition: a token is set, so the row with Remove shows.
  expect(card!.querySelector("[data-member-token-expires]")).not.toBeNull();
  const label = translatorFor("en").t("integrations.memberToken.remove");
  const remove = [...card!.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  expect(remove).toBeDefined();

  await act(async () => {
    fireEvent.click(remove!);
  });
  await settle();
  expect(deletes()).toBe(0);
  expect(remove!.hasAttribute("data-confirm-armed")).toBe(true);
  // The token is still shown as set.
  expect(card!.querySelector("[data-member-token-expires]")).not.toBeNull();

  await act(async () => {
    fireEvent.click(remove!);
  });
  await settle();
  expect(deletes()).toBe(1);
  // The server's answer shows: no token set, so the form shows.
  expect(card!.querySelector("[data-member-token-expires]")).toBeNull();
});

it("shows the setup command as code in the hint, in every language", async () => {
  for (const { code } of SUPPORTED_LANGUAGES) {
    const { card, rendered } = await mount(code);
    expect(card).not.toBeNull();
    // The enabling condition: the card renders in this language.
    expect(card!.querySelector("h3")?.textContent).toBe(
      translatorFor(code).t("integrations.memberToken.title"),
    );
    const data = card!.querySelectorAll("[data-integrations-data]");
    expect(data.length).toBe(1);
    expect(`${code}: ${data[0]!.textContent}`).toBe(
      `${code}: claude setup-token`,
    );
    const text = card!.textContent ?? "";
    expect(`${code}: ${text.includes("`")}`).toBe(`${code}: false`);
    expect(`${code}: ${/<\/?code>/.test(text)}`).toBe(`${code}: false`);
    rendered.unmount();
  }
});
