// A control on the office page that fails says so beside it.
//
// The page asks the server on each click. When the request fails - the server
// answers with no reason of its own, or the request never reaches it - the
// customer reads one danger callout: a whole sentence, the same one either way.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ProgressView } from "../lib/services.server";
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
} from "../lib/i18n/languages";

GlobalRegistrator.register({ url: "https://storefront.example.com/office" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { OfficeView } = await import("./office-view");
const { webTranslatorFor } = await import("../lib/i18n/rich");

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

/** How every click request fails. The progress poll always fails too, so the
 * view stays the one the test rendered. */
let failure: "no-reason" | "unreachable" = "no-reason";
let clicked: string[] = [];
/** A test that needs a particular answer for one path sets it here; the call
 * count lets a script answer differently the second time. */
let answers: Record<string, (call: number) => Response> = {};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.startsWith("/api/progress/"))
    return new Response("{}", { status: 500 });
  clicked.push(url);
  const answer = answers[url];
  if (answer) return answer(clicked.filter((u) => u === url).length);
  if (failure === "unreachable") throw new TypeError("Failed to fetch");
  return Response.json({ ok: false }, { status: 500 });
}) as typeof fetch;

const liveView: ProgressView = {
  asOf: 0,
  instanceId: "instance-test",
  officeName: "test-office",
  hostname: "test-office.example.test",
  sshTarget: null,
  plan: "V153",
  tier: {
    label: "Entry",
    specification: "4 vCPU, 8 GB RAM, 100 GB SSD",
    customerPrice: { amount: 8, currency: "EUR", billingPeriod: "month" },
  },
  serviceState: "live",
  goal: "live",
  origin: "created",
  steps: [],
  otherOperations: [],
  ready: true,
  ended: false,
  attention: [],
  access: { state: "held", expiresAt: null, ceilingProven: true },
  handoff: {
    canMint: true,
    invite: { state: "none", operationId: null, mintedAt: 1 },
    revocation: { state: "none", customerConfirmed: false, confirmedAt: null },
  },
  liveness: null,
  checkoutOver: false,
  restart: { state: "none", active: false, lastRequestedAt: null },
  subscription: {
    status: "active",
    currentPeriodEnd: Date.UTC(2027, 1, 14),
    cancelAtPeriodEnd: false,
    comped: false,
    endedAt: null,
    customerCancelled: false,
    cancellationPolicy: "launch",
  },
  lifecycle: null,
};

const suspendedView: ProgressView = {
  ...liveView,
  serviceState: "suspended",
  ready: false,
  subscription: {
    ...liveView.subscription!,
    status: "canceled",
    endedAt: 0,
    customerCancelled: true,
  },
  lifecycle: {
    phase: "suspended",
    graceEnd: 0,
    retentionEnd: Date.UTC(2027, 1, 14),
    poweredOff: true,
    reinstate: { allowed: true, reason: null },
  },
};

interface Control {
  name: string;
  view: ProgressView;
  /** Steps before the click, for a control that needs them. */
  prepare?: (box: HTMLElement) => void;
  button: string;
  callout: string;
}

const CONTROLS: Control[] = [
  {
    name: "owner invite",
    view: liveView,
    button: "invite-button",
    callout: "invite-problem",
  },
  {
    name: "remove our access",
    view: liveView,
    prepare: (box) =>
      box
        .querySelector<HTMLInputElement>(
          '[data-testid="signed-in-confirmation"]',
        )!
        .click(),
    button: "revoke-button",
    callout: "handoff-problem",
  },
  {
    name: "restart",
    view: liveView,
    button: "restart-button",
    callout: "action-problem",
  },
  {
    name: "cancel",
    view: liveView,
    button: "cancel-button",
    callout: "billing-problem",
  },
  {
    name: "reinstate",
    view: suspendedView,
    button: "reinstate-button",
    callout: "billing-problem",
  },
];

let box: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  box?.remove();
  box = null;
  clicked = [];
  answers = {};
});

/** Renders the page, clicks the control and returns its callout text, or null
 * when no callout shows. */
async function failedClick(
  language: SupportedLanguageCode,
  control: Control,
): Promise<string | null> {
  await act(async () => root?.unmount());
  box?.remove();
  clicked = [];
  box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  await act(async () => {
    root!.render(
      createElement(OfficeView, {
        language,
        initial: control.view,
        instanceId: control.view.instanceId,
      }),
    );
  });
  const page = box;
  await act(async () => control.prepare?.(page));
  const button = page.querySelector<HTMLButtonElement>(
    `[data-testid="${control.button}"]`,
  );
  // The control is on screen and can be pressed, or the test proves nothing.
  expect([control.button, button !== null && !button.disabled]).toEqual([
    control.button,
    true,
  ]);
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The click reached the network, so the callout is the answer to it.
  expect(clicked.length).toBeGreaterThan(0);
  const callout = page.querySelector(`[data-testid="${control.callout}"]`);
  if (!callout) return null;
  expect(callout.classList.contains("callout-danger")).toBe(true);
  return callout.textContent;
}

