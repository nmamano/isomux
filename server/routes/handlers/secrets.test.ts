// secrets.* handlers and the secrets runtime: the store write is the commit
// point. The runtime hears of every stored change, and a runtime failure
// never turns a stored change into an error answer.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secretsHandlers } from "./secrets.ts";
import { createSecretStore } from "../../secret-store.ts";
import type { HandlerResult, RouteHandlerContext } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import { USER_CAPABILITIES } from "../../identity/index.ts";

const identity: Identity = {
  scope: "user",
  userId: "u1",
  role: "owner",
  capabilities: USER_CAPABILITIES,
};

function ctx(body: unknown, name = ""): RouteHandlerContext {
  return {
    identity,
    params: { username: "boss", name },
    body,
    rawBody: "",
    query: new URLSearchParams(),
    req: new Request("http://localhost/"),
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function setup(onChanged: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "isomux-secrets-handlers-"));
  roots.push(root);
  return secretsHandlers({ store: createSecretStore(root), onChanged });
}

const BODY = {
  name: "GH_TOKEN",
  value: "ghp_FAKEhandlerFAKEhandlerFAKEhandle01",
  hosts: ["api.github.com"],
  form: { kind: "authorization" },
};

const kindOf = async (result: HandlerResult | Promise<HandlerResult>) =>
  (await result).kind;

describe("after a stored change", () => {
  it("the runtime hears of create, rotate, edit and delete, and not of a refused change", async () => {
    let calls = 0;
    const handlers = setup(async () => {
      calls++;
    });
    expect(await kindOf(handlers["secrets.create"](ctx(BODY)))).toBe("json");
    expect(
      await kindOf(
        handlers["secrets.rotate"](
          ctx({ value: "ghp_FAKErotatedFAKErotatedFAKErotate01" }, "GH_TOKEN"),
        ),
      ),
    ).toBe("json");
    expect(
      await kindOf(
        handlers["secrets.update"](
          ctx({ hosts: ["uploads.github.com"] }, "GH_TOKEN"),
        ),
      ),
    ).toBe("json");
    expect(
      await kindOf(handlers["secrets.delete"](ctx(undefined, "GH_TOKEN"))),
    ).toBe("noContent");
    expect(calls).toBe(4);
    // Refused: not stored, so nothing to tell.
    expect(
      await kindOf(handlers["secrets.delete"](ctx(undefined, "GH_TOKEN"))),
    ).toBe("error");
    expect(
      await kindOf(
        handlers["secrets.create"](ctx({ ...BODY, hosts: ["api.openai.com"] })),
      ),
    ).toBe("error");
    expect(calls).toBe(4);
  });

  it("a runtime failure still answers success, with a fixed log line", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) =>
      lines.push(args.map(String).join(" "));
    try {
      const handlers = setup(async () => {
        throw new Error(`push failed ${BODY.value}`);
      });
      const result = await handlers["officeSecrets.create"](ctx(BODY));
      expect(result.kind).toBe("json");
    } finally {
      console.error = original;
    }
    expect(lines.join("\n")).not.toContain(BODY.value);
    expect(lines.length).toBe(1);
  });
});
