// OpenCode on the Model providers tab (task a1e5ea01): a section on a par with
// Claude and Codex. Three rows that are always drawn (free models, paid models
// and the key, your own model server); the office's free limit; the key added,
// replaced or removed in place as the OPENCODE_API_KEY variable; an owner on
// another member's card does the same for that member.
//
// Seam: the Integrations page over the in-memory fake server.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { IntegrationsFake, EMPTY_CONNECTIONS } =
  await import("../test-support/integrations-fake.ts");
const { MEMBER, OWNER, card, click, open, pick, type } =
  await import("../test-support/integrations-page-fixture.ts");
afterAll(() => setApiShim(null));

type View = Awaited<ReturnType<typeof open>>;
type Which = "office" | "personal";

const KEY = "OPENCODE_API_KEY";
const ME = "/api/me/opencode";
const MODELS = "/api/backends/opencode/models";

let fake: InstanceType<typeof IntegrationsFake>;
function serve(viewer = { username: "Ricky", owner: true }) {
  fake = new IntegrationsFake(viewer, ["Ricky", "Stephen"]).install();
}
beforeEach(() => serve());

// The office's own variable, as the connections list and the env routes
// both see it.
function officeKey() {
  fake.scope("office").values = { [KEY]: "office-value" };
  fake.connections = {
    ...EMPTY_CONNECTIONS,
    variables: [{ scope: "office", name: KEY, note: null }],
  };
}

const section = (view: View, which: Which) =>
  card(view, which).querySelector<HTMLElement>(
    '[data-provider-block="opencode"]',
  )!;
const row = (root: Element, name: "free" | "paid" | "own-server") =>
  root.querySelector<HTMLElement>(`[data-opencode-row="${name}"]`)!;
const held = (root: Element) => root.querySelectorAll("[data-reserved]");
const gets = () => fake.requests("GET", ME).length;
const listings = () => fake.requests("POST", MODELS).length;

const model = (id: string, label: string, isFree?: true) => ({
  id,
  label,
  supportedEfforts: [],
  ...(isFree ? { isFree } : {}),
});
const MODELS_LISTED = [
  model("opencode/big-pickle", "Big Pickle", true),
  model("opencode/claude-sonnet", "Claude Sonnet"),
  model("opencode-go/kimi", "Kimi"),
  model("opencode/gpt-mini", "GPT Mini"),
  // A model server of the member's own, with no cost block: not free, and
  // not one of OpenCode's paid models either.
  model("ollama/llama3", "ollama - Llama 3"),
];

describe("the rows", () => {
  it("draws the three rows while the reads are out, and fills them in place", async () => {
    const releases = [
      fake.hold(ME),
      fake.hold(MODELS),
      fake.hold("/api/me/connections"),
    ];
    fake.openCode = { freeLimitAt: null, keySource: "office_variable" };
    fake.openCodeModels = MODELS_LISTED;
    officeKey();
    const view = await open();
    for (const which of ["office", "personal"] as const) {
      const root = section(view, which);
      for (const name of ["free", "paid", "own-server"] as const)
        expect({ which, name, drawn: row(root, name) !== null }).toEqual({
          which,
          name,
          drawn: true,
        });
      for (const name of ["free", "paid"] as const)
        expect({ which, name, held: held(row(root, name)).length > 0 }).toEqual(
          { which, name, held: true },
        );
      // Held space says nothing about the key.
      expect(row(root, "paid").hasAttribute("data-opencode-key")).toBe(false);
    }

    await act(async () => {
      for (const release of releases) release();
    });
    for (const which of ["office", "personal"] as const) {
      const root = section(view, which);
      for (const name of ["free", "paid", "own-server"] as const)
        expect(row(root, name)).not.toBeNull();
      expect({ which, held: held(root).length }).toEqual({ which, held: 0 });
      expect(row(root, "paid").getAttribute("data-opencode-key")).toBe("set");
    }
  });

  it("lists the viewer's free models, counts OpenCode's paid ones, and puts other providers under your own server", async () => {
    fake.openCode = { freeLimitAt: null, keySource: "member_variable" };
    fake.openCodeModels = MODELS_LISTED;
    const view = await open();
    // One listing, in the viewer's own environment; the office card lists
    // nothing (it would mix in the viewer's personal key).
    expect(fake.requests("POST", MODELS).map((call) => call.body)).toEqual([
      { cwd: "~" },
    ]);
    const mine = section(view, "personal");
    const free = row(mine, "free").textContent!;
    expect(free).toContain("Big Pickle");
    for (const label of ["Claude Sonnet", "Kimi", "GPT Mini", "Llama 3"])
      expect({ label, inFree: free.includes(label) }).toEqual({
        label,
        inFree: false,
      });
    const paid = row(mine, "paid");
    expect(paid.getAttribute("data-opencode-key")).toBe("set");
    expect(paid.getAttribute("data-opencode-key-source")).toBe(
      "member_variable",
    );
    // opencode/claude-sonnet, opencode-go/kimi, opencode/gpt-mini.
    expect(paid.getAttribute("data-opencode-paid-count")).toBe("3");
    expect(row(mine, "own-server").textContent).toContain("Llama 3");
  });

  it("gives no paid count without a key, even when the listing names paid models", async () => {
    fake.openCode = { freeLimitAt: null, keySource: null };
    fake.openCodeModels = MODELS_LISTED;
    const view = await open();
    const paid = row(section(view, "personal"), "paid");
    expect(paid.getAttribute("data-opencode-key")).toBe("none");
    expect(paid.hasAttribute("data-opencode-paid-count")).toBe(false);
    expect(row(section(view, "personal"), "free").textContent).toContain(
      "Big Pickle",
    );
  });

  // The route answers a failed listing with 200, no models and an error. That
  // is no answer about the models: no count of zero paid models.
  it("gives no paid count when the listing failed", async () => {
    fake.openCode = { freeLimitAt: null, keySource: "member_variable" };
    fake.openCodeModelsError = {
      error: "OpenCode did not start.",
      authError: true,
    };
    const view = await open();
    // The enabling reads answered: the key state is drawn.
    const paid = row(section(view, "personal"), "paid");
    expect(paid.getAttribute("data-opencode-key")).toBe("set");
    expect(fake.requests("POST", MODELS).length).toBeGreaterThan(0);
    expect(paid.hasAttribute("data-opencode-paid-count")).toBe(false);
    expect(held(section(view, "personal"))).toHaveLength(0);
  });

  it("links your own model server to its docs section on both cards", async () => {
    const view = await open();
    for (const which of ["office", "personal"] as const) {
      const link = row(section(view, which), "own-server").querySelector("a");
      expect({ which, href: link?.getAttribute("href") ?? null }).toEqual({
        which,
        href: "https://isomux.com/docs/llm-providers#opencode-on-your-own-model-server",
      });
    }
  });

  it("says when this host cannot run it", async () => {
    const view = await open({
      ...OWNER,
      unavailableEngines: { opencode: "needs_linux" },
    });
    expect(
      section(view, "office").querySelector("[data-opencode-unavailable]"),
    ).not.toBeNull();
  });
});

