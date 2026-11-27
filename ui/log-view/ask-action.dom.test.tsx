// An action ask (task e3d1bc63): the card shows the target agent, its stop
// now (read live from the office state) and the stop asked for, and Apply
// runs it through POST /api/asks/:askId/action. A refusal shows on the card
// and the card stays; the ask closes only when the server closes it. The
// same AskCard is the Inbox's. This file holds the agent-access cards and
// the credential actions. ui/log-view/ask-action-member.dom.test.tsx holds a
// member's rooms and role, ui/log-view/ask-action-settings.dom.test.tsx the
// settings cards, and ui/test-support/ask-action-fixture.tsx the office.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { dataChips } from "../test-support/data-values.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { NOW, action, lineParts, memberAsk, mount, seeded } =
  await import("../test-support/ask-action-fixture.tsx");

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: string[] = [];
let answer: (path: string) => Promise<unknown> = async () => undefined;
// The answer to a GET (part 3: the office and backup settings a card reads).
let read: (path: string) => unknown = () => undefined;
beforeEach(() => {
  posts = [];
  answer = async () => undefined;
  read = () => undefined;
  setApiShim(async (method, path) => {
    if (method === "POST") {
      posts.push(path);
      return answer(path);
    }
    return read(path);
  });
});
afterAll(() => setApiShim(null));

it("shows the target, its stop now and the stop asked for, with Apply and no link", async () => {
  const { view, card, block, apply } = await mount();
  const b = block("act00001");
  expect(b).not.toBe(null);
  expect({
    current: b!.dataset.askActionCurrent,
    requested: b!.dataset.askActionRequested,
    self: b!.hasAttribute("data-ask-action-self"),
    gone: b!.hasAttribute("data-ask-action-gone"),
    names: b!.textContent!.includes("Curator"),
    apply: apply("act00001") !== null,
    link: card("act00001").querySelector("[data-ask-office-link]") !== null,
  }).toEqual({
    current: "standard",
    requested: "privileged",
    self: false,
    gone: false,
    names: true,
    apply: true,
    link: false,
  });
  // The asking agent's own grant is marked as such.
  expect(block("act00002")!.hasAttribute("data-ask-action-self")).toBe(true);
  expect(block("act00002")!.dataset.askActionRequested).toBe("office");
  view.unmount();
});

it("reads the target's stop live: a change in the office state shows on the card", async () => {
  const { view, block } = await mount();
  expect(block("act00001")!.dataset.askActionCurrent).toBe("standard");
  await act(async () => {
    seeded({
      type: "agent_updated",
      agentId: "t1",
      changes: { access: "office" },
    } as never);
  });
  expect(block("act00001")!.dataset.askActionCurrent).toBe("office");
  view.unmount();
});

it("a target the office state does not have: marked gone, no Apply", async () => {
  const { view, block, apply } = await mount();
  expect(block("act00003")!.hasAttribute("data-ask-action-gone")).toBe(true);
  expect(apply("act00003")).toBe(null);
  // Gone while the card is up.
  expect(apply("act00001")).not.toBe(null);
  await act(async () => {
    seeded({ type: "agent_removed", agentId: "t1" } as never);
  });
  expect(block("act00001")!.hasAttribute("data-ask-action-gone")).toBe(true);
  expect(apply("act00001")).toBe(null);
  view.unmount();
});

it("Apply posts the run once, is disabled while it runs, and the card stays until the server closes the ask", async () => {
  let release: () => void = () => {};
  answer = () =>
    new Promise((resolve) => (release = () => resolve({ agent: {} })));
  const { view, card, apply } = await mount();
  const button = apply("act00001")!;
  expect(button.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(button);
  });
  expect(posts).toEqual(["/api/asks/act00001/action"]);
  expect(apply("act00001")!.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(apply("act00001")!);
  });
  expect(posts).toHaveLength(1);
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  // The run does not close the ask: the server's ask_removed does.
  expect(card("act00001")).not.toBe(null);
  view.unmount();
});

