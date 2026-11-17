// Automations > Webhooks keeps its layout while the list loads (task
// 8caa3022, the UI rule in AGENTS.md): before GET /api/webhooks answers, the
// list draws the table with as many blank rows as it showed when it last
// loaded on this device (or the empty box for none), and the Refresh row,
// disabled. So nothing below it moves when the answer arrives.
//
// happy-dom lays nothing out: blockShape compares the block and control tree
// drawn while the read waits with the tree drawn once it answered.
//
// Seam: WebhooksView over setApiShim, with the real store reducer, so the
// answer reaches the view through the webhooks_loaded action.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { blockShape, heldControls } from "../test-support/held-shape.ts";

setUpDomTestFile();

const { act, cleanup, render } = await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { WebhooksView } = await import("./WebhooksView.tsx");
const { setApiShim } = await import("../api.ts");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { hookWire } = await import("../test-support/webhook-fixture.ts");
const { getWebhooksLayout, setWebhooksLayout } =
  await import("../device-settings.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type AppState = import("../store.tsx").AppState;
type WebhookWire = import("../../shared/types.ts").WebhookWire;

const en = translatorFor("en");

function hooks(n: number, cronjobId = "job00001"): WebhookWire[] {
  return Array.from({ length: n }, (_, i) =>
    hookWire({
      id: `wh_${String(i).padStart(16, "0")}`,
      name: `hook-${i}`,
      target: { kind: "cronjob", cronjobId },
    }),
  );
}

// Each GET /api/webhooks waits until `answer` (with `list`) or `fail` settles
// the oldest read in flight. Every other request is recorded and refused.
let listGets = 0;
let others: string[] = [];
function serve(list: WebhookWire[]) {
  const reads: {
    resolve: (v: WebhookWire[]) => void;
    reject: (e: Error) => void;
  }[] = [];
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/webhooks") {
      listGets++;
      return new Promise<WebhookWire[]>((resolve, reject) =>
        reads.push({ resolve, reject }),
      );
    }
    others.push(`${method} ${path}`);
    throw new Error(`no shim for ${method} ${path}`);
  });
  return {
    answer: async () => {
      await act(async () => reads.shift()!.resolve(list));
      await settle();
    },
    fail: async () => {
      await act(async () => reads.shift()!.reject(new Error("network down")));
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(
  over: Partial<AppState>,
  props: { roomFilter?: string; onOpenHook?: (id: string) => void } = {},
) {
  function Harness() {
    const [state, dispatch] = useReducer(
      reducer,
      stateWithSelfUser("en", { hydrationEpoch: 1, ...over }),
    );
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(
          LanguageProvider,
          null,
          createElement(WebhooksView, {
            openHookId: null,
            focusDeliveryId: null,
            onOpenHook: props.onOpenHook ?? (() => {}),
            onCloseHook: () => {},
            onEdit: () => {},
            onOpenRun: () => {},
            roomFilter: props.roomFilter,
            roomOptions: [{ id: "room-a" }, { id: "room-b" }],
          }),
        ),
      ),
    );
  }
  return render(createElement(Harness));
}

const busy = (root: Element) =>
  root.querySelectorAll('[aria-busy="true"]').length;
const refreshButton = (root: Element) =>
  root.querySelector<HTMLButtonElement>("button[data-webhooks-refresh]");
const realRows = (root: Element) =>
  root.querySelectorAll("tr[data-webhook-row]").length;

beforeEach(() => {
  window.localStorage.clear();
  listGets = 0;
  others = [];
});
afterEach(() => cleanup());
afterAll(() => setApiShim(null));

const loading = en.t("common.loading");

for (const isMobile of [false, true]) {
  describe(`the list while it loads (${isMobile ? "phone" : "desktop"})`, () => {
    // null: a device that never loaded the list.
    for (const stored of [null, 0, 3]) {
      it(`holds the layout of the last load (${stored ?? "first visit"})`, async () => {
        const n = stored ?? 1;
        if (stored !== null) setWebhooksLayout({ rows: stored });
        const read = serve(hooks(n));
        const view = mount({ isMobile });
        await settle();

        expect(listGets).toBe(1);
        expect(busy(view.container)).toBe(1);
        expect(realRows(view.container)).toBe(0);
        expect(view.container.textContent).toContain(loading);
        const refresh = refreshButton(view.container)!;
        expect(refresh.disabled).toBe(true);
        expect(heldControls(view.container)).toContain(refresh);
        const held = blockShape(view.container);

        await read.answer();
        expect(busy(view.container)).toBe(0);
        expect(realRows(view.container)).toBe(n);
        expect(view.container.textContent).not.toContain(loading);
        expect(refreshButton(view.container)!.disabled).toBe(false);
        expect(blockShape(view.container)).toBe(held);
      });
    }
  });
}

it("a held row opens no hook and toggles nothing", async () => {
  setWebhooksLayout({ rows: 3 });
  serve(hooks(3));
  const opened: string[] = [];
  const view = mount({}, { onOpenHook: (id) => opened.push(id) });
  await settle();
  const cells = view.container.querySelectorAll<HTMLElement>("tbody td");
  expect(cells.length).toBeGreaterThan(0);
  for (const cell of cells) await act(async () => cell.click());
  await settle();
  expect(opened).toEqual([]);
  expect(others).toEqual([]);
});

it("after a failed first load it stops saying it loads, and Refresh retries", async () => {
  setWebhooksLayout({ rows: 2 });
  const read = serve(hooks(2));
  const view = mount({});
  await settle();
  await read.fail();

  expect(view.container.textContent).toContain(en.t("webhooks.loadFailed"));
  expect(view.container.textContent).not.toContain(loading);
  expect(busy(view.container)).toBe(0);
  const refresh = refreshButton(view.container)!;
  expect(refresh.disabled).toBe(false);

  await act(async () => refresh.click());
  await settle();
  expect(listGets).toBe(2);
  await read.answer();
  expect(realRows(view.container)).toBe(2);
});

it("stores the count of rows the room filter shows", async () => {
  setWebhooksLayout({ rows: 0 });
  const cronjobs = [
    { id: "job-a", name: "a", roomId: "room-a" },
    { id: "job-b", name: "b", roomId: "room-b" },
  ] as unknown as AppState["cronjobs"];
  const list = [
    ...hooks(2, "job-a"),
    ...hooks(3, "job-b").map((h, i) => ({ ...h, id: `wh_b${i}` })),
  ];
  const read = serve(list);
  const view = mount({ cronjobs }, { roomFilter: "room-a" });
  await settle();
  // Held: nothing stored yet for this load.
  expect(getWebhooksLayout()).toEqual({ rows: 0 });

  await read.answer();
  expect(realRows(view.container)).toBe(2);
  expect(getWebhooksLayout()).toEqual({ rows: 2 });
});