for (const { code: language } of SUPPORTED_LANGUAGES) {
  test.each(CONTROLS.map((control) => [control.name, control] as const))(
    `${language}: a failed %s shows one whole sentence, whether the server answered or not`,
    async (_name, control) => {
      failure = "no-reason";
      const answered = await failedClick(language, control);
      failure = "unreachable";
      const unreachable = await failedClick(language, control);

      expect([control.name, answered]).not.toEqual([control.name, null]);
      // A sentence start: a letter, and never a lowercase one (a script
      // without case, such as Chinese, passes on its first character).
      expect(answered!).toMatch(/^(?!\p{Ll})\p{L}/u);
      expect(answered!).toMatch(/[.!?。]$/u);
      expect([control.name, unreachable]).toEqual([control.name, answered]);
    },
  );
}

// A REFUSAL THE SERVER EXPLAINS carries a code beside its English sentence.
// The page words the code in the reader's language, and shows the server's
// sentence only for a code it has no words for.

/** The path each control asks, a code its table can send, and the catalog key
 * that code reads as. The key is spelled here rather than derived, so the
 * expectation does not come from the derivation under test. */
const REFUSALS: Record<string, { path: string; code: string; key: string }> = {
  "owner invite": {
    path: "/api/invite",
    code: "not_live",
    key: "refusals.requestNotLive",
  },
  "remove our access": {
    path: "/api/handoff",
    code: "revocation_in_progress",
    key: "refusals.requestRevocationInProgress",
  },
  restart: {
    path: "/api/restart",
    code: "restart_in_progress",
    key: "refusals.requestRestartInProgress",
  },
  cancel: {
    path: "/api/cancel",
    code: "already_cancelled",
    key: "refusals.cancelAlreadyCancelled",
  },
  reinstate: {
    path: "/api/reinstate",
    code: "too_late",
    key: "refusals.reinstatementTooLate",
  },
};

const DELIVERED = "The English sentence the server sent.";

test.each(CONTROLS.map((control) => [control.name, control] as const))(
  "es: a refused %s reads the refusal in Spanish, or the server's sentence for an unknown code",
  async (name, control) => {
    const refusal = REFUSALS[name];
    const spanish = (
      webTranslatorFor("es").t as unknown as (key: string) => string
    )(refusal.key);
    // The catalog holds the key (an unknown key echoes itself), and its
    // sentence is not the one the server sent.
    expect([name, spanish === refusal.key, spanish === DELIVERED]).toEqual([
      name,
      false,
      false,
    ]);

    answers = {
      [refusal.path]: () =>
        Response.json(
          { ok: false, code: refusal.code, reason: DELIVERED },
          { status: 409 },
        ),
    };
    const known = await failedClick("es", control);
    expect(clicked).toContain(refusal.path);
    expect([name, known]).toEqual([name, spanish]);

    answers = {
      [refusal.path]: () =>
        Response.json(
          { ok: false, code: "a_code_from_the_future", reason: DELIVERED },
          { status: 409 },
        ),
    };
    const unknown = await failedClick("es", control);
    expect(clicked).toContain(refusal.path);
    expect([name, unknown]).toEqual([name, DELIVERED]);
  },
);

// THE INVITE IS COLLECTED BY A POLL after the ask succeeds. Its answer carries
// a status, the protocol value, and a reason, which is the seam's English prose
// for logs. The page words the status in the reader's language.

const REVEAL_STATUSES = [
  ["expired_or_lost", 200, "office.invite.gone"],
  ["window_closed", 200, "office.invite.closed"],
  ["failed", 200, "office.invite.failed"],
  ["forbidden", 404, "office.invite.failed"],
] as const;

