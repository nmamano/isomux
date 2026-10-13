// The MCP servers tab's list and forms (ported from the Settings
// McpServersList and McpServersOAuth tests): a pasted token is saved as a
// secret bound to the address's host, a saved secret is offered only when it
// lists that host, and the sign-in leaves for the authorization server with a
// note of whose server it is.

import { afterAll, beforeEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ApiError, setApiShim } = await import("../api.ts");
const { McpSection } = await import("./McpSection.tsx");
const { MyConnectionsProvider } = await import("./my-connections.tsx");
const { takeSignIn } = await import("./sign-in-return.ts");
const { demoSecretsRoute } = await import("../demo-secrets.ts");
const { demoMcpServersRoute } = await import("../demo-mcp-servers.ts");
const { IntegrationsFake, EMPTY_CONNECTIONS, secret, server } =
  await import("../test-support/integrations-fake.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");
const FAKE = "fake-mcp-token-0000-ui";
const SELF = { kind: "self", username: "alice" } as const;
const PATH = "/api/users/alice/mcp-servers";
const SECRETS = "/api/users/alice/secrets";

let fake: InstanceType<typeof IntegrationsFake>;
beforeEach(() => {
  fake = new IntegrationsFake({ username: "alice", owner: true }, [
    "alice",
    "Stephen",
  ]).install();
  sessionStorage.clear();
});

async function mount(target: object = SELF, role = "owner") {
  const view = render(
    createElement(
      MyConnectionsProvider,
      null,
      createElement(McpSection, { target, role } as never),
    ),
  );
  await act(async () => {});
  return view;
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
}

async function type(
  view: ReturnType<typeof render>,
  selector: string,
  value: string,
) {
  const el = view.container.querySelector(selector);
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.change(el!, { target: { value } });
  });
}

it("adds a server with a pasted token saved as a secret bound to the address's host", async () => {
  const view = await mount();
  expect(view.container.textContent).toContain(t("integrations.mcp.empty"));
  await click(view.container.querySelector("[data-integrations-add]"));
  await type(view, "[data-mcp-name]", "linear");
  await type(view, "[data-mcp-url]", "https://mcp.linear.app/mcp");
  await click(view.container.querySelector('[data-choice="token"]'));
  expect(view.container.textContent).toContain(
    t("integrations.mcp.tokenGoesTo", { host: "mcp.linear.app" }),
  );
  const token =
    view.container.querySelector<HTMLInputElement>("[data-mcp-token]")!;
  expect(token.autocomplete).toBe("new-password");
  await type(view, "[data-mcp-token]", FAKE);
  // The secret's name follows the server's, under More options.
  await click(view.container.querySelector("[data-more-options]"));
  expect(
    view.container.querySelector<HTMLInputElement>("[data-mcp-token-name]")!
      .value,
  ).toBe("LINEAR_TOKEN");
  await click(view.container.querySelector("[data-panel-save]"));

  const posts = fake.calls.filter((c) => c.method === "POST");
  expect(posts.map((c) => c.path)).toEqual([SECRETS, PATH]);
  expect(posts[0].body).toEqual({
    name: "LINEAR_TOKEN",
    value: FAKE,
    hosts: ["mcp.linear.app"],
    form: { kind: "authorization" },
  });
  expect(posts[1].body).toEqual({
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    secret: "LINEAR_TOKEN",
  });
  const row = view.container.querySelector('[data-mcp-server-name="linear"]')!;
  // The row shows the host only: some servers carry a token in the path.
  expect(row.textContent).toContain("mcp.linear.app");
  expect(row.textContent).not.toContain("/mcp");
  expect(row.textContent).toContain("LINEAR_TOKEN");
  expect(view.container.textContent).not.toContain(FAKE);
  // The whole address is in Edit.
  await click(row.querySelector("[data-mcp-edit]"));
  expect(
    view.container.querySelector<HTMLInputElement>("[data-mcp-url]")!.value,
  ).toBe("https://mcp.linear.app/mcp");
});

it("offers only the saved secrets that list the address's host, and explains a refusal by field", async () => {
  // The demo's routes have the server's checks.
  const calls: { method: string; path: string }[] = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path });
    if (path === "/api/me/connections") return EMPTY_CONNECTIONS;
    const answer =
      demoSecretsRoute(method, path, body, () => "u-pick") ??
      demoMcpServersRoute(method, path, body, () => "u-pick");
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return answer.result;
  });
  for (const [name, host] of [
    ["DOCS_TOKEN", "docs.example.com"],
    ["OTHER_TOKEN", "other.example.com"],
  ])
    demoSecretsRoute(
      "POST",
      SECRETS,
      { name, value: FAKE, hosts: [host], form: { kind: "authorization" } },
      () => "u-pick",
    );
  const view = await mount();
  await click(view.container.querySelector("[data-integrations-add]"));
  await type(view, "[data-mcp-url]", "https://docs.example.com/mcp");
  await click(view.container.querySelector('[data-choice="saved"]'));
  const options = [
    ...view.container.querySelector<HTMLSelectElement>("[data-mcp-credential]")!
      .options,
  ].map((o) => o.textContent);
  expect(options).toEqual([t("integrations.mcp.pickSecret"), "DOCS_TOKEN"]);
  // No secret lists this host: the choice is not offered at all.
  await type(view, "[data-mcp-url]", "https://nothing.example.com/mcp");
  expect(view.container.querySelector('[data-choice="saved"]')).toBeNull();

  await type(view, "[data-mcp-url]", "https://docs.example.com/mcp");
  await click(view.container.querySelector('[data-choice="none"]'));
  await type(view, "[data-mcp-name]", "Bad Name");
  await click(view.container.querySelector("[data-panel-save]"));
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.mcpServers.error.name"),
  );
  expect(calls.some((c) => c.method === "POST" && c.path === SECRETS)).toBe(
    false,
  );
});

