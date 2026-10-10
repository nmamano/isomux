import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { AuditPane, TaskHistoryList } = await import("./AuditList.tsx");
const { setApiShim } = await import("../api.ts");
afterAll(() => setApiShim(null));
it("filters audit rows and restores the task named by its deletion snapshot", async () => {
  const calls: string[] = [];
  setApiShim(async (method,path) => {
    calls.push(`${method} ${path}`);
    if (method === "POST") return {};
    return {items:[{sequence:1,time:1,actor:{kind:"member",id:"u",name:"Member"},operation:"tasks.delete",targets:["task-1"],fields:[],deletedTask:{id:"task-1"}}],nextBefore:null};
  });
  const view = render(<AuditPane />);
  await act(async () => {});
  fireEvent.click(view.getByRole("button",{name:"Restore"}));
  await act(async () => {});
  expect(calls).toContain("POST /api/tasks/task-1/restore");
  expect((view.getByRole("button",{name:"Restored"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(view.getByLabelText("Target id"),{target:{value:"task-1"}});
  fireEvent.click(view.getByRole("button",{name:"Filter"}));
  await act(async () => {});
  expect(calls).toContain("GET /api/audit-log?targetId=task-1");
});
it("reads task-scoped history and renders changed values", async () => {
  const calls:string[] = [];
  setApiShim(async (method,path) => {
    calls.push(`${method} ${path}`);
    return {createdAt:1,createdBy:"Creator",items:[{sequence:1,time:2,actor:{name:"Editor"},operation:"tasks.update",targets:["task-1"],fields:["title"],taskChanges:{title:{old:"before-title",new:"after-title"}}}],nextBefore:null};
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
