// The previous manager's pass-on card (task 65bfe3a8), over the secret
// request core's test office.

import { afterEach, describe, expect, it } from "bun:test";

import { askVisibleTo } from "./asks.ts";
import type { SecretScope } from "./secret-store.ts";
import {
  code,
  failure,
  GONE,
  opened,
  outcomes,
  removeSetupRoots,
  setup,
  VALUE,
  type App,
} from "./test-support/secret-requests-fixture.ts";

afterEach(removeSetupRoots);

// The previous manager's pass-on card (task 65bfe3a8): at a manager change,
// each secret a moved app lost in the previous manager's secrets is asked of
// the new manager (cf032293) AND offered by the previous manager. Approve
// copies the value into the new manager's secrets with the app's grant; the
// previous manager keeps theirs. A save of the new manager's request closes
// the card; a decline of either side closes only that side. Only the
// previous manager, as a person, approves.
describe("a pass-on card", () => {
  const GAME = { name: "game", createdAt: 1000 };
  const OTHER = { name: "other", createdAt: 3000 };
  const NEW_VALUE = "ghp_FAKEnewmanagerFAKEnewmanagerFAKE0001";
  const alice = { kind: "user", userId: "u-alice" } as const;
  const bob = { kind: "user", userId: "u-bob" } as const;
  const reasonFor = (app: string, name: string) => `ask-again:${app}:${name}`;
  const passOnReasonFor = (app: string, name: string) =>
    `pass-on:${app}:${name}`;
  type T = ReturnType<typeof setup>;
  type Entry = ReturnType<T["asks"]["listAll"]>[number];
  const cardOf = (t: T, name: string): Entry | undefined =>
    t.asks
      .listAll()
      .find((e) => e.secret?.kind === "pass-on" && e.secret.name === name);
  const pairOf = (t: T, name: string, member = "u-bob"): Entry | undefined =>
    t.asks
      .listAll()
      .find(
        (e) =>
          e.secret?.kind === undefined &&
          e.secret?.name === name &&
          e.memberUserId === member,
      );
  // The open card, or a red line that says none opened.
  const theCard = (t: T, name: string): Entry => {
    const card = cardOf(t, name);
    if (!card) throw new Error(`no open pass-on card for ${name}`);
    return card;
  };
  const passOnCards = (t: T) =>
    t.asks.listAll().filter((e) => e.secret?.kind === "pass-on");
  const valued = (t: T, scope: SecretScope, name: string) =>
    t.store.readForProxy(scope).find((s) => s.name === name);

  // The previous manager (`from`) holds GAME_KEY for two apps and a host;
  // the agent a1 and the app "game" move to Bob, as the office does it:
  // release the grant, move the records, then moveToManager.
  function passing(
    from = "u-alice",
    source: Record<string, unknown> = {
      name: "GAME_KEY",
      value: VALUE,
      hosts: ["api.example.com"],
      form: { kind: "header", header: "x-api-key" },
      apps: [GAME, OTHER],
    },
  ) {
    const agents: Record<string, string | null> = { a1: from };
    const apps: Record<string, App> = {
      game: { createdAt: GAME.createdAt, userId: from },
      other: { createdAt: OTHER.createdAt, userId: from },
    };
    const t = setup(agents, apps);
    const scope = { kind: "user", userId: from } as const;
    const made = t.store.create(scope, source);
    if (!made.ok) throw new Error(`source not created: ${made.kind}`);
    const move = (to = "u-bob", previous = from) => {
      const names = t.store.releaseApp(previous, GAME);
      agents.a1 = to;
      apps.game.userId = to;
      return t.requests.moveToManager("a1", previous, {
        moved: [GAME],
        released: [{ app: "game", names }],
        reasonFor,
        passOnReasonFor,
      });
    };
    return { t, agents, apps, move, name: source.name as string };
  }
  const approve = (t: T, card: Entry, userId = "u-alice") =>
    t.requests.save(userId, "a1", card.secret!.requestId, {}, undefined, true);

  it("the move asks the new manager and opens one card for the previous manager, paired with that request", () => {
    const { t, move } = passing();
    const result = move();
    expect(result.reopened).toEqual([{ name: "GAME_KEY", app: "game" }]);
    expect(result.passOn).toEqual([{ name: "GAME_KEY", app: "game" }]);
    const pair = pairOf(t, "GAME_KEY");
    const card = cardOf(t, "GAME_KEY");
    expect(pair).toBeDefined();
    expect(card).toMatchObject({
      agentId: "a1",
      memberUserId: "u-alice",
      secret: {
        kind: "pass-on",
        scope: "personal",
        name: "GAME_KEY",
        app: GAME,
        ownerUserId: "u-alice",
        toUserId: "u-bob",
        pairRequestId: pair!.secret!.requestId,
        reason: passOnReasonFor("game", "GAME_KEY"),
      },
    });
    expect(card!.secret!.requestId).not.toBe(pair!.secret!.requestId);
    expect(passOnCards(t)).toHaveLength(1);
    // The previous manager sees it; the new manager answers the pair.
    expect(askVisibleTo(card!, "u-alice", t.audience)).toBe(true);
    expect(askVisibleTo(pair!, "u-bob", t.audience)).toBe(true);
  });

  it("an agent cannot open a pass-on card", () => {
    const { t } = passing();
    const before = t.asks.listAll().length;
    const result = t.requests.open("a1", {
      kind: "pass-on",
      name: "GAME_KEY",
      app: "game",
      reason: "Give it to me.",
    });
    expect(result.ok).toBe(false);
    expect(t.asks.listAll()).toHaveLength(before);
  });

  it("Approve copies the value into the new manager's secrets with the app's grant and no hosts; the previous manager keeps theirs; both cards close", async () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    const pairId = pairOf(t, "GAME_KEY")!.secret!.requestId;
    const kept = t.store.readForProxy(alice);
    const changes = t.changes();

    expect(await approve(t, card)).toEqual({ ok: true, name: "GAME_KEY" });

    // What the moved app reads: its owner's secret granted to it, same value.
    expect(valued(t, bob, "GAME_KEY")).toMatchObject({
      value: VALUE,
      hosts: [],
      form: { kind: "header", header: "x-api-key" },
      apps: [GAME],
    });
    // The old copy is untouched: value, host, and the other app's grant.
    expect(t.store.readForProxy(alice)).toEqual(kept);
    expect(valued(t, alice, "GAME_KEY")).toMatchObject({
      hosts: ["api.example.com"],
      apps: [OTHER],
    });
    expect(cardOf(t, "GAME_KEY")).toBeUndefined();
    expect(pairOf(t, "GAME_KEY")).toBeUndefined();
    expect(t.changes()).toBe(changes + 1);
    expect(outcomes(t)).toContainEqual([
      "a1",
      card.secret!.requestId,
      "saved",
      "u-alice",
    ]);

    // The second answer does nothing.
    expect(
      code(await t.requests.save("u-bob", "a1", pairId, { value: NEW_VALUE })),
    ).toBe("not_found");
    expect(code(await approve(t, card))).toBe("not_found");
    expect(valued(t, bob, "GAME_KEY")?.value).toBe(VALUE);
    expect(t.changes()).toBe(changes + 1);
  });

  it("the new manager saves first: the card closes and a later Approve copies nothing", async () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    const pairId = pairOf(t, "GAME_KEY")!.secret!.requestId;
    expect(
      await t.requests.save("u-bob", "a1", pairId, { value: NEW_VALUE }),
    ).toEqual({ ok: true, name: "GAME_KEY" });
    expect(cardOf(t, "GAME_KEY")).toBeUndefined();

    expect((await approve(t, card)).ok).toBe(false);
    expect(valued(t, bob, "GAME_KEY")?.value).toBe(NEW_VALUE);
    expect(
      t.settled.filter((s) => s.requestId === card.secret!.requestId),
    ).toEqual([]);
  });

  it("the previous manager declines: only the card closes, and the new manager's request stays", () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    const pair = pairOf(t, "GAME_KEY")!;
    expect(
      code(t.requests.decline("u-alice", "a1", card.secret!.requestId)),
    ).toBe("ok");
    expect(cardOf(t, "GAME_KEY")).toBeUndefined();
    expect(pairOf(t, "GAME_KEY")).toEqual(pair);
    expect(t.store.list(bob)).toEqual([]);
  });

  it("the new manager declines: the card stays, and Approve still gives the app the value", async () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    const pairId = pairOf(t, "GAME_KEY")!.secret!.requestId;
    expect(code(t.requests.decline("u-bob", "a1", pairId))).toBe("ok");
    expect(cardOf(t, "GAME_KEY")).toEqual(card);

    expect(code(await approve(t, card))).toBe("ok");
    expect(valued(t, bob, "GAME_KEY")).toMatchObject({
      value: VALUE,
      apps: [GAME],
    });
  });

  it("a value of that name in the new manager's secrets since the move is never replaced: secret_exists, and the card closes", async () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    expect(
      t.store.create(bob, {
        name: "GAME_KEY",
        value: NEW_VALUE,
        hosts: ["api.example.com"],
        form: { kind: "authorization" },
      }).ok,
    ).toBe(true);
    const changes = t.changes();
    expect(failure(await approve(t, card))).toBe("409 secret_exists");
    expect(valued(t, bob, "GAME_KEY")).toMatchObject({
      value: NEW_VALUE,
      hosts: ["api.example.com"],
    });
    expect(valued(t, bob, "GAME_KEY")?.apps).toBeUndefined();
    expect(cardOf(t, "GAME_KEY")).toBeUndefined();
    expect(t.changes()).toBe(changes);
  });

  it("any other refusal of the copy keeps the card open and writes nothing", async () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    // The office gives the app the same name since the move: a clash.
    expect(
      t.store.create(
        { kind: "office" },
        {
          name: "GAME_KEY",
          value: NEW_VALUE,
          hosts: [],
          form: { kind: "authorization" },
          apps: [GAME],
        },
      ).ok,
    ).toBe(true);
    const result = await approve(t, card);
    expect(result.ok).toBe(false);
    expect(code(result)).not.toBe("secret_exists");
    expect(t.store.list(bob)).toEqual([]);
    expect(cardOf(t, "GAME_KEY")).toEqual(card);
  });

  it("only the previous manager approves, as a person, with an empty body", async () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    const requestId = card.secret!.requestId;
    const refused = [
      // An office owner on the member's behalf, and the new manager.
      failure(await approve(t, card, "u-owner")),
      failure(await approve(t, card, "u-bob")),
      // The previous manager, not as a person: by default and explicitly.
      failure(await t.requests.save("u-alice", "a1", requestId, {})),
      failure(
        await t.requests.save("u-alice", "a1", requestId, {}, undefined, false),
      ),
    ];
    expect(refused).toEqual([
      "403 forbidden",
      "403 forbidden",
      "403 forbidden",
      "403 forbidden",
    ]);
    expect(
      failure(
        await t.requests.save(
          "u-alice",
          "a1",
          requestId,
          { value: NEW_VALUE },
          undefined,
          true,
        ),
      ),
    ).toBe("400 invalid_request");
    expect(t.store.list(bob)).toEqual([]);
    expect(cardOf(t, "GAME_KEY")).toEqual(card);
    expect(code(await approve(t, card))).toBe("ok");
  });

  it("a source with a token exchange: the app gets the same value; the copy has no hosts, so no exchange", async () => {
    const { t, move } = passing("u-alice", {
      name: "WECOM_APP",
      value: VALUE,
      hosts: ["qyapi.example.com"],
      form: { kind: "query", param: "access_token" },
      exchange: {
        url: "https://qyapi.example.com/cgi-bin/gettoken",
        body: { kind: "oauth", clientAuth: "body" },
        id: "fake-corp-id",
        params: {},
        tokenField: "access_token",
        expiryField: "expires_in",
      },
      apps: [GAME],
    });
    move();
    const card = theCard(t, "WECOM_APP");
    expect(code(await approve(t, card))).toBe("ok");
    const copy = valued(t, bob, "WECOM_APP");
    expect(copy).toMatchObject({ value: VALUE, hosts: [], apps: [GAME] });
    expect(copy?.exchange).toBeUndefined();
    expect(valued(t, alice, "WECOM_APP")?.exchange).toBeDefined();
  });

  it("no card when the previous manager was removed, cannot see the agent's room, or the new manager already holds the name", () => {
    const fromGone = passing(GONE);
    expect(fromGone.move().passOn).toEqual([]);
    expect(passOnCards(fromGone.t)).toEqual([]);
    expect(pairOf(fromGone.t, "GAME_KEY")).toBeDefined();

    // Eve cannot reach the agents' room (setup's audience).
    const fromEve = passing("u-eve");
    expect(fromEve.move().passOn).toEqual([]);
    expect(passOnCards(fromEve.t)).toEqual([]);
    expect(pairOf(fromEve.t, "GAME_KEY")).toBeDefined();

    const held = passing();
    expect(
      held.t.store.create(bob, {
        name: "GAME_KEY",
        value: NEW_VALUE,
        hosts: ["api.example.com"],
        form: { kind: "authorization" },
      }).ok,
    ).toBe(true);
    const result = held.move();
    expect(result.notReopened).toEqual([
      { name: "GAME_KEY", app: "game", code: "secret_exists" },
    ]);
    expect(result.passOn).toEqual([]);
    expect(passOnCards(held.t)).toEqual([]);

    // The agent's own open request for the app, for a name the previous
    // manager never held: asked of the new manager again, nothing to pass on.
    const asked = passing();
    opened(
      asked.t.requests.open("a1", {
        name: "NEW_KEY",
        app: "game",
        reason: "The game needs a new key.",
      }),
    );
    const again = asked.move();
    expect(again.reopened).toContainEqual({ name: "NEW_KEY", app: "game" });
    expect(again.passOn).toEqual([{ name: "GAME_KEY", app: "game" }]);
    expect(passOnCards(asked.t).map((e) => e.secret!.name)).toEqual([
      "GAME_KEY",
    ]);
  });

  it("a later move withdraws the pair and with it the card; nothing is copied", async () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    // The agent and the app move on to Carol: Bob's request goes to her.
    const result = move("u-carol", "u-bob");
    expect(result.reopened).toEqual([{ name: "GAME_KEY", app: "game" }]);
    expect(passOnCards(t)).toEqual([]);
    expect(pairOf(t, "GAME_KEY", "u-carol")).toBeDefined();
    expect((await approve(t, card)).ok).toBe(false);
    expect(t.store.list(bob)).toEqual([]);
    expect(t.store.list({ kind: "user", userId: "u-carol" })).toEqual([]);
  });

  it("survives a restart: the next boot loads the card and its Approve copies", async () => {
    const { t, move } = passing();
    move();
    const card = theCard(t, "GAME_KEY");
    const next = t.boot();
    expect(
      next.asks.listAll().find((e) => e.secret?.kind === "pass-on"),
    ).toEqual(card);
    expect(
      await next.requests.save(
        "u-alice",
        "a1",
        card.secret!.requestId,
        {},
        undefined,
        true,
      ),
    ).toEqual({ ok: true, name: "GAME_KEY" });
    expect(valued(t, bob, "GAME_KEY")).toMatchObject({
      value: VALUE,
      apps: [GAME],
    });
  });
});
