// The Integrations Voice tab (task 4481e64b): what the mic and read aloud use,
// saved per member on each change, and where OPENAI_API_KEY comes from. It
// names the source only, never a value.
import { beforeEach, afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { fireEvent, render, act } = await import("@testing-library/react");
const { VoiceSection } = await import("./VoiceSection.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
const { DEFAULT_VOICE_NAME, VOICE_NAMES } =
  await import("../../shared/voice.ts");

type UserRecord = import("../../shared/types.ts").UserRecord;

let keySource: string | null = null;
let keyName: string | null = null;
let patches: unknown[] = [];

beforeEach(() => {
  keySource = null;
  keyName = null;
  patches = [];
  setApiShim(async (method, path, body) => {
    if (method === "GET" && path === "/api/voice")
      return { keySource, keyName };
    if (method === "PATCH" && path === "/api/me/preferences") {
      patches.push(body);
      return undefined;
    }
    return {};
  });
});

afterAll(() => setApiShim(null));

function page(over: Partial<UserRecord> = {}) {
  const self = { ...selfUserRecord(null), ...over };
  return onLanguage(null, createElement(VoiceSection), {
    users: new Map([[self.name.toLowerCase(), self]]),
  });
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const radio = (c: HTMLElement, name: string, value: string) => {
  const el = c.querySelector(
    `input[type="radio"][name="${name}"][value="${value}"]`,
  );
  if (!(el instanceof HTMLInputElement)) throw new Error(`no ${name}=${value}`);
  return el;
};

it("names where the key comes from, for every source, with a Variables link", async () => {
  for (const source of [
    "member_variable",
    "office_variable",
    "server",
    "member_secret",
    "office_secret",
    null,
  ]) {
    keySource = source;
    keyName = source ? "OPENAI_VOICE_API_KEY" : null;
    const view = render(page());
    await settle();
    const line = view.container.querySelector("[data-key-source]");
    expect({ source, shown: line?.getAttribute("data-key-source") }).toEqual({
      source,
      shown: source ?? "none",
    });
    expect(
      view.container.querySelector('a[href="/integrations/variables"]'),
    ).not.toBeNull();
    view.unmount();
  }
});

// The member's three states read differently: set, saved as a secret (the
// mic cannot use it), not set.
it("words a usable key, a secret and no key differently", async () => {
  const textFor = async (source: string | null) => {
    keySource = source;
    keyName = source ? "OPENAI_VOICE_API_KEY" : null;
    const view = render(page());
    await settle();
    const text = view.container.querySelector("[data-key-source]")!.textContent;
    view.unmount();
    return text;
  };
  const usable = await textFor("member_variable");
  const secret = await textFor("member_secret");
  const none = await textFor(null);
  expect(new Set([usable, secret, none]).size).toBe(3);
});

// An env var name is a protocol value, so it is matched literally. With no
// key the tab points at the voice key only: OPENAI_API_KEY changes how Codex
// signs in.
it("names the variable it found, and only the voice key when none is set", async () => {
  const lineFor = async (source: string | null, name: string | null) => {
    keySource = source;
    keyName = name;
    const view = render(page());
    await settle();
    const text = view.container.querySelector("[data-key-source]")!.textContent;
    view.unmount();
    return text ?? "";
  };
  const voice = await lineFor("member_variable", "OPENAI_VOICE_API_KEY");
  expect(voice).toContain("OPENAI_VOICE_API_KEY");
  const fallback = await lineFor("office_variable", "OPENAI_API_KEY");
  expect(fallback).toContain("OPENAI_API_KEY");
  expect(fallback).not.toContain("OPENAI_VOICE_API_KEY");
  const none = await lineFor(null, null);
  expect(none).toContain("OPENAI_VOICE_API_KEY");
  expect(none).not.toContain("OPENAI_API_KEY");
});

it("shows the saved choices, Browser when none is saved", async () => {
  const fresh = render(page());
  await settle();
  expect(radio(fresh.container, "voiceInput", "browser").checked).toBe(true);
  expect(radio(fresh.container, "voiceOutput", "browser").checked).toBe(true);
  expect(fresh.container.querySelector('select[name="voiceName"]')).toBeNull();
  fresh.unmount();

  const picked = render(page({ voiceInput: "openai", voiceOutput: "openai" }));
  await settle();
  expect(radio(picked.container, "voiceInput", "openai").checked).toBe(true);
  expect(radio(picked.container, "voiceOutput", "openai").checked).toBe(true);
  const select = picked.container.querySelector('select[name="voiceName"]');
  expect(select instanceof HTMLSelectElement).toBe(true);
  expect((select as HTMLSelectElement).value).toBe(DEFAULT_VOICE_NAME);
  expect(
    [...(select as HTMLSelectElement).options].map((o) => o.value),
  ).toEqual([...VOICE_NAMES]);
  picked.unmount();
});

it("saves each change at once", async () => {
  const view = render(page({ voiceOutput: "openai", voiceName: "cedar" }));
  await settle();
  expect(
    (
      view.container.querySelector(
        'select[name="voiceName"]',
      ) as HTMLSelectElement
    ).value,
  ).toBe("cedar");

  fireEvent.click(radio(view.container, "voiceInput", "openai"));
  await settle();
  fireEvent.change(view.container.querySelector('select[name="voiceName"]')!, {
    target: { value: "ash" },
  });
  await settle();
  fireEvent.click(radio(view.container, "voiceOutput", "browser"));
  await settle();
  expect(patches).toEqual([
    { voiceInput: "openai" },
    { voiceName: "ash" },
    { voiceOutput: "browser" },
  ]);
  view.unmount();
});
