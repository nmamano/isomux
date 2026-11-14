// A secret with a token exchange (task 124eb47e) through the secrets
// handlers and the real store: what saves, what persists, and what an agent
// may not change on a saved secret. The raw app secret goes to the token
// address, and the query form puts the token in a web address, so after a
// save only a human moves either.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secretsHandlers } from "./secrets.ts";
import { createSecretStore } from "../../secret-store.ts";
import type { HandlerResult, RouteHandlerContext } from "../executor.ts";
import {
  PRIVILEGED_AGENT_CAPABILITIES,
  USER_CAPABILITIES,
  type Identity,
} from "../../identity/index.ts";
import {
  SECRET_EXCHANGE_CHANGE_REFUSED,
  type ExchangeSpec,
} from "../../../shared/secret-hosts.ts";

const HUMAN: Identity = {
  scope: "user",
  userId: "u1",
  role: "owner",
  capabilities: USER_CAPABILITIES,
};
const AGENT: Identity = {
  scope: "agent",
  userId: "u1",
  agentId: "agent-1",
  capabilities: PRIVILEGED_AGENT_CAPABILITIES,
} as Identity;

const SUBJECT = {
  userIdForUsername: (username: string) =>
    username === "morgan" ? "u1" : null,
  isOfficeOwnerUserId: () => true,
  auditReveal: () => {},
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "isomux-secrets-exchange-"));
  roots.push(root);
  const handlers = secretsHandlers({
    store: createSecretStore(root),
    onChanged: async () => {},
    ...SUBJECT,
  });
  const as =
    (identity: Identity) =>
    (
      op: keyof typeof handlers,
      body: unknown,
      name = "",
    ): Promise<HandlerResult> =>
      Promise.resolve(
        handlers[op]({
          identity,
          params: { username: "morgan", name },
          body,
          rawBody: "",
          query: new URLSearchParams(),
          req: new Request("http://localhost/"),
        } as RouteHandlerContext),
      );
  return { root, human: as(HUMAN), agent: as(AGENT) };
}

const EXCHANGE: ExchangeSpec = {
  url: "https://open.example.com/open-apis/auth/v3/tenant_access_token/internal",
  body: { kind: "json", idField: "app_id", secretField: "app_secret" },
  id: "cli_fake0001",
  params: {},
  tokenField: "tenant_access_token",
  expiryField: "expire",
};
const BODY = {
  name: "FEISHU_APP",
  value: "fake-feishu-app-secret-0001",
  hosts: ["open.example.com", "api.example.com"],
  form: { kind: "authorization" },
  exchange: EXCHANGE,
};
const QUERY_BODY = {
  ...BODY,
  name: "WECOM_APP",
  form: { kind: "query" as const, param: "access_token" },
};

const errorOf = (result: HandlerResult): Record<string, unknown> =>
  result.kind === "error"
    ? { status: result.status, code: result.code, ...result.detail }
    : { kind: result.kind };
const secretOf = (result: HandlerResult) =>
  result.kind === "json"
    ? (result.body as { secret: Record<string, unknown> }).secret
    : null;
async function listed(t: ReturnType<typeof setup>, name: string) {
  const result = await t.human("secrets.list", undefined);
  const { secrets } = (result as { body: { secrets: { name: string }[] } })
    .body;
  return secrets.find((s) => s.name === name) as
    Record<string, unknown> | undefined;
}

describe("saving a token exchange", () => {
  it("saves, lists and reloads the exchange, with its defaults filled", async () => {
    const t = setup();
    const { tokenField, expiryField, params, ...bare } = EXCHANGE;
    void tokenField;
    void expiryField;
    void params;
    const created = await t.human("secrets.create", {
      ...BODY,
      name: "OAUTH_APP",
      exchange: {
        ...bare,
        body: { kind: "oauth", clientAuth: "body" },
      },
    });
    expect(secretOf(created)?.exchange).toEqual({
      ...bare,
      body: { kind: "oauth", clientAuth: "body" },
      params: {},
      tokenField: "access_token",
      expiryField: "expires_in",
    });
    expect(secretOf(await t.human("secrets.create", QUERY_BODY))?.form).toEqual(
      QUERY_BODY.form,
    );
    // A new store over the same files: what the next boot reads.
    const values = createSecretStore(t.root).readSecretValues(
      { kind: "user", userId: "u1" },
      "WECOM_APP",
    );
    expect(values).toEqual({
      value: BODY.value,
      hosts: [...BODY.hosts].sort(),
      form: QUERY_BODY.form,
      exchange: EXCHANGE,
    });
    expect((await listed(t, "WECOM_APP"))?.exchange).toEqual(EXCHANGE);
    // The list never carries the value.
    expect(
      JSON.stringify(await t.human("secrets.list", undefined)),
    ).not.toContain(BODY.value);
  });

  it("refuses a token address off the hosts, an exchange without hosts, and the query form without an exchange", async () => {
    const t = setup();
    expect(
      errorOf(
        await t.human("secrets.create", {
          ...BODY,
          hosts: ["api.example.com"],
        }),
      ),
    ).toEqual({
      status: 400,
      code: "invalid_secret",
      field: "exchange",
      reason: "host",
    });
    expect(
      errorOf(await t.human("secrets.create", { ...BODY, hosts: [] })),
    ).toMatchObject({ status: 400, code: "invalid_secret" });
    const { exchange, ...plain } = QUERY_BODY;
    void exchange;
    expect(errorOf(await t.human("secrets.create", plain))).toMatchObject({
      status: 400,
      code: "invalid_secret",
      field: "form",
    });
    expect(await listed(t, "FEISHU_APP")).toBeUndefined();
    expect(await listed(t, "WECOM_APP")).toBeUndefined();
  });

  it("an agent may create one: it typed the value", async () => {
    const t = setup();
    expect((await t.agent("secrets.create", QUERY_BODY)).kind).toBe("json");
    expect((await listed(t, "WECOM_APP"))?.exchange).toEqual(EXCHANGE);
  });
});

