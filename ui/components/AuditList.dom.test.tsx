import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { AuditPane, TaskHistoryList } = await import("./AuditList.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { t } = translatorFor("en");
afterAll(() => setApiShim(null));
it("names a deleted task by its snapshot and restores it", async () => {
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
      ],
      nextBefore: null,
    };
  });
  const view = render(<AuditPane />);
  await act(async () => {});
  expect(view.container.querySelector('[title="task-1"]')?.textContent).toBe(
    "A deleted task title",
  );
  fireEvent.click(view.getByRole("button", { name: t("audit.restore") }));
  await act(async () => {});
  expect(calls).toContain("POST /api/tasks/task-1/restore");
  expect(
    (
      view.getByRole("button", {
        name: t("audit.restored"),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
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
          fields: ["title", "assignee", "assigneeAgentId", "createdByAgentId"],
          taskChanges: {
            title: { old: "before-title", new: "after-title" },
            assignee: { old: "Old Holder", new: "New Holder" },
            assigneeAgentId: { old: "agent-1-old", new: "agent-2-new" },
            createdByAgentId: { old: null, new: "agent-3-maker" },
          },
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
  const text = view.container.textContent ?? "";
  expect(text).toContain("before-title");
  expect(text).toContain("after-title");
  // The agent id rides next to the assignee name (task 83f71be9). History
  // shows the name change once; the id that changed with it is bookkeeping.
  expect(text).toContain("Old Holder");
  expect(text).toContain("New Holder");
  expect(text).not.toContain("assigneeAgentId");
  expect(text).not.toContain("createdByAgentId");
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
    expect(view.container.querySelector('form [role="alert"]')).not.toBeNull();
    expect(
      (view.container.querySelector('[name="actorId"]') as HTMLSelectElement)
        .value,
    ).toBe("");
  } finally {
    process.env.TZ = previousZone;
  }
});
it("shows each row's payload, and survives a wrong-shaped secret use", async () => {
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
        // An object host would crash the render if it reached the page.
        secretUse: { host: {}, method: "GET", path: "/wrong" },
      },
      {
        sequence: 3,
        time: 3,
        actor: { kind: "agent", id: "a1", name: "Helper", ownerId: "u" },
        operation: "office.setSettings",
        targets: ["office"],
        fields: ["prompt", "version"],
        promptContent: "Line one\nLine two",
      },
      {
        sequence: 4,
        time: 4,
        actor: { kind: "member", id: "u", name: "Member" },
        operation: "memory.replace",
        targets: ["memory:office:office"],
        fields: ["content"],
        memoryContent: "- note\n",
      },
    ],
    nextBefore: null,
  }));
  const view = render(<AuditPane />);
  await act(async () => {});
  const rows = view.container.querySelectorAll("li");
  expect(rows).toHaveLength(4);
  expect(rows[0].textContent).toContain("GET api.github.com/user");
  expect(rows[1].textContent).toContain("OTHER");
  expect(rows[1].textContent).not.toContain("/wrong");
  expect(rows[2].querySelector("pre")?.textContent).toBe("Line one\nLine two");
  expect(rows[3].querySelector("pre")?.textContent).toBe("- note\n");
});
// Member-memory rows were written as memory:boss:<id> before task f41c93e9 and
// as memory:member:<id> after it: both read as the same member memory.
it("labels member-memory rows of both target names alike", async () => {
  const row = (sequence: number, target: string) => ({
    sequence,
    time: sequence,
    actor: { kind: "member", id: "u", name: "Member" },
    operation: "memory.replace",
    targets: [target],
    fields: ["content"],
    memoryContent: "- note\n",
  });
  setApiShim(async () => ({
    items: [
      row(1, "memory:boss:u9"),
      row(2, "memory:member:u9"),
      row(3, "memory:toString:u9"),
    ],
    nextBefore: null,
  }));
  const view = render(<AuditPane />);
  await act(async () => {});
  const label = (target: string) =>
    view.container.querySelector(`[title="${target}"]`)?.textContent;
  const legacy = label("memory:boss:u9");
  expect(legacy).toBeTruthy();
  expect(legacy).not.toContain("memory:");
  expect(legacy).toContain("u9");
  expect(label("memory:member:u9")).toBe(legacy);
  // A prototype key is not a scope: the raw target id shows.
  expect(label("memory:toString:u9")).toBe("memory:toString:u9");
});
