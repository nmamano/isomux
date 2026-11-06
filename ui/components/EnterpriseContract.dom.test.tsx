// The Enterprise Contract box in Settings -> Office and the lock it puts on
// the office (task 8b80e61f). The server decides the lock
// (full_state.office.enterpriseLocked, office_enterprise_lock); the UI only
// shows it. Owners can paste the secret or uncheck the box from the lock;
// members can only read it.
import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type { EnterpriseViewRes } from "../../shared/contract-shapes.ts";

setUpDomTestFile();

const { act, fireEvent, render, within, cleanup } =
  await import("@testing-library/react");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { EnterpriseLock } = await import("./EnterpriseLock.tsx");
const { EnterpriseContractSection } =
  await import("./EnterpriseContractSection.tsx");

type Role = "owner" | "member";
type Call = { method: string; path: string; body: unknown };

const ANSWER = {
  company: "Acme Corp",
  kind: "standard" as const,
  seats: 18,
  inUse: 7,
  offices: 3,
};
const VIEW_OFF: EnterpriseViewRes = {
  available: true,
  enabled: false,
  locked: false,
  connected: null,
  problem: null,
};
const VIEW_LOCKED: EnterpriseViewRes = {
  ...VIEW_OFF,
  enabled: true,
  locked: true,
};
const VIEW_CONNECTED: EnterpriseViewRes = {
  ...VIEW_OFF,
  enabled: true,
  connected: { ...ANSWER, checkedAt: 1_700_000_000_000 },
};

afterEach(() => {
  cleanup();
  setApiShim(null);
});

