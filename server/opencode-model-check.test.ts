// The check of each OpenCode agent's model against OpenCode's model list
// (task 73951c9f). The list holds only connected providers' models, so a
// model is gone only when its provider is in the list without it.

import { describe, expect, it } from "bun:test";
import {
  checkOpenCodeModels,
  type OpenCodeModelCheckAgent,
} from "./opencode-model-check.ts";

const agent = (
  id: string,
  modelFamily: string,
  userId: string | null = "user-a",
  cwd = "/work",
): OpenCodeModelCheckAgent => ({ id, userId, cwd, modelFamily });

const models = (...ids: string[]) => ids.map((id) => ({ id }));

describe("checkOpenCodeModels", () => {
  it("calls a model gone only when the list has its provider without it", async () => {
    const result = await checkOpenCodeModels(
      [
        agent("listed", "opencode/kept"),
        agent("gone", "opencode/removed"),
        // No anthropic model in the list: the provider is not connected now.
        agent("disconnected", "anthropic/claude"),
        // Only the Go twin is listed: another provider, not this model.
        agent("twin", "zen/model"),
      ],
      async () =>
        models("opencode/kept", "opencode-go/removed", "zen-go/model"),
    );
    expect(Object.fromEntries(result)).toEqual({
      listed: "listed",
      gone: "gone",
      disconnected: "unknown",
      twin: "unknown",
    });
  });

  it("says unknown for every agent of a listing that fails, and goes on with the next", async () => {
    const result = await checkOpenCodeModels(
      [
        agent("failed", "opencode/kept", "user-a"),
        agent("other-user", "opencode/removed", "user-b"),
      ],
      async (userId) => {
        if (userId === "user-a") throw new Error("OpenCode did not start");
        return models("opencode/kept");
      },
    );
    expect(Object.fromEntries(result)).toEqual({
      failed: "unknown",
      "other-user": "gone",
    });
  });

  it("lists once per manager and folder, one listing at a time", async () => {
    const calls: Array<[string | null, string]> = [];
    let running = 0;
    let most = 0;
    const result = await checkOpenCodeModels(
      [
        agent("a1", "opencode/kept", "user-a", "/one"),
        agent("a2", "opencode/kept", "user-a", "/one"),
        agent("a3", "opencode/kept", "user-a", "/two"),
        agent("b1", "opencode/kept", "user-b", "/one"),
        // An agent with no manager lists with the office environment.
        agent("n1", "opencode/kept", null, "/one"),
      ],
      async (userId, cwd) => {
        calls.push([userId, cwd]);
        running++;
        most = Math.max(most, running);
        await Bun.sleep(1);
        running--;
        // A project opencode.json can add models in one folder only.
        return cwd === "/two" && userId === "user-a"
          ? models("opencode/other")
          : models("opencode/kept");
      },
    );
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((call) => call.join("|")))).toEqual(
      new Set(["user-a|/one", "user-a|/two", "user-b|/one", "|/one"]),
    );
    expect(most).toBe(1);
    // Each agent reads its own group's list.
    expect(Object.fromEntries(result)).toEqual({
      a1: "listed",
      a2: "listed",
      a3: "gone",
      b1: "listed",
      n1: "listed",
    });
  });
});
