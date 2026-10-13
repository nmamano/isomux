import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { AuditPane, TaskHistoryList } = await import("./AuditList.tsx");
const { setApiShim } = await import("../api.ts");
afterAll(() => setApiShim(null));
it("filters audit rows and restores the task named by its deletion snapshot", async () => {
  const calls: string[] = [];
  setApiShim(async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === "POST") return {};
    return {
      items: [
        {
          sequence: 1,
          time: 1,
          actor: { kind: "member", id: "u", name: "Member" },
          operation: "tasks.delete",
          targets: ["task-1"],
          fields: [],
          deletedTask: { id: "task-1", title: "A deleted task title" },
        },
        {
          sequence: 2,
          time: 2,
          actor: { kind: "member", id: "u", name: "Member" },
          operation: "tasks.update",
          targets: ["task-2"],
          fields: ["title"],
          taskChanges: { title: { old: "old-content", new: "new-content" } },
        },
      ],
      nextBefore: null,
    };
  });
  const view = render(<AuditPane />);
  await act(async () => {});
  expect(view.container.querySelector('[title="task-1"]')?.textContent).toBe(
    "A deleted task title",
  );
  expect(view.getByText("old-content").textContent).toBe("old-content");
  expect(view.getAllByText("new-content").length).toBeGreaterThan(0);
  fireEvent.click(view.getByRole("button", { name: "Restore" }));
  await act(async () => {});
  expect(calls).toContain("POST /api/tasks/task-1/restore");
  expect(
    (view.getByRole("button", { name: "Restored" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(view.getByLabelText("Target id"), {
    target: { value: "task-1" },
  });
  fireEvent.click(view.getByRole("button", { name: "Filter" }));
  await act(async () => {});
  expect(calls).toContain("GET /api/audit-log?targetId=task-1");
});
it("reads task-scoped history and renders changed values", async () => {
  const calls: string[] = [];
  setApiShim(async (method, path) => {
    calls.push(`${method} ${path}`);
    return {
      createdAt: 1,
      createdBy: "Creator",
      items: [
        {
          sequence: 1,
          time: 2,
          actor: { name: "Editor" },
          operation: "tasks.update",
          targets: ["task-1"],
          fields: ["title"],
          taskChanges: { title: { old: "before-title", new: "after-title" } },
        },
      ],
      nextBefore: null,
    };
  });
  const view = render(<TaskHistoryList id="task-1" version="v1" />);
  expect(calls).toHaveLength(0);
  await act(async () => {
    const details = view.container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
  });
  await act(async () => {});
  expect(calls).toEqual(["GET /api/tasks/task-1/history"]);
  expect(view.container.textContent).toContain("before-title");
  expect(view.container.textContent).toContain("after-title");
});

it("maps roster IDs and local minute bounds, keeps filters when paging, and clears the cursor", async () => {
  // bun test runs in UTC with TZ unset, and deleting TZ falls back to the
  // system zone, so restore the zone the process actually had.
  const previousZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = "America/Los_Angeles";
  try {
    expect(new Date(2026, 9, 10, 14, 30).getTimezoneOffset()).not.toBe(0);
    const { StateCtx } = await import("../store.tsx");
    const calls: string[] = [];
    setApiShim(async (_method, path) => {
      calls.push(path);
      return { items: [], nextBefore: 17 };
    });
    let base!: React.ContextType<typeof StateCtx>;
    const { useContext } = await import("react");
    function Fixture() {
      base = useContext(StateCtx);
      return (
        <StateCtx.Provider
          value={{
            ...base,
            users: new Map([
              [
                "member",
                {
                  id: "member-id",
                  name: "Long Member Name",
                  role: "owner",
                  avatarColor: "#fff",
                  avatarVariant: "classic",
                  createdAt: 1,
                },
              ],
            ]),
          }}
        >
          <AuditPane />
        </StateCtx.Provider>
      );
    }
    const view = render(<Fixture />);
    await act(async () => {});
    const field = (name: string) =>
      view.container.querySelector(`[name="${name}"]`)!;
    const change = (name: string, value: string) =>
      fireEvent.change(field(name), { target: { value } });
    change("actorKind", "member");
    expect(field("actorId").tagName).toBe("SELECT");
    change("actorId", "member-id");
    change("ownerId", "member-id");
    change("operation", "auth.claim");
    change("from", "2026-10-10T14:30");
    change("to", "2026-10-10T14:30");
    const beforeSubmit = calls.length;
    fireEvent.submit(view.container.querySelector("form")!);
    await act(async () => {});
    expect(calls).toHaveLength(beforeSubmit + 1);
    const params = new URL(calls.at(-1)!, "http://fixture").searchParams;
    expect(params.get("actorKind")).toBe("member");
    expect(params.get("actorId")).toBe("member-id");
    expect(params.get("ownerId")).toBe("member-id");
    expect(params.get("operation")).toBe("auth.claim");
    const start = new Date(2026, 9, 10, 14, 30).getTime();
    expect(Number(params.get("from"))).toBe(start);
    expect(Number(params.get("to"))).toBe(start + 59_999);
    fireEvent.click(view.container.querySelector("section > button")!);
    await act(async () => {});
    const older = new URL(calls.at(-1)!, "http://fixture").searchParams;
    expect(older.get("before")).toBe("17");
    for (const [key, value] of params) expect(older.get(key)).toBe(value);
    fireEvent.click(
      view.container.querySelector('form button[type="button"]')!,
    );
    await act(async () => {});
    expect(calls.at(-1)).toBe("/api/audit-log?");
    for (const control of view.container.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("[name]"))
      expect(control.value).toBe("");
    const beforeInvalid = calls.length;
    change("actorId", "agent-1");
    change("actorKind", "member");
    change("from", "2026-10-11T14:30");
    change("to", "2026-10-10T14:30");
    fireEvent.submit(view.container.querySelector("form")!);
    await act(async () => {});
    expect(calls).toHaveLength(beforeInvalid);
    expect(view.queryByRole("alert")).not.toBeNull();
    expect(
      (view.container.querySelector('[name="actorId"]') as HTMLSelectElement)
        .value,
    ).toBe("");
  } finally {
    process.env.TZ = previousZone;
  }
});
it("shows the request of a secret use, and survives a wrong-shaped one", async () => {
  setApiShim(async () => ({
    items: [
      {
        sequence: 1,
        time: 1,
        actor: {
          kind: "secret_proxy",
          id: "secret-proxy",
          name: "",
          ownerId: "u",
        },
        operation: "secrets.use",
        targets: ["GH_TOKEN"],
        fields: [],
        secretUse: { host: "api.github.com", method: "GET", path: "/user" },
      },
      {
        sequence: 2,
        time: 2,
        actor: { kind: "secret_proxy", id: "secret-proxy", name: "" },
        operation: "secrets.use",
        targets: ["OTHER"],
        fields: [],
        secretUse: { host: 5, method: null },
      },
    ],
    nextBefore: null,
  }));
  const view = render(<AuditPane />);
  await act(async () => {});
  const rows = view.container.querySelectorAll("li");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("GET api.github.com/user");
  expect(rows[1].textContent).toContain("OTHER");
  expect(rows[1].textContent).not.toContain("null");
});