describe("the free limit", () => {
  const limit = (view: View, which: Which) =>
    row(section(view, which), "free").querySelector(
      "[data-opencode-free-limit]",
    );

  it("is on neither card when no agent met it lately", async () => {
    fake.openCode = { freeLimitAt: null, keySource: null };
    const view = await open();
    // The enabling read answered: the key state is drawn.
    expect(
      row(section(view, "personal"), "paid").getAttribute("data-opencode-key"),
    ).toBe("none");
    expect(limit(view, "office")).toBeNull();
    expect(limit(view, "personal")).toBeNull();
  });

  // With no key the way out is a key (or Claude or Codex); with one, a paid
  // model. Each card goes by its own key: the office's variable, the
  // viewer's agents' source.
  it("is on both cards, once each, and its advice follows each card's key", async () => {
    fake.openCode = {
      freeLimitAt: Date.now() - 10 * 60 * 1000,
      keySource: null,
    };
    officeKey();
    const view = await open();
    for (const which of ["office", "personal"] as const)
      expect({
        which,
        count: row(section(view, which), "free").querySelectorAll(
          "[data-opencode-free-limit]",
        ).length,
      }).toEqual({ which, count: 1 });
    expect(
      limit(view, "office")!.getAttribute("data-opencode-free-limit"),
    ).toBe("keyed");
    expect(
      limit(view, "personal")!.getAttribute("data-opencode-free-limit"),
    ).toBe("keyless");
  });

  it("tells a viewer whose agents use the office key to pick a paid model", async () => {
    fake.openCode = {
      freeLimitAt: Date.now() - 10 * 60 * 1000,
      keySource: "office_variable",
    };
    const view = await open();
    expect(
      limit(view, "personal")!.getAttribute("data-opencode-free-limit"),
    ).toBe("keyed");
  });
});

