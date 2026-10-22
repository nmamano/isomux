// The asks.reply and asks.dismiss handlers against a delivery the test holds
// open. The office's own delivery reaches its acceptance decision without a
// step a test can hold, so the double-send guard is proven here, where the
// second request can land while the first is still in flight.

import { describe, expect, it } from "bun:test";

import { askHandlers, type AsksDeps } from "./asks.ts";
import { createAskStore } from "../../asks.ts";
import type { RouteHandlerContext } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import { USER_CAPABILITIES } from "../../identity/index.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";

const member: Identity = {
  scope: "user",
  userId: "u1",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

function rig() {
  const store = createAskStore({
    persistence: {
      load: () => ({ kind: "missing" }),
      save: () => {},
      quarantine: () => true,
    },
  });
  const held: Array<(result: UserSendAcceptance) => void> = [];
  const delivered: string[] = [];
  const deps: AsksDeps = {
    store,
    agent: () => ({ roomId: "r1", managerUserId: "u1" }),
    memberByName: () => null,
    memberName: () => "pat",
    memberCanSeeRoom: () => true,
    isOfficeOwner: () => false,
    affordances: {
      checkCommand: () => ({ ok: true }) as never,
      probeEditFile: () => null,
      probeReadFile: () => null,
      copyReadFile: () => null,
    },
    deliver: (_identity, _entry, text) => {
      delivered.push(text);
      return new Promise((resolve) => held.push(resolve));
    },
  };
  const handlers = askHandlers(deps);
  const made = store.create({
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Who gives the toast?",
  });
  if (!made.ok) throw new Error(made.code);
  const { entry } = made;
  const ctx = (text?: string): RouteHandlerContext => ({
    identity: member,
    params: { askId: entry.id },
    body: text === undefined ? {} : { text },
    rawBody: "",
    query: new URLSearchParams(),
    req: new Request("http://localhost/"),
  });
  const outcome = async (pending: ReturnType<(typeof handlers)[string]>) => {
    const r = await pending;
    return r.kind === "error" ? `${r.status} ${r.code}` : r.kind;
  };
  return { store, entry, handlers, ctx, held, delivered, outcome };
}

describe("an answer in flight", () => {
  it("refuses a second reply or dismiss while the first is being delivered, and sends once", async () => {
    const { store, entry, handlers, ctx, held, delivered, outcome } = rig();
    const first = outcome(handlers["asks.reply"](ctx("Dwight")));
    await Promise.resolve();
    // The first delivery is held open: the guard, not a closed ask, answers.
    expect(delivered).toEqual(["Dwight"]);
    expect(store.get(entry.id)).not.toBeNull();
    const again = outcome(handlers["asks.reply"](ctx("Dwight")));
    const dismissed = outcome(handlers["asks.dismiss"](ctx()));
    // Checked before awaiting them: a second delivery would wait forever on
    // the held promise.
    expect(delivered).toHaveLength(1);
    expect(await again).toBe("409 ask_busy");
    expect(await dismissed).toBe("409 ask_busy");

    held[0]({ ok: true });
    expect(await first).toBe("noContent");
    expect(store.get(entry.id)).toBeNull();
  });

  it("lets the member answer again when the delivery is refused", async () => {
    const { store, entry, handlers, ctx, held, delivered, outcome } = rig();
    const first = outcome(handlers["asks.reply"](ctx("Dwight")));
    await Promise.resolve();
    held[0]({ ok: false, status: 429, code: "usage_cap", message: "capped" });
    expect(await first).toBe("429 usage_cap");
    expect(store.get(entry.id)).not.toBeNull();

    const retry = outcome(handlers["asks.reply"](ctx("Jim")));
    await Promise.resolve();
    expect(delivered).toEqual(["Dwight", "Jim"]);
    held[1]({ ok: true });
    expect(await retry).toBe("noContent");
  });
});
