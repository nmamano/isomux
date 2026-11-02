// The Access and Rooms choices in the API token mint form and the access and
// rooms lines on each token card (task 23339bea). The server's parse and refusal are pinned in
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
// The member's ordinary rooms, as GET /api/me/rooms lists them.
const ROOMS = [
  { id: "room-a", name: "Alpha" },
  { id: "room-b", name: "Beta" },
];
setApiShim(async (method, path, body) => {
  if (path === "/api/me/rooms" && method === "GET") return { rooms: ROOMS };
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
    // tasks and agents write are not flagged (the pack rule bounds agents
    // write, task 134b8f77); memory write is.
    for (const area of ["tasks", "agents"]) {
      await change(
        el<HTMLSelectElement>(view, `select[data-area="${area}"]`),
        "write",
      );
    }
    expect(
      view.container.querySelectorAll("[data-full-access-warning]"),
    ).toHaveLength(0);
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="memory"]'),
      "write",
    );
    expect(
      [...view.container.querySelectorAll("[data-full-access-warning]")].map(
        (node) => node.getAttribute("data-full-access-warning"),
      ),
    ).toEqual(["memory"]);
    // Back to read: the mark goes.
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="memory"]'),
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

const roomsSelect = (view: View) =>
  el<HTMLSelectElement>(view, '[data-testid="api-token-rooms"]');

const roomBoxes = (view: View) => [
  ...view.container.querySelectorAll<HTMLInputElement>("input[data-room]"),
];

async function tick(box: HTMLInputElement) {
  await act(async () => {
    fireEvent.click(box);
  });
}

describe("API token mint form: rooms", () => {
  it("defaults to every room: no room list, and the mint sends no rooms", async () => {
    const view = await mount();
    expect(roomsSelect(view).value).toBe("all");
    expect(roomBoxes(view)).toHaveLength(0);
    expect("limits" in (await mint(view))).toBe(false);
  });

  it("Some rooms lists the member's rooms unchecked, and Full access sends only the rooms picked", async () => {
    const view = await mount();
    await change(roomsSelect(view), "some");
    const boxes = roomBoxes(view);
    expect(
      boxes.map((box) => [box.getAttribute("data-room"), box.checked]),
    ).toEqual([
      ["room-a", false],
      ["room-b", false],
    ]);
    // Each box is labelled with its room's name.
    expect(view.container.textContent).toContain("Alpha");
    expect(view.container.textContent).toContain("Beta");
    await tick(boxes[1]);
    expect((await mint(view)).limits).toEqual({ rooms: ["room-b"] });
  });

  it("rooms combine with an area preset", async () => {
    const view = await mount();
    await change(accessSelect(view), "readOnly");
    await change(roomsSelect(view), "some");
    await tick(el<HTMLInputElement>(view, 'input[data-room="room-a"]'));
    expect((await mint(view)).limits).toEqual({
      ...API_TOKEN_PRESETS.readOnly,
      rooms: ["room-a"],
    });
  });

  it("every room again drops the picked rooms from the mint", async () => {
    const view = await mount();
    await change(accessSelect(view), "readOnly");
    await change(roomsSelect(view), "some");
    await tick(el<HTMLInputElement>(view, 'input[data-room="room-a"]'));
    await change(roomsSelect(view), "all");
    expect(roomBoxes(view)).toHaveLength(0);
    expect((await mint(view)).limits).toEqual(API_TOKEN_PRESETS.readOnly);
  });
});