it("adds an OAuth server with a pasted client, keeps the client secret out of the page and signs in", async () => {
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  const view = await mount({ kind: "member", username: "Stephen" });
  await click(view.container.querySelector("[data-integrations-add]"));
  await type(view, "[data-mcp-name]", "mail");
  await type(view, "[data-mcp-url]", "https://mcp.example.test/mcp");
  await click(view.container.querySelector('[data-choice="oauth"]'));
  await click(
    view.container.querySelector("[data-mcp-oauth] [data-more-options]"),
  );
  await type(view, "[data-mcp-client-id]", "c1");
  await act(async () => {
    fireEvent.change(
      view.getByLabelText(t("settings.mcpServers.clientSecret")),
      { target: { value: FAKE } },
    );
  });
  const save = view.container.querySelector("[data-panel-save]")!;
  expect(save.textContent).toBe(t("integrations.mcp.saveAndSignIn"));
  await click(save);
  const post = fake.requests("POST", "/api/users/Stephen/mcp-servers")[0];
  expect(post.body).toEqual({
    name: "mail",
    url: "https://mcp.example.test/mcp",
    secret: null,
    oauth: { clientId: "c1", clientSecret: FAKE },
  });
  expect(view.container.textContent).not.toContain(FAKE);
  expect(
    fake.requests("POST", "/api/users/Stephen/mcp-servers/mail/sign-in"),
  ).toHaveLength(1);
  expect(assign).toHaveBeenCalledWith("https://auth.example.com/authorize");
  // The page notes whose server it signed in, for the way back.
  expect(takeSignIn()).toEqual({
    server: "mail",
    target: { kind: "member", username: "Stephen" },
  });
  assign.mockRestore();
});

it("signs in from the row of a server that needs it", async () => {
  fake
    .scope("alice")
    .servers.push(
      server("mail", { oauth: { clientId: null, signedIn: false } }),
    );
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  const view = await mount();
  const row = view.container.querySelector('[data-mcp-server-name="mail"]')!;
  expect(row.textContent).toContain(t("integrations.mcp.status.needsSignIn"));
  expect(row.querySelector("[data-connection-test]")).toBeNull();
  await click(row.querySelector("[data-mcp-sign-in]"));
  expect(assign).toHaveBeenCalledWith("https://auth.example.com/authorize");
  assign.mockRestore();
});

it("explains a refused office address by its code", async () => {
  setApiShim(async (method, path) => {
    if (path === "/api/me/connections") return EMPTY_CONNECTIONS;
    if (path.endsWith("/secrets")) return { secrets: [] };
    if (method === "GET")
      return {
        servers: [
          server("mail", { oauth: { clientId: "c1", signedIn: true } }),
        ],
      };
    throw new ApiError(502, "sign_in_failed", "x", {
      reason: "redirect_refused",
    });
  });
  const view = await mount();
  await click(view.container.querySelector("[data-mcp-edit]"));
  await click(view.container.querySelector("[data-mcp-sign-in-again]"));
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.mcpServers.signInError.redirectRefused"),
  );
});

it("shows why a server is left out, and a Test only when it can run", async () => {
  fake
    .scope("alice")
    .servers.push(
      server("ok"),
      server("lost", { secret: "GONE" }),
      server("wrong", { secret: "ELSEWHERE" }),
    );
  fake
    .scope("alice")
    .secrets.push(secret("ELSEWHERE", { hosts: ["other.example.com"] }));
  const view = await mount();
  const row = (name: string) =>
    view.container.querySelector(`[data-mcp-server-name="${name}"]`)!;
  expect(row("lost").querySelector("[data-mcp-problem]")!.textContent).toBe(
    t("settings.connections.list.mcpSecretMissing"),
  );
  expect(row("wrong").querySelector("[data-mcp-problem]")!.textContent).toBe(
    t("settings.connections.list.mcpSecretHost", { host: "wrong.example.com" }),
  );
  expect(row("lost").querySelector("[data-connection-test]")).toBeNull();
  await click(row("ok").querySelector("[data-connection-test]"));
  expect(
    row("ok").querySelector('[data-connection-test-result="ok"]')!.textContent,
  ).toBe(
    `${t("settings.connections.test.works")} · ${translatorFor("en").tn("settings.connections.test.tools", 3)}`,
  );
});

it("says an office server is replaced by your own one with the same name", async () => {
  fake.scope("office").servers.push(server("linear"));
  fake.connections = {
    ...EMPTY_CONNECTIONS,
    mcpServers: [
      {
        scope: "office",
        name: "linear",
        host: "linear.example.com",
        credential: false,
        secret: null,
        problem: null,
        overridden: true,
      },
    ],
  };
  const view = await mount({ kind: "office" });
  expect(
    view.container.querySelector("[data-mcp-overridden]")!.textContent,
  ).toBe(t("settings.connections.list.mcpOverridden"));
});

it("shows the load failure, not a crash, when a server answers with another shape", async () => {
  setApiShim(async () => ({}));
  const view = await mount();
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.mcpServers.loadFailed"),
  );
});
