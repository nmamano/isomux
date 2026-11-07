// The Offices card of the enterprise account page (task 71718489, S2): IT
// renames an office in place and removes one after a confirm in the card. The
// card posts to /api/enterprise/offices/{rename,remove} and shows the result
// without a reload: a removed office leaves the list and its members leave
// the seat count in the Seats card. S4: the Billing card's next invoice and
// its button to Stripe's customer portal (POST /api/enterprise/billing/portal).
//
// The rules and the routes are in control-plane/enterprise.test.ts and
// control-plane/web-enterprise.test.ts.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
  url: "https://storefront.example.com/enterprise",
});
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EnterpriseAccount } = await import("./enterprise-view");
const { translatorFor } = await import("../lib/i18n/translate");
type View = import("../../enterprise").EnterpriseView;

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

interface Post {
  url: string;
  body: unknown;
}
let posts: Post[] = [];
/** The answer to the next post. */
let reply: () => Response = () => Response.json({ ok: true });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  posts.push({
    url:
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
  });
  return reply();
}) as typeof fetch;

const A = "a".repeat(32);
const B = "b".repeat(32);
const T0 = Date.parse("2027-03-10T12:00:00Z");

const VIEW: View = {
  id: "ent-00000000-0000-4000-8000-000000000000",
  company: "Acme Inc.",
  billingEmail: "billing@acme.example",
  plan: "monthly",
  seats: 50,
  kind: "standard",
  priceNote: null,
  signature: {
    name: "Ada Admin",
    title: "IT Director",
    at: T0,
    agreementVersion: "v",
  },
  contractStart: T0,
  inUse: 30,
  offices: [
    { id: A, name: "Berlin", members: 20, joinedAt: T0, lastSeenAt: T0 },
    { id: B, name: null, members: 10, joinedAt: T0, lastSeenAt: T0 },
  ],
  secret: `isx_ent_ent-00000000-0000-4000-8000-000000000000_mac`,
  nextInvoice: { issuedAt: T0 + 30 * 86_400_000, amountCents: 125_000 },
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  posts = [];
  reply = () => Response.json({ ok: true });
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(view: View = VIEW): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(EnterpriseAccount, {
        language: "en",
        view,
        now: T0,
        pdfPath: "/enterprise/agreement.pdf",
        maxSeats: 10_000,
        maxOfficeName: 100,
      }),
    );
  });
}

function offices(): HTMLElement {
  return container.querySelector(
    '[data-testid="enterprise-offices"]',
  ) as HTMLElement;
}

function row(office: string): HTMLElement | null {
  return offices().querySelector(`[data-office="${office}"]`);
}