it("a refused run shows the route's message on the card, the card stays, and Apply can go again", async () => {
  answer = async () => {
    throw new ApiError(
      422,
      "engine_below_standard",
      "This engine does not run that stop yet.",
    );
  };
  const { view, card, apply } = await mount();
  await act(async () => {
    fireEvent.click(apply("act00001")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/asks/act00001/action"]);
  expect(card("act00001")).not.toBe(null);
  expect(card("act00001").querySelector("[role=alert]")?.textContent).toContain(
    "This engine does not run that stop yet.",
  );
  expect(apply("act00001")!.disabled).toBe(false);
  view.unmount();
});

// Apply makes the change, so the reply field does not start with "done": a
// Reply sent as it stands would close the ask with nothing changed.
it("starts the reply field empty on an action ask", async () => {
  const { view, card } = await mount();
  const field = card("act00001").querySelector<HTMLTextAreaElement>(
    "[data-ask-reply-input]",
  );
  expect(field).not.toBe(null);
  expect(field!.value).toBe("");
  view.unmount();
});

// Task 82da687b: an ask stored before it can hold a step with a pack. Apply
// gives the stop's fixed grant, so the card is the card of the stop alone.
it("an agent-access card stored with a pack shows exactly the card of its stop", async () => {
  const hidden = {
    areas: { agents: "write", asks: "write", memory: "write" },
    rooms: ["r1"],
  };
  const { view, block } = await mount([
    action("pak00001", "t1", "web", hidden),
    action("pak00002", "t1", "web"),
  ]);
  const shape = (id: string) => block(id)!.innerHTML.replaceAll(id, "<id>");
  // The enabling condition: both cards are up, at the stop asked for.
  expect([
    block("pak00001")!.dataset.askActionRequested,
    block("pak00002")!.dataset.askActionRequested,
  ]).toEqual(["web", "web"]);
  expect(shape("pak00001")).toBe(shape("pak00002"));
  view.unmount();
});

// Part 4: the credential actions. A sign-in link or a token an Apply made is
// in the run's answer only; the ask closes as it is made, and the socket's
// ask_removed can come before that answer. The stack draws the result where
// the ask was until the member closes it.
const CRED_ACCESS = {
  hosted: false,
  externalAccess: false,
  publicOrigin: null,
  boundLoopback: true,
};
const credAsk = memberAsk;
const results = (view: { container: HTMLElement }) =>
  [...view.container.querySelectorAll<HTMLElement>("[data-ask-result]")].map(
    (el) => el.dataset.askResult,
  );

it.each([
  [
    "sign-in-link",
    { kind: "sign-in-link", userId: "u2" },
    { url: "https://office.example/i/RAWLINK1", invite: {} },
    "https://office.example/i/RAWLINK1",
    // Casey's link, made by Morgan: for Casey's device, not this one.
    false,
  ],
  [
    "api-token",
    { kind: "api-token", name: "deploy", expiresInDays: 30 },
    { token: "isx_RAWTOKEN1", apiToken: { id: "t1", name: "deploy" } },
    "isx_RAWTOKEN1",
    null,
  ],
  [
    "office-access",
    {
      kind: "office-access",
      externalAccess: true,
      publicOrigin: "https://office.example",
    },
    { signInUrl: "https://office.example/i/RAWLINK2", restartRequired: true },
    "https://office.example/i/RAWLINK2",
    // Morgan's own link at the new address.
    true,
  ],
] as const)(
  "a %s Apply whose answer comes after the ask closed: the stack shows the result until Close",
  async (_kind, step, body, value, forSelf) => {
    read = (path) => (path === "/api/office/access" ? CRED_ACCESS : undefined);
    let release: () => void = () => {};
    answer = () => new Promise((resolve) => (release = () => resolve(body)));
    const { view, apply } = await mount([credAsk("cred0001", step)]);
    await waitFor(() => expect(apply("cred0001")).not.toBe(null));
    await act(async () => {
      fireEvent.click(apply("cred0001")!);
    });
    expect(posts).toEqual(["/api/asks/cred0001/action"]);
    // The server closed the ask as the link was made.
    await act(async () => {
      seeded({ type: "ask_removed", id: "cred0001" });
    });
    expect(view.container.querySelector('[data-ask="cred0001"]')).toBe(null);
    expect(results(view)).toEqual([]);
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(results(view)).toEqual(["cred0001"]);
    const card = view.container.querySelector<HTMLElement>(
      '[data-ask-result="cred0001"]',
    )!;
    expect(card.textContent).toContain(value);
    // A link says whose device it is for.
    if (forSelf !== null)
      expect(card.hasAttribute("data-ask-result-for-self")).toBe(forSelf);
    await act(async () => {
      fireEvent.click(
        card.querySelector<HTMLButtonElement>("[data-ask-result-close]")!,
      );
    });
    expect(results(view)).toEqual([]);
    view.unmount();
  },
);

// The other order: the answer first, then the socket closes the ask.
it("a credential Apply whose answer comes before the ask closed: the result stays after the close", async () => {
  answer = async () => ({
    token: "isx_RAWTOKEN3",
    apiToken: { id: "t3", name: "deploy" },
  });
  const { view, apply } = await mount([
    credAsk("cred0006", {
      kind: "api-token",
      name: "deploy",
      expiresInDays: 30,
    }),
  ]);
  await act(async () => {
    fireEvent.click(apply("cred0006")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(results(view)).toEqual(["cred0006"]);
  await act(async () => {
    seeded({ type: "ask_removed", id: "cred0006" });
  });
  expect(view.container.querySelector('[data-ask="cred0006"]')).toBe(null);
  expect(results(view)).toEqual(["cred0006"]);
  view.unmount();
});

it("a refused credential Apply shows no result", async () => {
  answer = async () => {
    throw new ApiError(403, "forbidden", "No.");
  };
  const { view, apply } = await mount([
    credAsk("cred0002", { kind: "api-token", name: "x", expiresInDays: 30 }),
  ]);
  await act(async () => {
    fireEvent.click(apply("cred0002")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/asks/cred0002/action"]);
  expect(results(view)).toEqual([]);
  view.unmount();
});

it("a member-sessions card says Apply signs the member out here too only when the member is the one the ask is for", async () => {
  const { view, block } = await mount([
    // Morgan (u1) is the member the asks are for.
    credAsk("cred0003", { kind: "member-sessions", userId: "u1" }),
    credAsk("cred0004", { kind: "member-sessions", userId: "u2" }),
  ]);
  expect(
    ["cred0003", "cred0004"].map((id) =>
      block(id)!.hasAttribute("data-ask-action-signs-you-out"),
    ),
  ).toEqual([true, false]);
  view.unmount();
});

it("an office-access card shows the address asked for in full", async () => {
  read = (path) => (path === "/api/office/access" ? CRED_ACCESS : undefined);
  const origin = "https://office.example.co.uk:8443";
  const { view, block } = await mount([
    credAsk("cred0005", {
      kind: "office-access",
      externalAccess: true,
      publicOrigin: origin,
    }),
  ]);
  await waitFor(() => expect(block("cred0005")!.textContent).toContain(origin));
  view.unmount();
});

it("an api-token-revoke card names the token and its owner, for the member's own token and for another member's", async () => {
  read = (path) =>
    path === "/api/me/api-tokens"
      ? {
          apiTokens: [
            {
              id: "aaaa000000000001",
              name: "morgans-ci",
              tokenPrefix: "isx_aaaa",
              createdAt: NOW,
              expiresAt: null,
              lastUsedAt: null,
            },
          ],
        }
      : path === "/api/users/Casey/api-tokens"
        ? {
            apiTokens: [
              {
                id: "bbbb000000000002",
                name: "caseys-laptop",
                tokenPrefix: "isx_bbbb",
                createdAt: NOW,
                expiresAt: null,
                lastUsedAt: null,
              },
            ],
          }
        : undefined;
  const { view, block } = await mount([
    credAsk("cred0007", {
      kind: "api-token-revoke",
      tokenId: "aaaa000000000001",
      userId: "u1",
    }),
    credAsk("cred0008", {
      kind: "api-token-revoke",
      tokenId: "bbbb000000000002",
      userId: "u2",
    }),
  ]);
  await waitFor(() =>
    expect(block("cred0008")!.textContent).toContain("caseys-laptop"),
  );
  expect(block("cred0008")!.textContent).toContain("Casey");
  // The owner's name is data (task 7075171e).
  expect(dataChips(block("cred0008"))).toEqual(["Casey"]);
  await waitFor(() =>
    expect(block("cred0007")!.textContent).toContain("morgans-ci"),
  );
  view.unmount();
});

// Task 29a3cb9c: the button names what the tap does. A step that sets values
// keeps Apply; a step that makes or ends something has a label of its own.
// The table is keyed by every kind, so a new kind fails the type check here
// until it picks a side.
const { actionButtonKey } = await import("./AskActionBlock.tsx");
const { en } = await import("../../shared/i18n/en.ts");
type ActionStepRequest = import("../../shared/types.ts").ActionStepRequest;
const step = (s: Record<string, unknown>) => s as ActionStepRequest;
const BUTTON_CASES: Record<
  ActionStepRequest["kind"],
  { sets: boolean; steps: ActionStepRequest[] }
> = {
  "agent-access": { sets: true, steps: [step({ kind: "agent-access" })] },
  "member-pack": { sets: true, steps: [step({ kind: "member-pack" })] },
  "member-preferences": {
    sets: true,
    steps: [step({ kind: "member-preferences" })],
  },
  "member-view": { sets: true, steps: [step({ kind: "member-view" })] },
  "office-settings": { sets: true, steps: [step({ kind: "office-settings" })] },
  "backup-settings": { sets: true, steps: [step({ kind: "backup-settings" })] },
  "office-access": { sets: true, steps: [step({ kind: "office-access" })] },
  "storage-retention": {
    sets: true,
    steps: [step({ kind: "storage-retention" })],
  },
  "messaging-route": { sets: true, steps: [step({ kind: "messaging-route" })] },
  "whatsapp-route": { sets: true, steps: [step({ kind: "whatsapp-route" })] },
  "discord-route": { sets: true, steps: [step({ kind: "discord-route" })] },
  "sign-in-link": { sets: false, steps: [step({ kind: "sign-in-link" })] },
  "api-token": { sets: false, steps: [step({ kind: "api-token" })] },
  "member-sessions": {
    sets: false,
    steps: [step({ kind: "member-sessions" })],
  },
  "session-revoke": { sets: false, steps: [step({ kind: "session-revoke" })] },
  "sign-in-links-revoke": {
    sets: false,
    steps: [step({ kind: "sign-in-links-revoke" })],
  },
  "sign-in-link-extend": {
    sets: false,
    steps: [step({ kind: "sign-in-link-extend" })],
  },
  "member-avatar": { sets: true, steps: [step({ kind: "member-avatar" })] },
  "api-token-revoke": {
    sets: false,
    steps: [step({ kind: "api-token-revoke" })],
  },
  "member-room": {
    sets: false,
    steps: [
      step({ kind: "member-room", grant: true }),
      step({ kind: "member-room", grant: false }),
    ],
  },
  "member-role": {
    sets: false,
    steps: [
      step({ kind: "member-role", role: "owner" }),
      step({ kind: "member-role", role: "member" }),
    ],
  },
  "member-remove": { sets: false, steps: [step({ kind: "member-remove" })] },
  "member-restore": { sets: false, steps: [step({ kind: "member-restore" })] },
  "member-purge": { sets: false, steps: [step({ kind: "member-purge" })] },
  "instructions-line": {
    sets: false,
    steps: [step({ kind: "instructions-line" })],
  },
  "office-update": { sets: false, steps: [step({ kind: "office-update" })] },
  "storage-prune": { sets: false, steps: [step({ kind: "storage-prune" })] },
  "storage-compress": {
    sets: false,
    steps: [step({ kind: "storage-compress" })],
  },
  // Task 4088f164: turning a member's OS user on and off differ.
  "member-os-user": {
    sets: false,
    steps: [
      step({ kind: "member-os-user", on: true }),
      step({ kind: "member-os-user", on: false }),
    ],
  },
};
const label = (s: ActionStepRequest) =>
  `${s.kind}${"grant" in s ? `:${s.grant}` : ""}${"role" in s ? `:${s.role}` : ""}${"on" in s ? `:${s.on}` : ""}`;

it("a step that sets values keeps Apply; each step that makes or ends something has a label of its own", () => {
  const cases = Object.values(BUTTON_CASES);
  const setters = cases.filter((c) => c.sets).flatMap((c) => c.steps);
  const actions = cases.filter((c) => !c.sets).flatMap((c) => c.steps);
  // The enabling condition: both sides hold steps.
  expect([setters.length, actions.length]).toEqual([12, 20]);
  expect(
    setters
      .filter((s) => actionButtonKey(s) !== "asks.action.apply")
      .map(label),
  ).toEqual([]);
  // Not Apply, by key and by text (a new key whose text is "Apply" says
  // nothing new).
  expect(
    actions
      .filter(
        (s) =>
          actionButtonKey(s) === "asks.action.apply" ||
          en[actionButtonKey(s)] === en["asks.action.apply"],
      )
      .map(label),
  ).toEqual([]);
  // Each action its own label: grant and remove, owner and member differ.
  const texts = actions.map((s) => en[actionButtonKey(s)]);
  expect(new Set(texts).size).toBe(actions.length);
  // The office update, the storage steps and the link extend say what their
  // settings page says for the same action.
  expect(
    [
      { kind: "office-update" },
      { kind: "storage-prune" },
      { kind: "storage-compress" },
      { kind: "sign-in-link-extend" },
    ].map((s) => actionButtonKey(step(s))),
  ).toEqual([
    "settings.update.updateNow",
    "settings.storage.deletePermanently",
    "settings.storage.compress",
    "settings.invites.extend",
  ]);
});

it("the card's button shows the step's label: a sign-in link's is not Apply, an agent move's is", async () => {
  const signIn = step({ kind: "sign-in-link", userId: "u2" });
  const { view, apply } = await mount([
    action("btn00001", "t1", "web"),
    credAsk("btn00002", { kind: "sign-in-link", userId: "u2" }),
  ]);
  await waitFor(() => expect(apply("btn00002")).not.toBe(null));
  // The enabling condition: the two labels differ in this catalog.
  expect(en[actionButtonKey(signIn)]).not.toBe(en["asks.action.apply"]);
  expect([
    apply("btn00001")!.textContent,
    apply("btn00002")!.textContent,
  ]).toEqual([en["asks.action.apply"], en[actionButtonKey(signIn)]]);
  view.unmount();
});

// Task 8852553c: an extend card reads its link from the owners' invite list,
// live, and the extend is not destructive: Apply runs on the first click.
it("a sign-in-link-extend card names the member, shows the link's expiry now from the live invite list, and runs on the first click", async () => {
  const DAY = 86_400_000;
  const row = (expiresAt: number) => ({
    tokenPrefix: "AbCd1234",
    username: "Casey",
    role: "member",
    createdBy: "Morgan",
    createdAt: NOW - 4 * DAY,
    expiresAt,
    ...(expiresAt < NOW ? { expired: true } : {}),
    extendable: true,
  });
  read = (p) =>
    p === "/api/invites" ? { invites: [row(NOW - DAY)] } : undefined;
  const { view, block, apply } = await mount([
    credAsk("ext00001", {
      kind: "sign-in-link-extend",
      userId: "u2",
      tokenPrefix: "AbCd1234",
      expiresAt: NOW - DAY,
    }),
  ]);
  await waitFor(() =>
    expect(block("ext00001")!.dataset.askActionCurrent).toBeDefined(),
  );
  const expiredNow = block("ext00001")!.dataset.askActionCurrent;
  expect(block("ext00001")!.textContent).toContain("Casey");
  await act(async () => {
    seeded({ type: "invites_list", invites: [row(NOW + 3 * DAY)] } as never);
  });
  const extendedNow = block("ext00001")!.dataset.askActionCurrent;
  expect(extendedNow).toBeDefined();
  expect(extendedNow).not.toBe(expiredNow);
  await act(async () => {
    fireEvent.click(apply("ext00001")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual(["/api/asks/ext00001/action"]);
  // The link used, replaced or taken back: gone from the list, so the card
  // has nothing to extend and no button.
  expect(block("ext00001")!.hasAttribute("data-ask-action-gone")).toBe(false);
  await act(async () => {
    seeded({ type: "invites_list", invites: [] } as never);
  });
  expect(block("ext00001")!.hasAttribute("data-ask-action-gone")).toBe(true);
  expect(apply("ext00001")).toBe(null);
  view.unmount();
});

// Task 8e61bf71: while the invite list loads, the extend card shows the
// expiry the step stored at the create, so its line is drawn whole from the
// first frame and does not change when the list comes. An open ask's live
// expiry is the stored one (the ask closes when the link's expiry passes
// it). One live link and one expired link: each label branch. A third
// card's link is not in the loaded list: it turns gone only once the list
// has loaded, which proves the load in the run.
it("a sign-in-link-extend card shows the stored expiry while the invite list loads, and the loaded line is the same", async () => {
  const DAY = 86_400_000;
  const links = [
    { id: "ext00002", prefix: "Live1234", userId: "u2", at: NOW + DAY },
    { id: "ext00003", prefix: "Old12345", userId: "u3", at: NOW - DAY },
  ];
  const absent = {
    id: "ext00004",
    prefix: "Gone1234",
    userId: "u2",
    at: NOW + DAY,
  };
  let asked = 0;
  let release: (v: unknown) => void = () => {};
  read = (p) => {
    if (p !== "/api/invites") return undefined;
    asked++;
    return new Promise((r) => (release = r));
  };
  const { view, block } = await mount(
    [...links, absent].map((l) =>
      credAsk(l.id, {
        kind: "sign-in-link-extend",
        userId: l.userId,
        tokenPrefix: l.prefix,
        expiresAt: l.at,
      }),
    ),
  );
  const shown = () =>
    links.map((l) => {
      const b = block(l.id)!;
      return {
        current: b.dataset.askActionCurrent,
        from: b.querySelector("[data-ask-action-from]")?.textContent ?? "",
        parts: lineParts(b.firstElementChild!),
        loading: b.querySelectorAll("[data-ask-action-loading]").length,
        gone: b.hasAttribute("data-ask-action-gone"),
      };
    });
  const absentGone = () =>
    block(absent.id)!.hasAttribute("data-ask-action-gone");
  // The enabling condition: the list was asked for and has not come back.
  await waitFor(() => expect(asked).toBeGreaterThan(0));
  expect(absentGone()).toBe(false);
  const loading = shown();
  expect(loading.map((v) => ({ ...v, from: v.from !== "" }))).toEqual(
    links.map((l) => ({
      current: String(l.at),
      from: true,
      parts: ["text", "arrow", "text"],
      loading: 0,
      gone: false,
    })),
  );
  await act(async () => {
    release({
      invites: links.map((l) => ({
        tokenPrefix: l.prefix,
        username: l.userId === "u2" ? "Casey" : "Dana",
        role: "member",
        createdBy: "Morgan",
        createdAt: NOW - 4 * DAY,
        expiresAt: l.at,
        ...(l.at < NOW ? { expired: true } : {}),
        extendable: true,
      })),
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  // The list has loaded, and the line the card drew while it loaded still
  // holds, labels too: the stored expired link reads as the loaded row (the
  // server's expired flag) does.
  expect(absentGone()).toBe(true);
  expect(shown()).toEqual(loading);
  view.unmount();
});

// Task ee88b02c: a line whose value now is not read yet draws one dimmed
// block after its name, in place of "value now -> value asked", so nothing
// drawn moves when the value comes: the block goes and the whole tail
// appears. A card whose value now is in the office state (an agent's stop)
// draws its whole line at once.
it("a card that loads its value now draws one block after the name while it loads, then the whole line", async () => {
  let asked = 0;
  let release: (v: unknown) => void = () => {};
  read = (p) => {
    if (p !== "/api/sessions") return undefined;
    asked++;
    return new Promise((r) => (release = r));
  };
  const { view, block } = await mount([
    credAsk("load0001", { kind: "member-sessions", userId: "u2" }),
    action("load0002", "t1", "privileged"),
  ]);
  const head = () => block("load0001")!.firstElementChild!;
  // The enabling condition: the list was asked for and has not come back.
  await waitFor(() => expect(asked).toBeGreaterThan(0));
  expect(block("load0001")!.dataset.askActionCurrent).toBeUndefined();
  const name = head().firstElementChild!.textContent;
  expect(name).toContain("Casey");
  expect({
    parts: lineParts(head()),
    to: block("load0001")!.querySelector("[data-ask-action-to]") !== null,
  }).toEqual({ parts: ["loading"], to: false });
  await act(async () => {
    release({ sessions: [] });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(block("load0001")!.dataset.askActionCurrent).toBe("0");
  expect({
    name: head().firstElementChild!.textContent,
    parts: lineParts(head()),
    loading: block("load0001")!.querySelectorAll("[data-ask-action-loading]")
      .length,
  }).toEqual({ name, parts: ["text", "arrow", "text"], loading: 0 });
  expect(lineParts(block("load0002")!.firstElementChild!)).toEqual([
    "text",
    "arrow",
    "text",
  ]);
  view.unmount();
});
