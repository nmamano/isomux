import { beforeEach, describe, expect, it } from "bun:test";

// sessionStorage, as a browser tab has it.
const store = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
const { rememberSignIn, takeSignIn } = await import("./sign-in-return.ts");

describe("the MCP sign-in note", () => {
  beforeEach(() => store.clear());

  it("is read once", () => {
    rememberSignIn({
      server: "linear",
      target: { kind: "member", username: "Beth" },
    });
    expect(takeSignIn()).toEqual({
      server: "linear",
      target: { kind: "member", username: "Beth" },
    });
    expect(takeSignIn()).toBeNull();
  });

  it("goes stale after 15 minutes", () => {
    rememberSignIn({ server: "linear", target: { kind: "office" } });
    expect(takeSignIn(Date.now() + 16 * 60_000)).toBeNull();
  });

  it("refuses a note of another shape", () => {
    store.set(
      "isomux:mcpSignIn",
      JSON.stringify({ server: 1, at: Date.now() }),
    );
    expect(takeSignIn()).toBeNull();
    store.set(
      "isomux:mcpSignIn",
      JSON.stringify({
        server: "x",
        at: Date.now(),
        target: { kind: "member" },
      }),
    );
    expect(takeSignIn()).toBeNull();
    store.set("isomux:mcpSignIn", "{not json");
    expect(takeSignIn()).toBeNull();
  });
});