async function askForInvite(language: SupportedLanguageCode): Promise<void> {
  box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  await act(async () => {
    root!.render(
      createElement(OfficeView, {
        language,
        initial: liveView,
        instanceId: liveView.instanceId,
      }),
    );
  });
  await act(async () => {
    box!
      .querySelector<HTMLButtonElement>('[data-testid="invite-button"]')!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The status picks the key whatever the language; Spanish shows the page's
// language reaches the words.
test.each(REVEAL_STATUSES)(
  "es: an invite the poll answers %s is worded by its status, never by the seam's reason",
  async (status, httpStatus, key) => {
    const language = "es";
    answers = {
      "/api/invite": () => Response.json({ ok: true, operationId: "op-1" }),
      "/api/invite/reveal": () =>
        Response.json(
          { status, reason: "the seam's own words" },
          { status: httpStatus },
        ),
    };
    await askForInvite(language);
    // The poll asked, so the callout is its answer.
    expect(clicked).toContain("/api/invite/reveal");
    const callout = box!.querySelector('[data-testid="invite-problem"]');
    expect([status, callout?.textContent]).toEqual([
      status,
      webTranslatorFor(language).t(key),
    ]);
  },
);

test("a reveal poll the network drops is one missed poll: the next answer still shows the link", async () => {
  // The poll waits two seconds between asks; this test does not.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((run: () => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(
      run,
      ms === 2_000 ? 0 : ms,
      ...rest,
    )) as unknown as typeof setTimeout;
  try {
    answers = {
      "/api/invite": () => Response.json({ ok: true, operationId: "op-1" }),
      "/api/invite/reveal": (call) => {
        if (call === 1) throw new TypeError("Failed to fetch");
        return Response.json({
          status: "ready",
          url: "https://test-office.example.test/i/owner",
        });
      },
    };
    await askForInvite("en");
    await act(async () => {
      for (
        let i = 0;
        i < 20 && !box!.querySelector("[data-testid=invite-link]");
        i++
      )
        await new Promise((resolve) => realSetTimeout(resolve, 5));
    });
    expect(clicked.filter((url) => url === "/api/invite/reveal")).toHaveLength(
      2,
    );
    expect(
      box!.querySelector('[data-testid="invite-link"]')?.getAttribute("href"),
    ).toBe("https://test-office.example.test/i/owner");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// THE PAGE'S SHAPE. The head names the office, its state and, once there is a
// way in, the link to it. A ready office puts Getting in first; while it is
// being built, Progress comes first and Getting in waits beside it. The plan
// and the subscription are one card. The DOM order is the order a reader and a
// narrow screen meet, so it is asserted on the document, not on the CSS.
describe("the office page's layout", () => {
  const page = (view: ProgressView): HTMLElement => {
    const box = document.createElement("div");
    box.innerHTML = renderToStaticMarkup(
      createElement(OfficeView, {
        language: "en",
        initial: view,
        instanceId: view.instanceId,
      }),
    );
    return box;
  };
  const byId = (box: HTMLElement, testId: string): HTMLElement => {
    const element = box.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    expect([testId, element?.tagName ?? null]).not.toEqual([testId, null]);
    return element!;
  };
  const before = (a: HTMLElement, b: HTMLElement): boolean =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const OPEN = `a[href="https://${liveView.hostname}"]`;

  test("a ready office: the way in is in the head, Getting in before Progress", () => {
    const box = page(liveView);
    const head = byId(box, "office-header");
    for (const testId of ["office-hostname", "office-status"])
      expect([testId, head.contains(byId(box, testId))]).toEqual([
        testId,
        true,
      ]);
    expect(head.querySelector(OPEN)?.tagName ?? null).toBe("A");
    expect(head.contains(byId(box, "steps"))).toBe(false);
    expect(before(byId(box, "handoff"), byId(box, "steps"))).toBe(true);
    expect(byId(box, "office-tier").contains(byId(box, "subscription"))).toBe(
      true,
    );
  });

  test("the plan card names the plan once, with or without a subscription", () => {
    // The subscription line sits under the plan's own name, so it does not
    // repeat it. Both of its branches: a subscription, and none yet.
    for (const [state, view] of [
      ["subscribed", liveView],
      ["no subscription", { ...liveView, subscription: null }],
    ] as const) {
      const card = byId(page(view), "office-tier");
      const line = card.querySelector('[data-testid="subscription"]');
      // The enabling condition: the line is drawn and says something.
      expect([state, (line?.textContent ?? "").length > 0]).toEqual([
        state,
        true,
      ]);
      expect([
        state,
        card.textContent.split(view.tier.label).length - 1,
      ]).toEqual([state, 1]);
    }
  });

  test("an office being built: Progress before Getting in, nothing to open", () => {
    const box = page({ ...liveView, ready: false });
    expect(byId(box, "office-header").querySelector(OPEN)).toBeNull();
    expect(box.querySelector(OPEN)).toBeNull();
    expect(before(byId(box, "steps"), byId(box, "handoff"))).toBe(true);
    expect(byId(box, "office-tier").contains(byId(box, "subscription"))).toBe(
      true,
    );
  });
});