// A server for the four enterprise routes. `answer` decides each reply; the
// default answers GET and check with `view`.
function serve(
  view: EnterpriseViewRes,
  answer?: (call: Call) => Promise<unknown> | undefined,
): Call[] {
  const calls: Call[] = [];
  setApiShim(async (method, path, body) => {
    const call = { method, path, body };
    calls.push(call);
    const custom = answer?.(call);
    if (custom !== undefined) return custom;
    if (path === "/api/office/enterprise" && method === "GET") return view;
    if (path === "/api/office/enterprise/check" && method === "POST")
      return view;
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  return calls;
}

function mount(node: React.ReactNode, role: Role) {
  let state: typeof initialState = {
    ...initialState,
    connected: true,
    sessionContext: {
      userId: role,
      username: role,
      role,
      currentSessionPrefix: "session",
      connectionId: "connection",
    },
  };
  const dispatch = (action: Parameters<typeof reducer>[1]) => {
    state = reducer(state, action);
    view.rerender(tree());
  };
  const tree = () => (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{node}</DispatchCtx.Provider>
    </StateCtx.Provider>
  );
  const view = render(tree());
  const fullState = (enterpriseLocked: boolean | undefined) =>
    act(async () => {
      dispatch({
        type: "full_state",
        agents: [],
        recentCwds: [],
        office: {
          prompt: null,
          name: null,
          ...(enterpriseLocked === undefined ? {} : { enterpriseLocked }),
        },
        rooms: [],
        killedAgents: [],
      });
    });
  const lockEvent = (value: boolean) =>
    act(async () => {
      dispatch({ type: "office_enterprise_lock", locked: value });
    });
  return { view, fullState, lockEvent };
}

const body = () => within(document.body);
const passwordInput = () =>
  document.body.querySelector<HTMLInputElement>('input[type="password"]');
const settle = () => act(async () => {});

describe("the lock", () => {
  it("covers the office for a member while the server says locked, with nothing to act on", async () => {
    serve(VIEW_LOCKED);
    const { fullState, lockEvent } = mount(<EnterpriseLock />, "member");
    await fullState(true);
    await settle();
    expect(body().queryByRole("dialog")).not.toBeNull();
    // The owner's controls are not there.
    expect(passwordInput()).toBeNull();
    expect(body().queryByRole("checkbox")).toBeNull();

    await lockEvent(false);
    expect(body().queryByRole("dialog")).toBeNull();
    await lockEvent(true);
    expect(body().queryByRole("dialog")).not.toBeNull();
  });

  it("shows nothing while unlocked or when an older server sends no lock field", async () => {
    serve(VIEW_OFF);
    const { fullState } = mount(<EnterpriseLock />, "owner");
    await fullState(undefined);
    await settle();
    expect(body().queryByRole("dialog")).toBeNull();
    await fullState(false);
    expect(body().queryByRole("dialog")).toBeNull();
  });

  it("lets an owner paste the secret from the lock", async () => {
    const calls = serve(VIEW_LOCKED, (call) =>
      call.path === "/api/office/enterprise/secret"
        ? Promise.resolve({ ...VIEW_CONNECTED })
        : undefined,
    );
    const { fullState, lockEvent } = mount(<EnterpriseLock />, "owner");
    await fullState(true);
    await settle();
    const dialog = within(body().getByRole("dialog"));
    expect((dialog.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      true,
    );
    const input = passwordInput();
    expect(input).not.toBeNull();
    await act(async () => {
      fireEvent.change(input!, { target: { value: "isx_ent_1_goodmac" } });
    });
    await act(async () => {
      fireEvent.submit(input!.closest("form")!);
    });
    expect(
      calls.filter((c) => c.path === "/api/office/enterprise/secret"),
    ).toEqual([
      {
        method: "POST",
        path: "/api/office/enterprise/secret",
        body: { secret: "isx_ent_1_goodmac" },
      },
    ]);
    // The server's event lifts the lock.
    await lockEvent(false);
    expect(body().queryByRole("dialog")).toBeNull();
  });
});

describe("Settings -> Office", () => {
  it("turns the box on and then asks for the secret", async () => {
    const calls = serve(VIEW_OFF, (call) =>
      call.method === "PUT" ? Promise.resolve(VIEW_LOCKED) : undefined,
    );
    mount(<EnterpriseContractSection />, "owner");
    await settle();
    const box = body().getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(passwordInput()).toBeNull();

    await act(async () => {
      fireEvent.click(box);
    });
    await settle();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      {
        method: "PUT",
        path: "/api/office/enterprise",
        body: { enabled: true },
      },
    ]);
    expect((body().getByRole("checkbox") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(passwordInput()).not.toBeNull();
  });

  it("says why a secret was refused and keeps what the owner typed", async () => {
    serve(VIEW_LOCKED, (call) =>
      call.path === "/api/office/enterprise/secret"
        ? Promise.reject(
            new ApiError(403, "enterprise_secret_rejected", "rejected"),
          )
        : undefined,
    );
    mount(<EnterpriseContractSection />, "owner");
    await settle();
    expect(body().queryByRole("alert")).toBeNull();
    const input = passwordInput()!;
    await act(async () => {
      fireEvent.change(input, { target: { value: "isx_ent_1_typo" } });
    });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    await settle();
    expect(body().queryByRole("alert")).not.toBeNull();
    expect(passwordInput()!.value).toBe("isx_ent_1_typo");
  });

  it("checks in when it opens and shows the seats only once the service answered", async () => {
    let answerCheck!: (view: EnterpriseViewRes) => void;
    const later: EnterpriseViewRes = {
      ...VIEW_CONNECTED,
      connected: { ...ANSWER, inUse: 9, checkedAt: 1_700_000_100_000 },
    };
    const calls = serve(VIEW_CONNECTED, (call) =>
      call.path === "/api/office/enterprise/check"
        ? new Promise((r) => (answerCheck = r))
        : undefined,
    );
    const { view } = mount(<EnterpriseContractSection />, "owner");
    await settle();
    expect(
      calls.filter((c) => c.path === "/api/office/enterprise/check"),
    ).toHaveLength(1);
    expect(view.container.textContent).toContain("Acme Corp");
    // The cached count is not shown as current while the check runs.
    expect(view.container.textContent).not.toContain("7/18");
    expect(view.container.textContent).not.toContain("9/18");
    expect(body().queryByRole("alert")).toBeNull();

    await act(async () => {
      answerCheck(later);
    });
    expect(view.container.textContent).toContain("9/18");
  });

  it("shows the problem the server reports for a connected office", async () => {
    serve({ ...VIEW_CONNECTED, problem: "bad_secret" });
    mount(<EnterpriseContractSection />, "owner");
    await settle();
    expect(body().queryByRole("alert")).not.toBeNull();
  });

  it("unchecking sends the box off", async () => {
    const calls = serve(VIEW_CONNECTED, (call) =>
      call.method === "PUT" ? Promise.resolve(VIEW_OFF) : undefined,
    );
    mount(<EnterpriseContractSection />, "owner");
    await settle();
    await act(async () => {
      fireEvent.click(body().getByRole("checkbox"));
    });
    await settle();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      {
        method: "PUT",
        path: "/api/office/enterprise",
        body: { enabled: false },
      },
    ]);
    expect((body().getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(passwordInput()).toBeNull();
  });

  it("offers a retry when it cannot read the setting, inside the lock too", async () => {
    let fail = true;
    const calls = serve(VIEW_LOCKED, (call) =>
      call.method === "GET" && fail
        ? Promise.reject(new ApiError(500, "internal", "boom"))
        : undefined,
    );
    const { fullState } = mount(<EnterpriseLock />, "owner");
    await fullState(true);
    await settle();
    const dialog = within(body().getByRole("dialog"));
    expect(dialog.queryByRole("alert")).not.toBeNull();
    expect(passwordInput()).toBeNull();

    fail = false;
    await act(async () => {
      fireEvent.click(dialog.getByRole("button"));
    });
    await settle();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(dialog.queryByRole("alert")).toBeNull();
    expect(passwordInput()).not.toBeNull();
  });

  it("does not show on Hosted", async () => {
    serve({ ...VIEW_OFF, available: false });
    const { view } = mount(<EnterpriseContractSection />, "owner");
    await settle();
    expect(body().queryByRole("checkbox")).toBeNull();
    expect(view.container.textContent).toBe("");
  });
});