describe("an agent on a saved secret", () => {
  const refused = {
    status: 403,
    code: SECRET_EXCHANGE_CHANGE_REFUSED,
  };

  it("may not add, change or remove the exchange", async () => {
    const t = setup();
    const { exchange, ...plain } = BODY;
    void exchange;
    await t.human("secrets.create", { ...plain, name: "PLAIN_APP" });
    await t.human("secrets.create", BODY);
    const cases: [string, Record<string, unknown>][] = [
      ["PLAIN_APP", { exchange: EXCHANGE }],
      ["FEISHU_APP", { exchange: { ...EXCHANGE, id: "cli_other" } }],
      [
        "FEISHU_APP",
        { exchange: { ...EXCHANGE, url: "https://api.example.com/token" } },
      ],
      ["FEISHU_APP", { exchange: { ...EXCHANGE, tokenField: "app_secret" } }],
      ["FEISHU_APP", { exchange: null }],
    ];
    for (const [name, patch] of cases)
      expect([
        name,
        patch,
        errorOf(await t.agent("secrets.update", patch, name)),
      ]).toEqual([name, patch, refused]);
    expect((await listed(t, "FEISHU_APP"))?.exchange).toEqual(EXCHANGE);
    expect((await listed(t, "PLAIN_APP"))?.exchange).toBeUndefined();
  });

  it("may not move the token into or out of the web address, or rename its parameter", async () => {
    const t = setup();
    await t.human("secrets.create", BODY);
    await t.human("secrets.create", QUERY_BODY);
    const cases: [string, Record<string, unknown>][] = [
      ["FEISHU_APP", { form: { kind: "query", param: "access_token" } }],
      ["WECOM_APP", { form: { kind: "query", param: "text" } }],
      ["WECOM_APP", { form: { kind: "authorization" } }],
      ["WECOM_APP", { form: { kind: "header", header: "x-token" } }],
    ];
    for (const [name, patch] of cases)
      expect([
        name,
        patch,
        errorOf(await t.agent("secrets.update", patch, name)),
      ]).toEqual([name, patch, refused]);
    expect((await listed(t, "WECOM_APP"))?.form).toEqual(QUERY_BODY.form);
    expect((await listed(t, "FEISHU_APP"))?.form).toEqual(BODY.form);
  });

  it("may still send the same exchange, move the token between headers, drop another host, edit the note and rotate", async () => {
    const t = setup();
    await t.human("secrets.create", BODY);
    for (const patch of [
      { exchange: EXCHANGE, note: "Same exchange." },
      { form: { kind: "header", header: "x-acs-token" } },
      { form: { kind: "authorization" } },
      { hosts: ["open.example.com"] },
    ])
      expect([
        patch,
        (await t.agent("secrets.update", patch, "FEISHU_APP")).kind,
      ]).toEqual([patch, "json"]);
    expect(
      (
        await t.agent(
          "secrets.rotate",
          { value: "fake-feishu-app-secret-rotated-01" },
          "FEISHU_APP",
        )
      ).kind,
    ).toBe("json");
    const row = await listed(t, "FEISHU_APP");
    expect(row?.exchange).toEqual(EXCHANGE);
    expect(row?.hosts).toEqual(["open.example.com"]);
  });

  it("may not drop the token address's host while the exchange is set", async () => {
    const t = setup();
    await t.human("secrets.create", BODY);
    for (const call of [t.agent, t.human])
      expect(
        errorOf(
          await call(
            "secrets.update",
            { hosts: ["api.example.com"] },
            "FEISHU_APP",
          ),
        ),
      ).toEqual({
        status: 400,
        code: "invalid_secret",
        field: "exchange",
        reason: "host",
      });
    expect((await listed(t, "FEISHU_APP"))?.hosts).toEqual(
      [...BODY.hosts].sort(),
    );
  });
});

describe("a human on a saved secret", () => {
  it("changes and removes the exchange; the query form goes with it or not at all", async () => {
    const t = setup();
    await t.human("secrets.create", BODY);
    await t.human("secrets.create", QUERY_BODY);
    const changed = { ...EXCHANGE, id: "cli_other" };
    expect(
      secretOf(
        await t.human("secrets.update", { exchange: changed }, "FEISHU_APP"),
      )?.exchange,
    ).toEqual(changed);
    const removed = await t.human(
      "secrets.update",
      { exchange: null },
      "FEISHU_APP",
    );
    expect(removed.kind).toBe("json");
    expect((await listed(t, "FEISHU_APP"))?.exchange).toBeUndefined();
    // A query-form secret without its exchange would send nothing a service
    // reads: refused, unless the form changes in the same edit.
    expect(
      errorOf(await t.human("secrets.update", { exchange: null }, "WECOM_APP")),
    ).toMatchObject({ status: 400, code: "invalid_secret", field: "form" });
    expect((await listed(t, "WECOM_APP"))?.exchange).toEqual(EXCHANGE);
    expect(
      (
        await t.human(
          "secrets.update",
          { exchange: null, form: { kind: "authorization" } },
          "WECOM_APP",
        )
      ).kind,
    ).toBe("json");
  });
});
