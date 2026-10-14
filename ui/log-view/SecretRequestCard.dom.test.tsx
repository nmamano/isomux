import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { expectMasked } from "../test-support/masked.ts";
import type { SecretRequestPayload } from "../../shared/types.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { SecretRequestCard, SecretRequestOutcomes } =
  await import("./SecretRequestCard.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { StateCtx, initialState } = await import("../store.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));

const { t } = translatorFor("en");
const FAKE = "fake-requested-value-0000-ui";
const PAYLOAD = {
  requestId: "req-1",
  scope: "personal" as const,
  name: "GH_TOKEN",
  hosts: ["api.github.com"],
  form: { kind: "authorization" as const },
  reason: "To open the pull request.",
  bootId: "boot-1",
};

function shim(
  answer: (path: string) => unknown = () => ({ name: "GH_TOKEN" }),
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    return answer(path);
  });
  return calls;
}

const BOOT = "boot-1";
// The viewer is the agent's manager unless a test says otherwise.
function stateFor(
  over: { userId?: string; role?: "owner" | "member"; boot?: string } = {},
) {
  return {
    ...initialState,
    serverBootId: over.boot ?? BOOT,
    sessionContext: {
      userId: over.userId ?? "u-alice",
      username: "alice",
      role: over.role ?? "member",
    },
    agents: [
      { id: "a1", userId: "u-alice" },
      { id: "a 1", userId: "u-alice" },
    ],
  } as unknown as typeof initialState;
}

function card(
  payload: SecretRequestPayload,
  agentId = "a1",
  over: Parameters<typeof stateFor>[0] = {},
) {
  return render(
    <StateCtx.Provider value={stateFor(over)}>
      <SecretRequestCard payload={payload} agentId={agentId} />
    </StateCtx.Provider>,
  );
}

const valueInput = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLInputElement>("[data-masked-credential]");

it("saves the typed value with the edited hosts, then shows it saved without the value", async () => {
  const calls = shim();
  const view = card(PAYLOAD, "a 1");
  expect(view.container.textContent).toContain(PAYLOAD.reason);
  const input = valueInput(view)!;
  expectMasked(input);
  const save = view.getByRole("button", {
    name: t("cards.secretRequest.save"),
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(view.getByLabelText(t("settings.secrets.hosts")), {
    target: { value: "api.github.com\nuploads.github.com" },
  });
  fireEvent.change(input, { target: { value: FAKE } });
  fireEvent.click(save);
  await act(async () => {});
  expect(calls).toEqual([
    {
      method: "POST",
      path: "/api/agents/a%201/secret-requests/req-1/save",
      body: { value: FAKE, hosts: ["api.github.com", "uploads.github.com"] },
    },
  ]);
  expect(valueInput(view)).toBeNull();
  expect(view.container.querySelector('[data-outcome="saved"]')).not.toBeNull();
  expect(view.container.innerHTML).not.toContain(FAKE);
});

it("declines with no body", async () => {
  const calls = shim();
  const view = card(PAYLOAD);
  fireEvent.click(
    view.getByRole("button", { name: t("cards.secretRequest.decline") }),
  );
  await act(async () => {});
  expect(calls).toEqual([
    {
      method: "POST",
      path: "/api/agents/a1/secret-requests/req-1/decline",
      body: undefined,
    },
  ]);
  expect(
    view.container.querySelector('[data-outcome="declined"]'),
  ).not.toBeNull();
});

it("a closed request clears the field; a refusal keeps it and names the reason", async () => {
  setApiShim(async () => {
    throw new ApiError(403, "forbidden", "forbidden");
  });
  const view = card(PAYLOAD);
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  fireEvent.click(
    view.getByRole("button", { name: t("cards.secretRequest.save") }),
  );
  await act(async () => {});
  expect(view.getByRole("alert").textContent).toBe(
    t("cards.secretRequest.forbidden"),
  );
  expect(valueInput(view)!.value).toBe(FAKE);

  setApiShim(async () => {
    throw new ApiError(404, "not_found", "Not found");
  });
  fireEvent.click(
    view.getByRole("button", { name: t("cards.secretRequest.save") }),
  );
  await act(async () => {});
  expect(valueInput(view)).toBeNull();
  expect(
    view.container.querySelector('[data-outcome="closed"]'),
  ).not.toBeNull();
});

it("a request the transcript has settled shows no form", () => {
  shim();
  const view = render(
    <StateCtx.Provider value={stateFor()}>
      <SecretRequestOutcomes.Provider value={new Map([["req-1", "saved"]])}>
        <SecretRequestCard payload={PAYLOAD} agentId="a1" />
      </SecretRequestOutcomes.Provider>
    </StateCtx.Provider>,
  );
  expect(valueInput(view)).toBeNull();
  expect(view.container.querySelector('[data-outcome="saved"]')).not.toBeNull();
});

it("a card from an earlier server boot shows closed, with no form", () => {
  shim();
  const view = card({ ...PAYLOAD, bootId: "boot-0" });
  expect(valueInput(view)).toBeNull();
  expect(
    view.container.querySelector('[data-outcome="closed"]'),
  ).not.toBeNull();
  // No id on either side: closed, so no form that cannot save.
  const { bootId: _unused, ...noBoot } = PAYLOAD;
  void _unused;
  const missing = card({ ...noBoot, requestId: "req-4" });
  expect(valueInput(missing)).toBeNull();
  expect(
    missing.container.querySelector('[data-outcome="closed"]'),
  ).not.toBeNull();
  const noServerBoot = render(
    <StateCtx.Provider value={{ ...stateFor(), serverBootId: null }}>
      <SecretRequestCard
        payload={{ ...PAYLOAD, requestId: "req-5" }}
        agentId="a1"
      />
    </StateCtx.Provider>,
  );
  expect(valueInput(noServerBoot)).toBeNull();
  // The same card from this boot is open.
  const open = card({ ...PAYLOAD, requestId: "req-2", bootId: BOOT });
  expect(valueInput(open)).not.toBeNull();
});

it("a viewer who cannot answer sees the card read-only", () => {
  shim();
  // Another member, on a personal request.
  const other = card(PAYLOAD, "a1", { userId: "u-bob", role: "owner" });
  expect(valueInput(other)).toBeNull();
  expect(
    other.container.querySelector('[data-outcome="read-only"]'),
  ).not.toBeNull();
  // The manager, on an office request, is not an owner.
  const office = { ...PAYLOAD, requestId: "req-3", scope: "office" as const };
  expect(valueInput(card(office))).toBeNull();
  // An owner answers an office request.
  expect(
    valueInput(card(office, "a1", { userId: "u-bob", role: "owner" })),
  ).not.toBeNull();
});
