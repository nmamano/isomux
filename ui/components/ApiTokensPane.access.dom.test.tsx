// The Access choice in the API token mint form and the access line on each
// token card (task 23339bea). The server's parse and refusal are pinned in
// shared/api-token-limits.test.ts and
// server/test-support/routes-api-tokens-rest.test.ts; this file pins what the
// form sends and what the cards show.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { ApiTokensPane } = await import("./ApiTokensPane.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
const { API_TOKEN_AREAS, API_TOKEN_PRESETS } =
  await import("../../shared/api-token-limits.ts");
type ApiTokenWire = import("../../shared/contract-shapes.ts").ApiTokenWire;

function token(id: string, limits?: ApiTokenWire["limits"]): ApiTokenWire {
  return {
    id,
    name: id,
    tokenPrefix: "isomux_pat_abcdefgh",
    createdAt: 1_000,
    expiresAt: null,
    lastUsedAt: null,
    ...(limits ? { limits } : {}),
  };
}

let listed: ApiTokenWire[] = [];
const minted: unknown[] = [];
setApiShim(async (method, path, body) => {
  if (path === "/api/me/api-tokens" && method === "GET")
    return { apiTokens: listed };
  if (path === "/api/me/api-tokens" && method === "POST") {
    minted.push(body);
    return { token: "isomux_pat_new", apiToken: token("new") };
  }
  return {};
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  listed = [];
  minted.length = 0;
});

type View = ReturnType<typeof render>;

async function mount(): Promise<View> {
  let view!: View;
  await act(async () => {
    view = render(createElement(ApiTokensPane));
  });
  return view;
}

function el<T extends Element>(view: View, selector: string): T {
  const found = view.container.querySelector<T>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
}

const accessSelect = (view: View) =>
  el<HTMLSelectElement>(view, '[data-testid="api-token-access"]');

async function change(
  target: HTMLSelectElement | HTMLInputElement,
  value: string,
) {
  await act(async () => {
    fireEvent.change(target, { target: { value } });
  });
}

// The areas the form shows, with the level each select holds.
function areaValues(view: View): Record<string, string> {
  return Object.fromEntries(
    [
      ...view.container.querySelectorAll<HTMLSelectElement>(
        "select[data-area]",
      ),
    ].map((select) => [select.getAttribute("data-area"), select.value]),
  );
}

async function mint(view: View) {
  await change(
    el<HTMLInputElement>(view, '[data-testid="api-token-name"]'),
    "Script",
  );
  await act(async () => {
    fireEvent.click(el(view, '[data-testid="api-token-create"]'));
  });
  expect(minted).toHaveLength(1);
  return minted[0] as { name: string; limits?: unknown };
}

describe("API token mint form: access", () => {
  it("defaults to Full access: no area list, and the mint sends no limits", async () => {
    const view = await mount();
    expect(accessSelect(view).value).toBe("full");
    expect(areaValues(view)).toEqual({});
    const body = await mint(view);
    expect(body.name).toBe("Script");
    expect("limits" in body).toBe(false);
  });

  it("a preset fills every area, and the mint sends exactly its areas", async () => {
    const view = await mount();
    await change(accessSelect(view), "readOnly");
    const shown = areaValues(view);
    expect(Object.keys(shown).sort()).toEqual([...API_TOKEN_AREAS].sort());
    for (const area of API_TOKEN_AREAS) {
      expect({ area, level: shown[area] }).toEqual({
        area,
        level: API_TOKEN_PRESETS.readOnly.areas[area] ?? "none",
      });
    }
    expect((await mint(view)).limits).toEqual(API_TOKEN_PRESETS.readOnly);
  });

  it("changing an area switches to Custom, and none leaves the area out", async () => {
    const view = await mount();
    await change(accessSelect(view), "readOnly");
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="tasks"]'),
      "write",
    );
    expect(accessSelect(view).value).toBe("custom");
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="pager"]'),
      "none",
    );
    expect(areaValues(view)).toMatchObject({ tasks: "write", pager: "none" });
    const { pager: _pager, ...rest } = API_TOKEN_PRESETS.readOnly.areas;
    expect((await mint(view)).limits).toEqual({
      areas: { ...rest, tasks: "write" },
    });
  });

  it("marks a write that equals full access, and only that one", async () => {
    const view = await mount();
    await change(accessSelect(view), "readOnly");
    expect(
      view.container.querySelectorAll("[data-full-access-warning]"),
    ).toHaveLength(0);
    // tasks write is not flagged; agents write is.
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="tasks"]'),
      "write",
    );
    expect(
      view.container.querySelectorAll("[data-full-access-warning]"),
    ).toHaveLength(0);
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="agents"]'),
      "write",
    );
    expect(
      [...view.container.querySelectorAll("[data-full-access-warning]")].map(
        (node) => node.getAttribute("data-full-access-warning"),
      ),
    ).toEqual(["agents"]);
    // Back to read: the mark goes.
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="agents"]'),
      "read",
    );
    expect(
      view.container.querySelectorAll("[data-full-access-warning]"),
    ).toHaveLength(0);
  });

  it("Full access again hides the areas and sends no limits", async () => {
    const view = await mount();
    await change(accessSelect(view), "talkToAgents");
    expect(areaValues(view).agents).toBe("write");
    await change(accessSelect(view), "full");
    expect(areaValues(view)).toEqual({});
    expect("limits" in (await mint(view))).toBe(false);
  });
});

describe("API token cards: access", () => {
  it("names the preset a token's limits equal, else Custom", async () => {
    listed = [
      token("full"),
      token("reader", API_TOKEN_PRESETS.readOnly),
      token("talker", API_TOKEN_PRESETS.talkToAgents),
      token("custom", { areas: { tasks: "write" } }),
      token("empty", { areas: {} }),
    ];
    const view = await mount();
    const access = Object.fromEntries(
      [...view.container.querySelectorAll("[data-api-token]")].map((card) => [
        card.getAttribute("data-api-token"),
        card
          .querySelector("[data-token-access]")
          ?.getAttribute("data-token-access"),
      ]),
    );
    expect(access).toEqual({
      full: "full",
      reader: "readOnly",
      talker: "talkToAgents",
      custom: "custom",
      empty: "custom",
    });
  });
});
