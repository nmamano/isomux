// secrets.* handlers and the secrets runtime: the store write is the commit
// point. The runtime hears of every stored change, and a runtime failure
// never turns a stored change into an error answer.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secretsHandlers } from "./secrets.ts";
import { createSecretStore } from "../../secret-store.ts";
import { placeholderFor } from "../../secret-proxy/placeholders.ts";
import type { HandlerResult, RouteHandlerContext } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import { USER_CAPABILITIES } from "../../identity/index.ts";

const identity: Identity = {
  scope: "user",
  userId: "u1",
  role: "owner",
  capabilities: USER_CAPABILITIES,
};

// "morgan" is u1, the caller.
const SUBJECT = {
  userIdForUsername: (username: string) =>
    username === "morgan" ? "u1" : null,
  isOfficeOwnerUserId: () => true,
  auditReveal: () => {},
};

function ctx(body: unknown, name = ""): RouteHandlerContext {
  return {
    identity,
    params: { username: "morgan", name },
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
  return secretsHandlers({
    store: createSecretStore(root),
    onChanged,
    ...SUBJECT,
  });
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

describe("reissue", () => {
  it("raises the generation, so the placeholder changes and the value stays", async () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-secrets-reissue-"));
    roots.push(root);
    const store = createSecretStore(root);
    let calls = 0;
    const handlers = secretsHandlers({
      store,
      onChanged: async () => {
        calls++;
      },
      ...SUBJECT,
    });
    await handlers["secrets.create"](ctx(BODY));
    const scope = { kind: "user", userId: "u1" } as const;
    const key = Buffer.alloc(32, 7);
    const before = store.readForProxy(scope)[0];
    const result = await handlers["secrets.reissue"](
      ctx(undefined, "GH_TOKEN"),
    );
    expect(result.kind).toBe("json");
    expect(JSON.stringify(result)).not.toContain(BODY.value);
    const after = store.readForProxy(scope)[0];
    expect(after.generation).toBe(before.generation + 1);
    expect(after.value).toBe(BODY.value);
    expect(
      placeholderFor(key, scope, "GH_TOKEN", after.generation, after.value),
    ).not.toBe(
      placeholderFor(key, scope, "GH_TOKEN", before.generation, before.value),
    );
    // Create and reissue: the runtime marks the scope for both.
    expect(calls).toBe(2);
  });

  it("refuses an unknown name and a body, and tells the runtime nothing", async () => {
    let calls = 0;
    const handlers = setup(async () => {
      calls++;
    });
    expect(
      await kindOf(handlers["secrets.reissue"](ctx(undefined, "NOPE"))),
    ).toBe("error");
    await handlers["secrets.create"](ctx(BODY));
    expect(
      await kindOf(
        handlers["secrets.reissue"](ctx({ value: "x" }, "GH_TOKEN")),
      ),
    ).toBe("error");
    expect(calls).toBe(1);
  });
});

describe("Show", () => {
  // The row comes first: a Show that cannot be recorded returns no value.
  it("answers 500 with no value when the audit row fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-secrets-reveal-"));
    roots.push(root);
    const handlers = secretsHandlers({
      store: createSecretStore(root),
      onChanged: async () => {},
      ...SUBJECT,
      auditReveal: () => {
        throw new Error("audit store down");
      },
    });
    await handlers["secrets.create"](ctx(BODY));
    await handlers["officeSecrets.create"](ctx(BODY));
    for (const opId of ["secrets.reveal", "officeSecrets.reveal"]) {
      const result = await handlers[opId](ctx(undefined, "GH_TOKEN"));
      expect([
        opId,
        result.kind,
        result.kind === "error" && result.status,
      ]).toEqual([opId, "error", 500]);
      expect(result).toEqual(expect.objectContaining({ code: "audit_failed" }));
      // A bytes body is decoded, so a leaked value would show here.
      const sent =
        result.kind === "bytes"
          ? new TextDecoder().decode(result.body)
          : JSON.stringify(result);
      expect(sent).not.toContain(BODY.value);
    }
  });
});