function action(scope: HTMLElement | null, name: string): HTMLButtonElement {
  const found = scope?.querySelector(`[data-action="${name}"]`);
  if (!found) throw new Error(`no ${name} control`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

/** Type into a React-controlled input. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    // The prototype's setter, so React's value tracker sees a change.
    Reflect.set(HTMLInputElement.prototype, "value", value, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function nameInput(): HTMLInputElement | null {
  return offices().querySelector('input[name="officeName"]');
}

/** The Seats card's "N of M seats in use", through the catalog. */
function seatLine(seats: number, inUse: number): string {
  return translatorFor("en").tn("enterprise.seats.inUse", seats, { inUse });
}

function seatsCard(): string {
  return (
    container.querySelector('[data-testid="enterprise-seats"]')?.textContent ??
    ""
  );
}

test("rename in place: the field opens on the current name, Save posts the new name and shows it", async () => {
  await render();
  expect(nameInput()).toBeNull();
  await click(action(row(A), "rename"));
  const input = nameInput();
  if (!input) throw new Error("no name field");
  expect(input.value).toBe("Berlin");
  expect(document.activeElement === input).toBe(true);
  await type(input, "Berlin HQ");
  await click(action(offices(), "save"));
  expect(posts).toEqual([
    {
      url: "/api/enterprise/offices/rename",
      body: { office: A, name: "Berlin HQ" },
    },
  ]);
  expect(nameInput()).toBeNull();
  expect(row(A)?.textContent).toContain("Berlin HQ");
});

test("a refused rename keeps the field open and says why; Cancel closes it and posts nothing", async () => {
  await render();
  await click(action(row(B), "rename"));
  const input = nameInput();
  if (!input) throw new Error("no name field");
  // An unnamed office opens on an empty field.
  expect(input.value).toBe("");
  reply = () =>
    Response.json({ ok: false, reason: "invalid" }, { status: 400 });
  await type(input, "x");
  await click(action(offices(), "save"));
  expect(posts).toHaveLength(1);
  expect(offices().querySelector('[role="alert"]')).not.toBeNull();
  expect(nameInput()).not.toBeNull();
  await click(action(offices(), "cancel"));
  expect(nameInput()).toBeNull();
  expect(posts).toHaveLength(1);
  expect(row(B)?.textContent).not.toContain("x");
});

/** The text of each cell of the office's own row. */
function cells(office: string): string[] {
  return [...(row(office)?.children ?? [])].map(
    (cell) => cell.textContent ?? "",
  );
}

test("an open rename or remove leaves the office row as it was: the control opens in a row of its own under it", async () => {
  await render();
  const columns = offices().querySelectorAll("thead th").length;
  const before = cells(A);
  // The enabling condition: the row has a cell per column, with the name.
  expect(before).toHaveLength(columns);
  expect(before[0]).toBe("Berlin");

  await click(action(row(A), "rename"));
  const input = nameInput();
  if (!input) throw new Error("no name field");
  expect(cells(A)).toEqual(before);
  expect(row(A)?.contains(input)).toBe(false);
  const renameRow = row(A)?.nextElementSibling;
  expect(renameRow?.contains(input)).toBe(true);
  expect(renameRow?.children).toHaveLength(1);
  expect(renameRow?.children[0]?.getAttribute("colspan")).toBe(String(columns));

  await click(action(offices(), "cancel"));
  await click(action(row(A), "remove"));
  const confirm = action(offices(), "confirm-remove");
  expect(cells(A)).toEqual(before);
  expect(row(A)?.contains(confirm)).toBe(false);
  expect(row(A)?.nextElementSibling?.contains(confirm)).toBe(true);
});

test("remove asks first, in the card, with the focus on the confirm; the office then leaves the list and its members the count", async () => {
  await render();
  // The enabling condition: the Seats card counts the office's 20 members.
  expect(seatsCard()).toContain(seatLine(50, 30));
  await click(action(row(A), "remove"));
  expect(posts).toEqual([]);
  const confirm = action(offices(), "confirm-remove");
  expect(document.activeElement === confirm).toBe(true);
  await click(confirm);
  expect(posts).toEqual([
    { url: "/api/enterprise/offices/remove", body: { office: A } },
  ]);
  expect(row(A)).toBeNull();
  expect(row(B)).not.toBeNull();
  expect(seatsCard()).toContain(seatLine(50, 10));
});

test("cancelling a remove posts nothing and keeps the office", async () => {
  await render();
  await click(action(row(A), "remove"));
  await click(action(offices(), "cancel"));
  expect(offices().querySelector('[data-action="confirm-remove"]')).toBeNull();
  expect(posts).toEqual([]);
  expect(row(A)).not.toBeNull();
  expect(seatsCard()).toContain(seatLine(50, 30));
});

// ------------------------------------------------------------------ S4 billing

function billing(): HTMLElement {
  const card = container.querySelector('[data-testid="enterprise-billing"]');
  if (!card) throw new Error("no billing card");
  return card as HTMLElement;
}

test("Invoices and payment opens Stripe's portal at the URL the route gives; a refusal stays on the page and says so", async () => {
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    await render();
    expect(
      billing().querySelector('[data-testid="enterprise-next-invoice"]'),
    ).not.toBeNull();
    reply = () =>
      Response.json({ ok: true, url: "https://billing.stripe.example/s/1" });
    await click(action(billing(), "billing-portal"));
    expect(posts).toEqual([
      { url: "/api/enterprise/billing/portal", body: {} },
    ]);
    expect(assign.mock.calls).toEqual([["https://billing.stripe.example/s/1"]]);
    expect(billing().querySelector('[role="alert"]')).toBeNull();

    reply = () =>
      Response.json({ ok: false, reason: "stripe" }, { status: 409 });
    await click(action(billing(), "billing-portal"));
    expect(posts).toHaveLength(2);
    expect(assign.mock.calls).toHaveLength(1);
    expect(billing().querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    assign.mockRestore();
  }
});

test("a negotiated account has no portal button and no next invoice: an operator invoices it", async () => {
  await render({
    ...VIEW,
    kind: "negotiated",
    priceNote: "custom",
    signature: null,
  });
  // The enabling condition: the Billing card is there.
  expect(billing().textContent?.length).toBeGreaterThan(0);
  expect(billing().querySelector('[data-action="billing-portal"]')).toBeNull();
  expect(
    billing().querySelector('[data-testid="enterprise-next-invoice"]'),
  ).toBeNull();
});