describe("the key, in place", () => {
  const edit = (root: Element) =>
    root.querySelector("[data-opencode-key-edit]");
  const remove = (root: Element) =>
    root.querySelector("[data-opencode-key-remove]");

  async function save(root: Element, value: string) {
    await click(edit(root));
    const panel = root.querySelector("[data-opencode-key-panel]")!;
    // A credential field, never a plain text box.
    const field = panel.querySelector("input[data-masked-credential]");
    expect(field).not.toBeNull();
    await type(field, value);
    await click(panel.querySelector("[data-panel-save]"));
  }

  it("adds the viewer's own key as their variable, with no note, and reads the state again", async () => {
    fake.openCode = { freeLimitAt: null, keySource: null };
    const view = await open();
    const mine = section(view, "personal");
    expect(row(mine, "paid").getAttribute("data-opencode-key")).toBe("none");
    // Nothing to remove yet.
    expect(remove(mine)).toBeNull();
    const [readsBefore, listingsBefore] = [gets(), listings()];
    fake.openCode = { freeLimitAt: null, keySource: "member_variable" };
    await save(mine, "sk-new-key");
    expect(
      fake.requests("PUT", /\/env\//).map(({ path, body }) => ({ path, body })),
    ).toEqual([
      { path: `/api/users/Ricky/env/${KEY}`, body: { value: "sk-new-key" } },
    ]);
    // A saved variable is announced, so the state and the models are read
    // again, and the row says so.
    expect(gets()).toBeGreaterThan(readsBefore);
    expect(listings()).toBeGreaterThan(listingsBefore);
    expect(mine.querySelector("[data-opencode-key-panel]")).toBeNull();
    expect(row(mine, "paid").getAttribute("data-opencode-key")).toBe("set");
  });

  it("removes the office key after a confirm, and an owner replaces it", async () => {
    officeKey();
    const view = await open();
    const office = section(view, "office");
    expect(row(office, "paid").getAttribute("data-opencode-key")).toBe("set");

    await save(office, "sk-office-next");
    expect(
      fake.requests("PUT", /\/env\//).map(({ path, body }) => ({ path, body })),
    ).toEqual([
      { path: `/api/office/env/${KEY}`, body: { value: "sk-office-next" } },
    ]);

    await click(remove(office));
    const confirm = office.querySelector("[data-opencode-remove-panel]")!;
    expect(confirm).not.toBeNull();
    expect(fake.requests("DELETE", /\/env\//)).toHaveLength(0);
    await click(confirm.querySelector("[data-panel-save]"));
    expect(fake.requests("DELETE", /\/env\//).map((call) => call.path)).toEqual(
      [`/api/office/env/${KEY}`],
    );
  });

  // A status read that fails says nothing about the key, but the row does
  // not stay held: the viewer can still add their own key. A failed re-read
  // after a good one does not keep the old key state either.
  it("keeps the key row usable when the status read fails", async () => {
    fake.openCode = { freeLimitAt: null, keySource: "member_variable" };
    fake.openCodeModels = MODELS_LISTED;
    const view = await open();
    const mine = section(view, "personal");
    // The enabling state: a good read drew the key state and the count.
    expect(row(mine, "paid").getAttribute("data-opencode-key")).toBe("set");
    expect(row(mine, "paid").hasAttribute("data-opencode-paid-count")).toBe(
      true,
    );

    fake.openCodeFails = true;
    await click(view.container.querySelector("[data-providers-refresh]"));
    expect(fake.requests("GET", ME).length).toBeGreaterThan(1);
    const paid = row(mine, "paid");
    expect(held(paid)).toHaveLength(0);
    expect(paid.hasAttribute("data-opencode-key")).toBe(false);
    expect(paid.hasAttribute("data-opencode-paid-count")).toBe(false);
    expect(paid.querySelector("[data-opencode-key-edit]")).not.toBeNull();
  });

  it("re-reads the state from the tab's Refresh", async () => {
    const view = await open();
    const before = gets();
    await click(view.container.querySelector("[data-providers-refresh]"));
    expect(gets()).toBeGreaterThan(before);
  });

  it("gives a member no key control on the office card, and one on their own", async () => {
    serve({ username: "Stephen", owner: false });
    officeKey();
    const view = await open(MEMBER);
    const office = section(view, "office");
    // The office card reached its key state.
    expect(row(office, "paid").getAttribute("data-opencode-key")).toBe("set");
    expect(edit(office)).toBeNull();
    expect(remove(office)).toBeNull();
    expect(edit(section(view, "personal"))).not.toBeNull();
  });
});

describe("an owner on another member's card", () => {
  const theirs = (view: View) =>
    card(view, "personal").querySelector<HTMLElement>(
      '[data-member-provider="opencode"]',
    )!;

  it("reads the member's key from their names, not the owner's, and sets it for them", async () => {
    // The owner's own agents have a key; Stephen has none.
    fake.openCode = { freeLimitAt: null, keySource: "office_variable" };
    const view = await open();
    const listed = listings();
    await pick(view, "Stephen");
    const stephen = theirs(view);
    expect(stephen).not.toBeNull();
    expect(
      stephen
        .querySelector("[data-opencode-key]")!
        .getAttribute("data-opencode-key"),
    ).toBe("none");
    // The owner's environment says nothing about the member's models.
    expect(listings()).toBe(listed);

    await click(stephen.querySelector("[data-opencode-key-edit]"));
    const panel = stephen.querySelector("[data-opencode-key-panel]")!;
    await type(panel.querySelector("input[data-masked-credential]"), "sk-st");
    await click(panel.querySelector("[data-panel-save]"));
    expect(
      fake.requests("PUT", /\/env\//).map(({ path, body }) => ({ path, body })),
    ).toEqual([
      { path: `/api/users/Stephen/env/${KEY}`, body: { value: "sk-st" } },
    ]);
    expect(
      theirs(view)
        .querySelector("[data-opencode-key]")!
        .getAttribute("data-opencode-key"),
    ).toBe("set");

    await click(theirs(view).querySelector("[data-opencode-key-remove]"));
    await click(
      theirs(view).querySelector(
        "[data-opencode-remove-panel] [data-panel-save]",
      ),
    );
    expect(fake.requests("DELETE", /\/env\//).map((call) => call.path)).toEqual(
      [`/api/users/Stephen/env/${KEY}`],
    );
  });
});
