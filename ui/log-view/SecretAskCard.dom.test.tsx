// A secret request in the asks stack: the masked form in place of the reply
// field, the save and decline routes, and the card leaving once the request
// closed. Mounted through AsksStack, the path every ask list renders.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { expectMasked } from "../test-support/masked.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;

const { t } = translatorFor("en");
const FAKE = "fake-requested-value-0000-ui";
const NOW = Date.now();
const SECRET_ASK: AskEntry = {
  id: "aaaa0001",
  agentId: "a 1",
  memberUserId: "u1",
  prompt: "To open the pull request.",
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  secret: {
    requestId: "req-1",
    scope: "personal",
    name: "GH_TOKEN",
    hosts: ["api.github.com"],
    form: { kind: "authorization" },
    reason: "To open the pull request.",
  },
};

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: { path: string; body: unknown }[] = [];
let answer: (path: string) => Promise<unknown> = async () => undefined;
beforeEach(() => {
  posts = [];
  answer = async () => ({ name: "GH_TOKEN" });
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push({ path, body });
      return answer(path);
    }
    return undefined;
  });
});
afterAll(() => setApiShim(null));

function Seed({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({ type: "asks_loaded", entries: [SECRET_ASK], revision: 0 });
  }, [dispatch]);
  return <>{children}</>;
}

async function mount(isMobile = false) {
  const view = render(
    <StoreProvider>
      <Seed>
        <AsksStack agentId="a 1" isMobile={isMobile} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  return view;
}

const card = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLElement>('[data-ask="aaaa0001"]');
const valueInput = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLInputElement>("[data-masked-credential]");
const saveButton = (view: ReturnType<typeof render>) =>
  view.getByRole("button", {
    name: t("cards.secretRequest.save"),
  }) as HTMLButtonElement;

it("draws the masked form, not a reply field, and the collapsed bar names the secret", async () => {
  const view = await mount();
  expect(card(view)?.dataset.secretRequest).toBe("req-1");
  expect(card(view)?.textContent).toContain(SECRET_ASK.prompt);
  expectMasked(valueInput(view));
  expect(card(view)?.querySelector("form")).toBeNull();
  view.unmount();
  const phone = await mount(true);
  const bar = phone.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  )!;
  expect(bar.textContent).toContain(
    t("cards.secretRequest.title", { name: "GH_TOKEN" }),
  );
  phone.unmount();
});

it("saves the typed value with the edited hosts, then the card goes and the value with it", async () => {
  const view = await mount();
  expect(saveButton(view).disabled).toBe(true);
  fireEvent.change(view.getByLabelText(t("settings.secrets.hosts")), {
    target: { value: "api.github.com\nuploads.github.com" },
  });
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/save",
      body: { value: FAKE, hosts: ["api.github.com", "uploads.github.com"] },
    },
  ]);
  expect(card(view)).toBeNull();
  expect(view.container.innerHTML).not.toContain(FAKE);
  view.unmount();
});

it("declines with no body, and the card goes", async () => {
  const view = await mount();
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("cards.secretRequest.decline") }),
    );
  });
  expect(posts).toEqual([
    {
      path: "/api/agents/a%201/secret-requests/req-1/decline",
      body: undefined,
    },
  ]);
  expect(card(view)).toBeNull();
  view.unmount();
});

it("a refusal keeps the field and names the reason; a closed request takes the card away", async () => {
  answer = async () => {
    throw new ApiError(403, "forbidden", "forbidden");
  };
  const view = await mount();
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(view.getByRole("alert").textContent).toBe(
    t("cards.secretRequest.forbidden"),
  );
  expect(valueInput(view)!.value).toBe(FAKE);

  answer = async () => {
    throw new ApiError(404, "not_found", "Not found");
  };
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(card(view)).toBeNull();
  expect(view.container.innerHTML).not.toContain(FAKE);
  view.unmount();
});

it("a failed decline says the decline failed, not the save, and the card stays", async () => {
  answer = async () => {
    throw new ApiError(500, "request_failed", "request failed");
  };
  const view = await mount();
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: t("cards.secretRequest.decline") }),
    );
  });
  expect(view.getByRole("alert").textContent).toBe(
    t("cards.secretRequest.declineFailed"),
  );
  expect(card(view)).not.toBeNull();
  view.unmount();
});
