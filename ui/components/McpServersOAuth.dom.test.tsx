import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { McpServersList, resetSignInReturn } =
  await import("./McpServersList.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));
afterEach(() => {
  resetSignInReturn();
  window.history.replaceState(null, "", "/settings");
});

const { t } = translatorFor("en");
const PATH = "/api/users/alice/mcp-servers";
const SECRETS = "/api/users/alice/secrets";
const FAKE = "fake-oauth-client-secret-ui";
const AUTHORIZE = "https://auth.example.test/authorize?state=s1";

function oauthServer(signedIn: boolean) {
  return {
    name: "mail",
    url: "https://mcp.example.test/mcp",
    secret: null,
    createdAt: 1,
    updatedAt: 1,
    note: null,
    oauth: { clientId: "c1", signedIn },
  };
}

// The server: a list, and the answer `signIn` gives to the sign-in route.
function shim(
  servers: unknown[],
  signIn: () => unknown = () => ({ authorizationUrl: AUTHORIZE }),
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === SECRETS) return { secrets: [] };
    if (method === "GET" && path === PATH) return { servers };
    if (method === "POST" && path === PATH)
      return {
        server: {
          ...(body as object),
          oauth: { clientId: null, signedIn: false },
        },
      };
    if (method === "POST" && path === `${PATH}/mail/sign-in`) return signIn();
    throw new Error(`unexpected ${method} ${path}`);
  });
  return calls;
}

function field(view: ReturnType<typeof render>, label: string) {
  return view.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
}

it("adds an OAuth server with a pasted client and keeps the secret out of the page", async () => {
  const calls = shim([]);
  const view = render(
    <McpServersList path={PATH} secretsPath={SECRETS} canEdit />,
  );
  await act(async () => {});
  fireEvent.click(
    view.getByRole("button", { name: t("settings.mcpServers.add") }),
  );
  fireEvent.change(field(view, t("settings.mcpServers.name")), {
    target: { value: "mail" },
  });
  fireEvent.change(field(view, t("settings.mcpServers.url")), {
    target: { value: "https://mcp.example.test/mcp" },
  });
  fireEvent.change(field(view, t("settings.mcpServers.credential")), {
    target: { value: "\u0000oauth" },
  });
  // The OAuth choice is listed once, not again as a secret name.
  const options = [
    ...(field(view, t("settings.mcpServers.credential")) as HTMLSelectElement)
      .options,
  ].map((option) => option.textContent);
  expect(options).toEqual([
    t("settings.mcpServers.credentialNone"),
    t("settings.mcpServers.credentialNew"),
    t("settings.mcpServers.credentialOAuth"),
  ]);
  fireEvent.change(field(view, t("settings.mcpServers.clientId")), {
    target: { value: "c1" },
  });
  fireEvent.change(field(view, t("settings.mcpServers.clientSecret")), {
    target: { value: FAKE },
  });
  fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  await act(async () => {});
  const post = calls.find((c) => c.method === "POST" && c.path === PATH)!;
  expect(post.body).toEqual({
    name: "mail",
    url: "https://mcp.example.test/mcp",
    secret: null,
    oauth: { clientId: "c1", clientSecret: FAKE },
  });
  expect(view.container.textContent).not.toContain(FAKE);
  view.unmount();
});

it("sends the browser to the authorization URL from Sign in", async () => {
  const calls = shim([oauthServer(false)]);
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  const view = render(
    <McpServersList path={PATH} secretsPath={SECRETS} canEdit />,
  );
  await act(async () => {});
  const row = view.container.querySelector('[data-mcp-server-name="mail"]')!;
  expect(row.textContent).toContain(t("settings.mcpServers.notSignedIn"));
  fireEvent.click(
    view.getByRole("button", { name: t("settings.mcpServers.signIn") }),
  );
  await act(async () => {});
  expect(
    calls.some((c) => c.method === "POST" && c.path === `${PATH}/mail/sign-in`),
  ).toBe(true);
  expect(assign).toHaveBeenCalledWith(AUTHORIZE);
  assign.mockRestore();
  view.unmount();
});

it("explains a refused office address by its code", async () => {
  shim([oauthServer(true)], () => {
    throw new ApiError(502, "sign_in_failed", "x", {
      reason: "redirect_refused",
    });
  });
  const view = render(
    <McpServersList path={PATH} secretsPath={SECRETS} canEdit />,
  );
  await act(async () => {});
  fireEvent.click(
    view.getByRole("button", { name: t("settings.mcpServers.signInAgain") }),
  );
  await act(async () => {});
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.mcpServers.signInError.redirectRefused"),
  );
  view.unmount();
});

it("shows the result of a sign-in that came back, once, and clears the address", async () => {
  shim([oauthServer(true)]);
  window.history.replaceState(null, "", "/settings?mcpSignIn=ok");
  const view = render(
    <McpServersList path={PATH} secretsPath={SECRETS} canEdit />,
  );
  await act(async () => {});
  expect(view.getByRole("status").textContent).toBe(
    t("settings.mcpServers.signInDone"),
  );
  expect(window.location.search).toBe("");
  const second = render(
    <McpServersList path={PATH} secretsPath={SECRETS} canEdit />,
  );
  await act(async () => {});
  expect(second.queryAllByRole("status")).toHaveLength(1);
  view.unmount();
  second.unmount();
});
