// The Enterprise Contract box in Settings -> Office -> Enterprise (tasks
// 8b80e61f, f1304a60 and ce8878c8). The box and the secret live here only: the office stays usable
// while it is locked, and the server refuses messages to agents instead.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import {
  blockShape,
  deferred,
  heldControls,
} from "../test-support/held-shape.ts";
import type { EnterpriseViewRes } from "../../shared/contract-shapes.ts";

setUpDomTestFile();

const { act, fireEvent, render, within, cleanup } =
  await import("@testing-library/react");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
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

beforeEach(() => window.localStorage.clear());
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
  return { view };
}

const body = () => within(document.body);
const passwordInput = () =>
  document.body.querySelector<HTMLInputElement>('input[type="password"]');
const settle = () => act(async () => {});

describe("Settings -> Office -> Enterprise", () => {
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

  it("offers a retry when it cannot read the setting", async () => {
    let fail = true;
    const calls = serve(VIEW_LOCKED, (call) =>
      call.method === "GET" && fail
        ? Promise.reject(new ApiError(500, "internal", "boom"))
        : undefined,
    );
    mount(<EnterpriseContractSection />, "owner");
    await settle();
    expect(body().queryByRole("alert")).not.toBeNull();
    expect(passwordInput()).toBeNull();

    fail = false;
    await act(async () => {
      fireEvent.click(body().getByRole("button"));
    });
    await settle();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(body().queryByRole("alert")).toBeNull();
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

// The UI rule that a view keeps its layout while it loads (task 3755fad4):
// until the setting answers, the section draws the layout this device saw last,
// every control disabled, so nothing moves when the answer arrives.
describe("Settings -> Office -> Enterprise while the setting loads", () => {
  // GET waits for `answer`; check answers with the same view.
  function serveLater() {
    const read = deferred<EnterpriseViewRes>();
    serve(VIEW_OFF, (call) => {
      if (call.method === "GET") return read.promise;
      if (call.path === "/api/office/enterprise/check") return read.promise;
      return undefined;
    });
    return read;
  }
  const busy = (root: Element) => root.querySelector('[aria-busy="true"]');

  it("draws the box, disabled, on a device that never read the setting", async () => {
    const read = serveLater();
    const { view } = mount(<EnterpriseContractSection />, "owner");
    await settle();
    expect(busy(view.container)).not.toBeNull();
    const box = body().getByRole("checkbox") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    const held = blockShape(view.container);

    await act(async () => {
      read.resolve(VIEW_OFF);
    });
    await settle();
    expect(busy(view.container)).toBeNull();
    expect((body().getByRole("checkbox") as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(blockShape(view.container)).toBe(held);
  });

  const SHAPES: [string, EnterpriseViewRes][] = [
    ["off", VIEW_OFF],
    ["on and locked", VIEW_LOCKED],
    ["locked with a problem", { ...VIEW_LOCKED, problem: "not_signed" }],
    ["connected", VIEW_CONNECTED],
    ["connected with a problem", { ...VIEW_CONNECTED, problem: "bad_secret" }],
  ];
  for (const [name, shown] of SHAPES) {
    it(`holds the layout it showed last (${name}) until the answer arrives`, async () => {
      // A first visit shows the answer, and the device keeps its layout.
      serve(shown);
      mount(<EnterpriseContractSection />, "owner");
      await settle();
      cleanup();

      const read = serveLater();
      const { view } = mount(<EnterpriseContractSection />, "owner");
      await settle();
      expect(busy(view.container)).not.toBeNull();
      const controls = heldControls(view.container);
      expect(controls.length).toBeGreaterThan(0);
      expect(
        controls.filter((el) => !(el as HTMLInputElement).disabled),
      ).toHaveLength(0);
      // Nothing from the last answer is shown as current, and no empty alert.
      expect(view.container.textContent).not.toContain(ANSWER.company);
      expect(body().queryByRole("alert")).toBeNull();
      const held = blockShape(view.container);

      await act(async () => {
        read.resolve(shown);
      });
      await settle();
      expect(busy(view.container)).toBeNull();
      expect(blockShape(view.container)).toBe(held);
    });
  }
});
