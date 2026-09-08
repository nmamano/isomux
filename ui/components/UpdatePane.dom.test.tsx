import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const browser = await import("../reload-browser.ts");
const { UpdatePane } = await import("./UpdatePane.tsx");

type Status = NonNullable<typeof initialState.updateInfo>;
const oldStatus: Extract<Status, { mode: "release" }> = {
  mode: "release", updateAvailable: true, securityUpdate: null,
  current: { release: "v2026.9.1", version: "v2026.9.1" },
  latest: { tag: "v2026.9.8", publishedAt: null, url: null },
};
const newStatus: Status = { ...oldStatus, updateAvailable: false,
  current: { release: "v2026.9.8", version: "v2026.9.8" } };
const copy = {
  waiting: "Keep this pane open until the server restarts.",
  done: "The update is done. Refresh the browser to load the updated page.",
  unchanged: "The page reconnected, but the running version has not changed.",
  unverified: "The page reconnected, but the running version could not be checked.",
};

afterEach(() => setApiShim(null));

function fixture(initial: Status = oldStatus) {
  let response = initial;
  let failGet = false;
  let gets = 0;
  let post: Promise<unknown> = Promise.resolve({ ok: true });
  setApiShim(async (method, path) => {
    if (path !== "/api/office/update") throw new Error(`Unexpected path ${path}`);
    if (method === "POST") return post;
    gets++;
    if (failGet) throw new Error("Unavailable");
    return { busyAgents: 0, status: response };
  });
  const tree = (epoch: number, updateInfo = initial) => (
    <StateCtx.Provider value={{ ...initialState, hydrationEpoch: epoch, updateInfo,
      sessionContext: { userId: "owner", username: "owner", role: "owner", currentSessionPrefix: "session", connectionId: "connection" } }}>
      <UpdatePane onClose={() => {}} />
    </StateCtx.Provider>
  );
  const view = render(tree(1));
  return {
    view,
    gets: () => gets,
    failGet: () => { failGet = true; },
    deferPost: (promise: Promise<unknown>) => { post = promise; },
    async start() {
      await act(async () => {});
      await act(async () => { fireEvent.click(view.getByRole("button", { name: "Update now" })); });
      await act(async () => { fireEvent.click(view.getByRole("button", { name: "Update now (0 busy)" })); });
    },
    async reconnect(status: Status, storeStatus = initial) {
      response = status;
      await act(async () => { view.rerender(tree(2, storeStatus)); });
    },
  };
}

function resultIs(view: ReturnType<typeof render>, expected: "done" | "unchanged" | "unverified") {
  expect(view.queryByText(copy[expected]) !== null).toBe(true);
  for (const other of ["done", "unchanged", "unverified"] as const) {
    if (other !== expected) expect(view.queryByText(copy[other]) === null).toBe(true);
  }
  expect(view.queryByText(copy.waiting) === null).toBe(true);
  const reload = spyOn(browser, "reloadBrowser").mockImplementation(() => {});
  try {
    fireEvent.click(view.getByRole("button", { name: "Refresh browser" }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally { reload.mockRestore(); }
}

describe("update guidance", () => {
  it("keeps the pane and version context visible until a reconnect", async () => {
    const f = fixture();
    await f.start();
    expect(f.view.queryByText(copy.waiting) !== null).toBe(true);
    expect(f.view.queryByText("v2026.9.1") !== null).toBe(true);
    expect(f.view.queryByText("v2026.9.8") !== null).toBe(true);
    expect(f.view.queryByRole("button", { name: "Refresh browser" }) === null).toBe(true);
  });

  it("uses the refetched version while the store still holds the old version", async () => {
    const f = fixture();
    await f.start();
    const before = f.gets();
    await f.reconnect(newStatus);
    expect(f.gets()).toBe(before + 1);
    resultIs(f.view, "done");
  });

  it("reports an unchanged version separately from an unverified version", async () => {
    const f = fixture();
    await f.start();
    await f.reconnect(oldStatus);
    resultIs(f.view, "unchanged");
    expect(f.view.queryByText("If nothing happens after a few minutes, check the updater's status file on the server.") !== null).toBe(true);
  });

  it("reports a failed status check without claiming success", async () => {
    const f = fixture();
    await f.start();
    f.failGet();
    await f.reconnect(newStatus);
    resultIs(f.view, "unverified");
  });

  it("cannot verify an unknown running version", async () => {
    const f = fixture();
    await f.start();
    await f.reconnect({ ...oldStatus, current: { release: null, version: null } });
    resultIs(f.view, "unverified");
  });

  it("keeps the result when the server returns in commit mode", async () => {
    const f = fixture();
    await f.start();
    const commit: Status = { mode: "commit", updateAvailable: false,
      current: { release: null, sha: "new-sha" }, latest: null,
      releaseStanding: "unknown", mainAhead: 0 };
    await f.reconnect(commit, commit);
    resultIs(f.view, "done");
  });

  it("shows guidance while the update request is still pending", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.deferPost(new Promise((r) => { resolve = r; }));
    await f.start();
    expect(f.view.queryByText(copy.waiting) !== null).toBe(true);
    await act(async () => { resolve({ ok: true }); });
  });

  it("adds the refresh reminder to commit mode without a reconnect check", async () => {
    const status: Status = { mode: "commit", updateAvailable: true,
      current: { release: null, sha: "old-sha" }, latest: null,
      releaseStanding: "unknown", mainAhead: 1 };
    const f = fixture(status);
    expect(f.view.queryByText("Refresh the browser after the server restarts.") !== null).toBe(true);
    await f.reconnect(status);
    expect(f.gets()).toBe(0);
  });
});
