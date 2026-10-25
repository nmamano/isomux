// A room's GitHub link in Room settings (task 7fc83592): office owners only.
// The form shows the saved link and its status, Save sends the link PUT, and
// Unlink sends the DELETE. The server rules:
// server/test-support/routes-github-sync-rest.test.ts.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { RoomPane } = await import("./components/RoomPane.tsx");
const { onLanguage, stateWithSelfUser } =
  await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
type RoomWire = import("../shared/types.ts").RoomWire;
type GithubLinkWire = import("../shared/types.ts").GithubLinkWire;

const room: RoomWire = {
  id: "r1",
  name: "One",
  type: "office",
  prompt: null,
  canCloseWhenEmpty: true,
};

const saved: GithubLinkWire = {
  id: "link-1",
  roomId: "r1",
  repo: "Acme/Widgets",
  labels: ["isomux", "ready"],
  collaboratorsOnly: false,
  secretName: "GITHUB_SYNC_TOKEN",
  createdByUserId: "u1",
  createdAt: 1,
  status: { kind: "paused", reason: "missing" },
};

const calls: Array<{ method: string; path: string; body: unknown }> = [];
let link: GithubLinkWire | null = null;
setApiShim(async (method, path, body) => {
  calls.push({ method, path, body: JSON.parse(JSON.stringify(body ?? null)) });
  if (path === "/api/rooms/r1/github-link") {
    if (method === "GET") return { link };
    if (method === "PUT") return { link: { ...saved, ...(body as object) } };
    return undefined;
  }
  if (path.endsWith("/settings")) return { prompt: "", version: "0" };
  if (path.endsWith("/instructions")) return { instructions: "", version: "0" };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  return {};
});
afterAll(() => setApiShim(null));

function mount(role: "owner" | "member") {
  const base = stateWithSelfUser(null);
  return render(
    onLanguage(
      null,
      createElement(RoomPane, { roomId: room.id, onDeleted() {} }),
      {
        rooms: [room],
        sessionContext: { ...base.sessionContext!, role },
      },
    ),
  );
}

const linkCalls = () =>
  calls.filter((c) => c.path === "/api/rooms/r1/github-link");

function q<T extends Element>(
  view: ReturnType<typeof mount>,
  selector: string,
): T {
  const el = view.container.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

it("shows an owner the saved link and its status; Save sends the edited link, Unlink removes it", async () => {
  calls.length = 0;
  link = saved;
  const view = mount("owner");
  await act(async () => {});
  const repo = q<HTMLInputElement>(view, "[data-github-link-repo]");
  const labels = q<HTMLInputElement>(view, "[data-github-link-labels]");
  const secret = q<HTMLInputElement>(view, "[data-github-link-secret]");
  const collaborators = q<HTMLInputElement>(
    view,
    "[data-github-link-collaborators]",
  );
  expect(repo.value).toBe("Acme/Widgets");
  expect(labels.value.split(",").map((l) => l.trim())).toEqual([
    "isomux",
    "ready",
  ]);
  expect(secret.value).toBe("GITHUB_SYNC_TOKEN");
  expect(collaborators.checked).toBe(false);
  const status = q<HTMLElement>(view, "[data-github-link-status]");
  expect(status.getAttribute("data-kind")).toBe("paused");
  expect((status.textContent ?? "").trim().length).toBeGreaterThan(0);

  await act(async () => {
    fireEvent.change(repo, { target: { value: " acme/gadgets " } });
    fireEvent.change(labels, { target: { value: "a, b ,, " } });
    fireEvent.click(collaborators);
  });
  await act(async () =>
    fireEvent.click(q<HTMLElement>(view, "[data-github-link-save]")),
  );
  const puts = linkCalls().filter((c) => c.method === "PUT");
  expect(puts.map((c) => c.body)).toEqual([
    {
      repo: "acme/gadgets",
      labels: ["a", "b"],
      collaboratorsOnly: true,
      secretName: "GITHUB_SYNC_TOKEN",
    },
  ]);

  await act(async () =>
    fireEvent.click(q<HTMLElement>(view, "[data-github-link-unlink]")),
  );
  expect(linkCalls().filter((c) => c.method === "DELETE")).toHaveLength(1);
  view.unmount();
});

it("an owner with no link gets an empty form with the default secret and no Unlink", async () => {
  calls.length = 0;
  link = null;
  const view = mount("owner");
  await act(async () => {});
  expect(q<HTMLInputElement>(view, "[data-github-link-repo]").value).toBe("");
  expect(q<HTMLInputElement>(view, "[data-github-link-secret]").value).toBe(
    "GITHUB_SYNC_TOKEN",
  );
  expect(view.container.querySelector("[data-github-link-unlink]")).toBeNull();
  view.unmount();
});

it("a member sees no GitHub link and the pane never asks for it", async () => {
  calls.length = 0;
  link = saved;
  const view = mount("member");
  await act(async () => {});
  // The pane itself loaded.
  expect(calls.some((c) => c.path.endsWith("/instructions"))).toBe(true);
  expect(view.container.querySelector("[data-github-link]")).toBeNull();
  expect(linkCalls()).toEqual([]);
  view.unmount();
});
