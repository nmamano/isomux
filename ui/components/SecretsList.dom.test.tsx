import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { SecretsList } = await import("./SecretsList.tsx");
const { setApiShim } = await import("../api.ts");
const { demoSecretsRoute } = await import("../demo-secrets.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");
const FAKE = "fake-secret-value-0000-ui";

// The demo's in-memory routes stand in for the server; every call is kept.
function shim() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    const answer = demoSecretsRoute(method, path, body, () => "u-test");
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return answer.result;
  });
  return calls;
}

function valueInput(view: ReturnType<typeof render>) {
  return view.container.querySelector<HTMLInputElement>(
    'input[type="password"]',
  );
}

it("saves a preset secret, lists it without a value, and clears the value field", async () => {
  const calls = shim();
  const path = "/api/users/alice/secrets";
  const view = render(<SecretsList path={path} canEdit />);
  await act(async () => {});

  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.add") }),
  );
  const preset = view.getByLabelText(t("settings.secrets.preset"));
  fireEvent.change(preset, { target: { value: "github" } });
  expect(
    (view.getByLabelText(t("settings.secrets.name")) as HTMLInputElement).value,
  ).toBe("GH_TOKEN");
  const input = valueInput(view)!;
  expect(input.autocomplete).toBe("new-password");
  fireEvent.change(input, { target: { value: FAKE } });
  fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  await act(async () => {});

  const post = calls.find((c) => c.method === "POST")!;
  expect(post.path).toBe(path);
  expect(post.body).toEqual(
    expect.objectContaining({
      name: "GH_TOKEN",
      value: FAKE,
      form: { kind: "authorization" },
    }),
  );
  const row = view.container.querySelector('[data-secret-name="GH_TOKEN"]')!;
  expect(row.textContent).toContain("api.github.com");
  expect(view.container.textContent).not.toContain(FAKE);
  expect(valueInput(view)).toBeNull();

  // A new value field opens empty, and a cancel clears what was typed.
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.rotate") }),
  );
  expect(valueInput(view)!.value).toBe("");
  fireEvent.change(valueInput(view)!, { target: { value: `${FAKE}-2` } });
  fireEvent.click(view.getByRole("button", { name: t("common.cancel") }));
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.rotate") }),
  );
  expect(valueInput(view)!.value).toBe("");
  fireEvent.change(valueInput(view)!, { target: { value: `${FAKE}-3` } });
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.saveValue") }),
  );
  await act(async () => {});
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put.path).toBe(`${path}/GH_TOKEN/value`);
  expect(put.body).toEqual({ value: `${FAKE}-3` });
  expect(valueInput(view)).toBeNull();

  // A new placeholder: a confirm step, then a body-less POST.
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.reissue") }),
  );
  expect(calls.some((c) => c.path.endsWith("/reissue"))).toBe(false);
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.reissue") }),
  );
  await act(async () => {});
  const reissue = calls.find((c) => c.path.endsWith("/reissue"))!;
  expect(reissue.method).toBe("POST");
  expect(reissue.path).toBe(`${path}/GH_TOKEN/reissue`);
  expect(reissue.body).toBeUndefined();

  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.delete") }),
  );
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.delete") }),
  );
  await act(async () => {});
  expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  expect(
    view.container.querySelector('[data-secret-name="GH_TOKEN"]'),
  ).toBeNull();
  // No URL carries the value.
  for (const call of calls) expect(call.path).not.toContain("fake-secret");
});

it("names the refused host when a host is on the never-list", async () => {
  shim();
  const view = render(<SecretsList path="/api/office/secrets" canEdit />);
  await act(async () => {});
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.add") }),
  );
  fireEvent.change(view.getByLabelText(t("settings.secrets.name")), {
    target: { value: "OPENAI_KEY" },
  });
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  fireEvent.change(view.getByLabelText(t("settings.secrets.hosts")), {
    target: { value: "api.openai.com" },
  });
  fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  await act(async () => {});
  expect(view.getByRole("alert").textContent).toBe(
    t("settings.secrets.error.neverListed", { host: "api.openai.com" }),
  );
});

it("shows a member on the office half no secrets and asks the server nothing", async () => {
  const calls = shim();
  const view = render(
    <SecretsList path="/api/office/secrets" canEdit={false} />,
  );
  await act(async () => {});
  expect(calls).toHaveLength(0);
  expect(view.container.textContent).toContain(
    t("settings.secrets.ownerManaged"),
  );
  expect(view.queryByRole("button")).toBeNull();
});

it("drops an open form and its value when the scope changes", async () => {
  const calls = shim();
  const view = render(<SecretsList path="/api/users/alice/secrets" canEdit />);
  await act(async () => {});
  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.add") }),
  );
  fireEvent.change(view.getByLabelText(t("settings.secrets.name")), {
    target: { value: "MY_TOKEN" },
  });
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });

  view.rerender(<SecretsList path="/api/office/secrets" canEdit />);
  await act(async () => {});
  expect(valueInput(view)).toBeNull();
  expect(calls.some((c) => c.method === "POST")).toBe(false);

  fireEvent.click(
    view.getByRole("button", { name: t("settings.secrets.add") }),
  );
  expect(valueInput(view)!.value).toBe("");
  expect(
    (view.getByLabelText(t("settings.secrets.name")) as HTMLInputElement).value,
  ).toBe("");
  fireEvent.change(view.getByLabelText(t("settings.secrets.name")), {
    target: { value: "OFFICE_TOKEN" },
  });
  fireEvent.change(valueInput(view)!, { target: { value: `${FAKE}-office` } });
  fireEvent.change(view.getByLabelText(t("settings.secrets.hosts")), {
    target: { value: "api.example.com" },
  });
  fireEvent.click(view.getByRole("button", { name: t("common.save") }));
  await act(async () => {});
  const posts = calls.filter((c) => c.method === "POST");
  expect(posts.map((c) => c.path)).toEqual(["/api/office/secrets"]);
  expect(posts[0].body).toEqual(
    expect.objectContaining({ name: "OFFICE_TOKEN", value: `${FAKE}-office` }),
  );
});
