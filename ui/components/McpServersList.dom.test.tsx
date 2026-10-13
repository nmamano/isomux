import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { McpServersList } = await import("./McpServersList.tsx");
const { setApiShim } = await import("../api.ts");
const { demoSecretsRoute } = await import("../demo-secrets.ts");
const { demoMcpServersRoute } = await import("../demo-mcp-servers.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");
const FAKE = "fake-mcp-token-0000-ui";

// The demo's in-memory routes stand in for the server; every call is kept.
function shim(user: string) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    const answer =
      demoSecretsRoute(method, path, body, () => user) ??
      demoMcpServersRoute(method, path, body, () => user);
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return answer.result;
  });
  return calls;
}

function field(view: ReturnType<typeof render>, label: string) {
  return view.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
}

it("adds a server with a new secret bound to the URL's host, then lists it", async () => {
  const calls = shim("u-new-secret");
  const path = "/api/users/alice/mcp-servers";
  const secretsPath = "/api/users/alice/secrets";
  const view = render(
    <McpServersList path={path} secretsPath={secretsPath} canEdit />,
  );
  await act(async () => {});
  expect(view.getByText(t("settings.mcpServers.empty"))).toBeTruthy();

  fireEvent.click(
    view.getByRole("button", { name: t("settings.mcpServers.add") }),
  );
  fireEvent.change(field(view, t("settings.mcpServers.name")), {
    target: { value: "linear" },
  });
  fireEvent.change(field(view, t("settings.mcpServers.url")), {
    target: { value: "https://mcp.linear.app/mcp" },
  });
  fireEvent.change(field(view, t("settings.mcpServers.credential")), {
    target: { value: "\u0000new" },
  });
  expect(
    view.getByText(
      t("settings.mcpServers.newSecretHost", { host: "mcp.linear.app" }),
      { exact: false },
    ),
  ).toBeTruthy();
  fireEvent.change(field(view, t("settings.mcpServers.secretName")), {
    target: { value: "LINEAR_TOKEN" },
  });
  const value = view.container.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  expect(value.autocomplete).toBe("new-password");
  fireEvent.change(value, { target: { value: FAKE } });
  fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  await act(async () => {});

  const posts = calls.filter((c) => c.method === "POST");
  expect(posts.map((c) => c.path)).toEqual([secretsPath, path]);
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
  expect(row.textContent).toContain("https://mcp.linear.app/mcp");
  expect(row.textContent).toContain("LINEAR_TOKEN");
  expect(view.container.textContent).not.toContain(FAKE);
  view.unmount();
});

it("offers only the secrets that list the URL's host, and explains a refusal by field", async () => {
  const calls = shim("u-pick");
  const secretsPath = "/api/users/bob/secrets";
  demoSecretsRoute(
    "POST",
    secretsPath,
    {
      name: "DOCS_TOKEN",
      value: FAKE,
      hosts: ["docs.example.com"],
      form: { kind: "authorization" },
    },
    () => "u-pick",
  );
  demoSecretsRoute(
    "POST",
    secretsPath,
    {
      name: "OTHER_TOKEN",
      value: FAKE,
      hosts: ["other.example.com"],
      form: { kind: "authorization" },
    },
    () => "u-pick",
  );
  const view = render(
    <McpServersList
      path="/api/users/bob/mcp-servers"
      secretsPath={secretsPath}
      canEdit
    />,
  );
  await act(async () => {});
  fireEvent.click(
    view.getByRole("button", { name: t("settings.mcpServers.add") }),
  );
  fireEvent.change(field(view, t("settings.mcpServers.url")), {
    target: { value: "https://docs.example.com/mcp" },
  });
  const options = [
    ...(field(view, t("settings.mcpServers.credential")) as HTMLSelectElement)
      .options,
  ].map((option) => option.textContent);
  expect(options).toEqual([
    t("settings.mcpServers.credentialNone"),
    "DOCS_TOKEN",
    t("settings.mcpServers.credentialNew"),
  ]);

  fireEvent.change(field(view, t("settings.mcpServers.name")), {
    target: { value: "Bad Name" },
  });
  fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  await act(async () => {});
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.mcpServers.error.name"),
  );
  expect(
    calls.some((c) => c.method === "POST" && c.path.endsWith("/secrets")),
  ).toBe(false);
  view.unmount();
});

it("tells a member that an owner manages the office servers, and loads nothing", async () => {
  const calls = shim("u-member");
  const view = render(
    <McpServersList
      path="/api/office/mcp-servers"
      secretsPath="/api/office/secrets"
      canEdit={false}
    />,
  );
  await act(async () => {});
  expect(view.getByText(t("settings.mcpServers.ownerManaged"))).toBeTruthy();
  expect(calls).toEqual([]);
  view.unmount();
});

it("shows the load failure, not a crash, when a server answers with another shape", async () => {
  setApiShim(async () => ({}));
  const view = render(
    <McpServersList
      path="/api/users/alice/mcp-servers"
      secretsPath="/api/users/alice/secrets"
      canEdit
    />,
  );
  await act(async () => {});
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.mcpServers.loadFailed"),
  );
  view.unmount();
});