describe("API token cards: rooms", () => {
  it("marks a token every room or some rooms, and names the rooms it can", async () => {
    listed = [
      token("full"),
      token("reader", API_TOKEN_PRESETS.readOnly),
      token("alpha", { rooms: ["room-a", "room-gone"] }),
      token("nowhere", { ...API_TOKEN_PRESETS.readOnly, rooms: [] }),
    ];
    const view = await mount();
    const card = (id: string) =>
      el<HTMLElement>(view, `[data-api-token="${id}"]`);
    const rooms = (id: string) =>
      card(id)
        .querySelector("[data-token-rooms]")
        ?.getAttribute("data-token-rooms");
    expect({
      full: rooms("full"),
      reader: rooms("reader"),
      alpha: rooms("alpha"),
      nowhere: rooms("nowhere"),
    }).toEqual({
      full: "all",
      reader: "all",
      alpha: "some",
      nowhere: "some",
    });
    const alphaLine = card("alpha").querySelector("[data-token-rooms]")!;
    expect(alphaLine.textContent).toContain("Alpha");
    expect(alphaLine.textContent).not.toContain("Beta");
    // An id the member's rooms cannot name is not shown raw.
    expect(alphaLine.textContent).not.toContain("room-gone");
    // The rooms axis does not change the access line.
    expect(
      card("nowhere")
        .querySelector("[data-token-access]")
        ?.getAttribute("data-token-access"),
    ).toBe("readOnly");
  });
});

// Task 23339bea, slice 3: the Replies only pack and the switch under Custom.
const repliesBox = (view: View) =>
  view.container.querySelector<HTMLInputElement>(
    'input[data-testid="api-token-replies-only"]',
  );
const fullAccessWarnings = (view: View) =>
  [...view.container.querySelectorAll("[data-full-access-warning]")].map(
    (node) => node.getAttribute("data-full-access-warning"),
  );

describe("API token mint form: replies only", () => {
  it("the Replies only pack fills Talk to agents, sets the switch, and mints exactly the pack", async () => {
    const view = await mount();
    await change(accessSelect(view), "talkToAgents");
    expect(fullAccessWarnings(view)).toEqual([]);
    await change(accessSelect(view), "repliesOnly");
    expect(areaValues(view)).toEqual(
      Object.fromEntries(
        API_TOKEN_AREAS.map((area) => [
          area,
          API_TOKEN_PRESETS.talkToAgents.areas[area] ?? "none",
        ]),
      ),
    );
    expect(repliesBox(view)?.checked).toBe(true);
    expect(fullAccessWarnings(view)).toEqual([]);
    expect((await mint(view)).limits).toEqual(API_TOKEN_PRESETS.repliesOnly);
  });

  it("under Custom the switch shows only while Agents is Read and write, and sends replies only with it", async () => {
    const view = await mount();
    await change(accessSelect(view), "readOnly");
    expect(repliesBox(view)).toBeNull();
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="tasks"]'),
      "write",
    );
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="agents"]'),
      "write",
    );
    expect(accessSelect(view).value).toBe("custom");
    expect(repliesBox(view)?.checked).toBe(false);
    await tick(repliesBox(view)!);
    expect(repliesBox(view)?.checked).toBe(true);
    expect((await mint(view)).limits).toEqual({
      areas: {
        ...API_TOKEN_PRESETS.readOnly.areas,
        tasks: "write",
        agents: "write",
      },
      repliesOnly: true,
    });
  });

  it("moving Agents off Read and write hides the switch and drops it from the mint", async () => {
    const view = await mount();
    await change(accessSelect(view), "repliesOnly");
    expect(repliesBox(view)?.checked).toBe(true);
    await change(
      el<HTMLSelectElement>(view, 'select[data-area="agents"]'),
      "read",
    );
    expect(repliesBox(view)).toBeNull();
    const body = await mint(view);
    expect(body.limits).toEqual(API_TOKEN_PRESETS.readOnly);
    expect("repliesOnly" in (body.limits as object)).toBe(false);
  });
});

describe("API token cards: replies only", () => {
  it("names the Replies only pack, and keeps Talk to agents apart from it", async () => {
    listed = [
      token("replies", API_TOKEN_PRESETS.repliesOnly),
      token("talker", API_TOKEN_PRESETS.talkToAgents),
      token("roomsReplies", { repliesOnly: true, rooms: ["room-a"] }),
    ];
    const view = await mount();
    const access = (id: string) =>
      view.container
        .querySelector(`[data-api-token="${id}"] [data-token-access]`)
        ?.getAttribute("data-token-access");
    expect({
      replies: access("replies"),
      talker: access("talker"),
    }).toEqual({ replies: "repliesOnly", talker: "talkToAgents" });
    // Every area plus the switch is neither the pack nor full access.
    expect(access("roomsReplies")).toBe("custom");
  });
});
