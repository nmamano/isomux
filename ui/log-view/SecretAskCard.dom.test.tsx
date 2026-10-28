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

// A request for an app's secret (task 315a62c0): the value goes to the app's
// environment, so it has no hosts.
const APP_ASK: AskEntry = {
  ...SECRET_ASK,
  secret: {
    ...SECRET_ASK.secret!,
    name: "YOUTUBE_CLIENT_SECRET",
    hosts: [],
    app: { name: "game-video", createdAt: 1000 },
    ownerUserId: "u2",
  },
};

function Seed({
  entry,
  children,
}: {
  entry: AskEntry;
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({ type: "asks_loaded", entries: [entry], revision: 0 });
  }, [dispatch, entry]);
  return <>{children}</>;
}

async function mount(isMobile = false, entry: AskEntry = SECRET_ASK) {
  const view = render(
    <StoreProvider>
      <Seed entry={entry}>
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

it("an app request names the app, has no hosts field, and saves the value with no hosts", async () => {
  const view = await mount(false, APP_ASK);
  expect(card(view)?.textContent).toContain("game-video");
  expect(view.queryByLabelText(t("settings.secrets.hosts"))).toBeNull();
  expectMasked(valueInput(view));
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  expect(posts).toHaveLength(1);
  const { path, body } = posts[0] as {
    path: string;
    body: { value: string; hosts?: string[] };
  };
  expect(path).toBe("/api/agents/a%201/secret-requests/req-1/save");
  expect([body.value, body.hosts ?? []]).toEqual([FAKE, []]);
  expect(card(view)).toBeNull();
  view.unmount();
});

it("an app gone since the request keeps the card and says why, not a bare failure", async () => {
  answer = async () => {
    throw new ApiError(409, "app_gone", "app gone");
  };
  const view = await mount(false, APP_ASK);
  fireEvent.change(valueInput(view)!, { target: { value: FAKE } });
  await act(async () => {
    fireEvent.click(saveButton(view));
  });
  const alert = view.getByRole("alert").textContent ?? "";
  expect(alert.length).toBeGreaterThan(0);
  expect(alert).not.toBe(t("settings.secrets.saveFailed"));
  expect(card(view)).not.toBeNull();
  view.unmount();
});
