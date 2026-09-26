import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const browser = await import("../reload-browser.ts");
const { UpdatePane } = await import("./UpdatePane.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

type Status = NonNullable<typeof initialState.updateInfo>;
const oldStatus: Extract<Status, { mode: "release" }> = {
  mode: "release",
  updateAvailable: true,
  securityUpdate: null,
  current: { release: "v2026.9.1", version: "v2026.9.1" },
  latest: { tag: "v2026.9.8", publishedAt: null, url: null },
  apply: { kind: "host" },
};
const newStatus: Status = {
  ...oldStatus,
  updateAvailable: false,
  current: { release: "v2026.9.8", version: "v2026.9.8" },
};
const copy = {
  waiting: "Keep this pane open until the server restarts.",
  done: "The update is done. Refresh the browser to load the updated page.",
  unchanged: "The page reconnected, but the running version has not changed.",
  unverified:
    "The page reconnected, but the running version could not be checked.",
};

afterEach(() => setApiShim(null));

function fixture(initial: Status = oldStatus) {
  let response = initial;
  let failGet = false;
  let gets = 0;
  let post: Promise<unknown> = Promise.resolve({ ok: true });
  setApiShim(async (method, path) => {
    if (path !== "/api/office/update")
      throw new Error(`Unexpected path ${path}`);
    if (method === "POST") return post;
    gets++;
    if (failGet) throw new Error("Unavailable");
    return { busyAgents: 0, status: response };
  });
  const tree = (epoch: number, updateInfo = initial) => (
    <StateCtx.Provider
      value={{
        ...initialState,
        hydrationEpoch: epoch,
        updateInfo,
        sessionContext: {
          userId: "owner",
          username: "owner",
          role: "owner",
          currentSessionPrefix: "session",
          connectionId: "connection",
        },
      }}
    >
      <UpdatePane onClose={() => {}} />
    </StateCtx.Provider>
  );
  const view = render(tree(1));
  return {
    view,
    gets: () => gets,
    failGet: () => {
      failGet = true;
    },
    deferPost: (promise: Promise<unknown>) => {
      post = promise;
    },
    async start() {
      await act(async () => {});
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Update now" }));
      });
      await act(async () => {
        fireEvent.click(
          view.getByRole("button", { name: "Update now (0 busy)" }),
        );
      });
    },
    async reconnect(status: Status, storeStatus = initial) {
      response = status;
      await act(async () => {
        view.rerender(tree(2, storeStatus));
      });
    },
  };
}

function resultIs(
  view: ReturnType<typeof render>,
  expected: "done" | "unchanged" | "unverified",
) {
  expect(view.queryByText(copy[expected]) !== null).toBe(true);
  for (const other of ["done", "unchanged", "unverified"] as const) {
    if (other !== expected)
      expect(view.queryByText(copy[other]) === null).toBe(true);
  }
  expect(view.queryByText(copy.waiting) === null).toBe(true);
  const reload = spyOn(browser, "reloadBrowser").mockImplementation(() => {});
  try {
    fireEvent.click(view.getByRole("button", { name: "Refresh browser" }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    reload.mockRestore();
  }
}

describe("update guidance", () => {
  it("keeps the pane and version context visible until a reconnect", async () => {
    const f = fixture();
    await f.start();
    expect(f.view.queryByText(copy.waiting) !== null).toBe(true);
    expect(f.view.queryByText("v2026.9.1") !== null).toBe(true);
    expect(f.view.queryByText("v2026.9.8") !== null).toBe(true);
    expect(
      f.view.queryByRole("button", { name: "Refresh browser" }) === null,
    ).toBe(true);
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
    expect(
      f.view.queryByText(
        "If nothing happens after a few minutes, check the updater's status file on the server.",
      ) !== null,
    ).toBe(true);
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
    await f.reconnect({
      ...oldStatus,
      current: { release: null, version: null },
    });
    resultIs(f.view, "unverified");
  });

  it("keeps the result when the server returns in commit mode", async () => {
    const f = fixture();
    await f.start();
    const commit: Status = {
      mode: "commit",
      updateAvailable: false,
      current: { release: null, sha: "new-sha" },
      latest: null,
      releaseStanding: "unknown",
      mainAhead: 0,
    };
    await f.reconnect(commit, commit);
    resultIs(f.view, "done");
  });

  it("shows guidance while the update request is still pending", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.deferPost(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await f.start();
    expect(f.view.queryByText(copy.waiting) !== null).toBe(true);
    await act(async () => {
      resolve({ ok: true });
    });
  });

  it("adds the refresh reminder to commit mode without a reconnect check", async () => {
    const status: Status = {
      mode: "commit",
      updateAvailable: true,
      current: { release: null, sha: "old-sha" },
      latest: null,
      releaseStanding: "unknown",
      mainAhead: 1,
    };
    const f = fixture(status);
    expect(
      f.view.queryByText("Refresh the browser after the server restarts.") !==
        null,
    ).toBe(true);
    await f.reconnect(status);
    expect(f.gets()).toBe(0);
  });
});

describe("image deployments (no host updater)", () => {
  const en = translatorFor("en");
  const sha = "c".repeat(40);
  const imageStatus = (
    guide: "kubernetes" | "render" | "container",
    release: string | null = null,
  ): Status => ({
    ...oldStatus,
    current: { release, version: release ?? sha },
    apply: { kind: "image", guide },
  });

  function renderImage(status: Status, role: "owner" | "member") {
    const calls: string[] = [];
    setApiShim(async (method, path) => {
      calls.push(`${method} ${path}`);
      return { busyAgents: 0, status };
    });
    const view = render(
      <StateCtx.Provider
        value={{
          ...initialState,
          hydrationEpoch: 1,
          updateInfo: status,
          sessionContext: {
            userId: role,
            username: role,
            role,
            currentSessionPrefix: "session",
            connectionId: "connection",
          },
        }}
      >
        <UpdatePane onClose={() => {}} />
      </StateCtx.Provider>,
    );
    return { view, calls };
  }

  it("offers no in-office update and calls no update route, for owners and members", async () => {
    for (const role of ["owner", "member"] as const) {
      const { view, calls } = renderImage(imageStatus("kubernetes"), role);
      await act(async () => {});
      expect(
        view.queryByRole("button", { name: en.t("settings.update.updateNow") }),
      ).toBeNull();
      expect(view.queryByText(en.t("settings.update.ownerOnly"))).toBeNull();
      expect(calls).toEqual([]);
      view.unmount();
    }
  });

  it("links the platform guide and names the platform action", async () => {
    const guides = {
      kubernetes: "https://isomux.com/docs/hosting-kubernetes#update-the-office",
      render: "https://isomux.com/docs/hosting-render#update-the-office",
      container:
        "https://github.com/nmamano/isomux/blob/main/deploy/container/reference.md#updates",
    } as const;
    for (const guide of ["kubernetes", "render", "container"] as const) {
      const { view } = renderImage(imageStatus(guide), "owner");
      const link = view.getByRole("link", {
        name: en.t("settings.update.updateGuide"),
      });
      expect(link.getAttribute("href")).toBe(guides[guide]);
      const action =
        guide === "render"
          ? en.t("settings.update.imageRender")
          : en.t("settings.update.imageRelease", { tag: "v2026.9.8" });
      expect(link.parentElement?.textContent?.startsWith(action)).toBe(true);
      view.unmount();
    }
  });

  it("shows an untagged image as its short commit and a tagged one as its release", () => {
    const untagged = renderImage(imageStatus("render"), "member");
    expect(
      untagged.view.queryByText(
        en.t("updateNotice.running", { sha: sha.slice(0, 7) }),
      ),
    ).not.toBeNull();
    expect(untagged.view.container.textContent?.includes(sha)).toBe(false);
    untagged.view.unmount();
    const tagged = renderImage(imageStatus("kubernetes", "v2026.9.1"), "member");
    expect(tagged.view.queryByText("v2026.9.1")).not.toBeNull();
  });

  // The pane in a quiet image state: the up-to-date branch, with no platform
  // action, no guide link and no deploy text on the clipboard.
  async function expectQuiet(view: ReturnType<typeof render>) {
    expect(
      view.queryByRole("heading", {
        name: en.t("settings.update.upToDateTitle"),
      }),
    ).not.toBeNull();
    expect(view.queryByText(en.t("settings.update.upToDate"))).not.toBeNull();
    expect(
      view.queryByRole("heading", { name: en.t("settings.update.newRelease") }),
    ).toBeNull();
    expect(
      view.queryByRole("link", { name: en.t("settings.update.updateGuide") }),
    ).toBeNull();
    let copied = "unset";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (copied = text) },
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: en.t("common.copy") }));
    });
    expect(copied.includes("To update")).toBe(false);
    expect(copied.includes("isomux.com/docs")).toBe(false);
    expect(copied.includes("v2026.9.8")).toBe(false);
  }

  it("a quiet image status reads as up to date, with or without a latest release", async () => {
    for (const status of [
      { ...imageStatus("render"), updateAvailable: false },
      { ...imageStatus("kubernetes"), updateAvailable: false, latest: null },
      {
        ...imageStatus("container", "v2026.9.8"),
        updateAvailable: false,
      },
    ] as Status[]) {
      const { view, calls } = renderImage(status, "owner");
      await expectQuiet(view);
      expect(calls).toEqual([]);
      view.unmount();
    }
  });

  it("an image notice clears when the status goes quiet", async () => {
    const available = imageStatus("render");
    const quiet = { ...available, updateAvailable: false } as Status;
    setApiShim(async () => {
      throw new Error("no update route on an image");
    });
    const tree = (updateInfo: Status) => (
      <StateCtx.Provider
        value={{
          ...initialState,
          hydrationEpoch: 1,
          updateInfo,
          sessionContext: {
            userId: "owner",
            username: "owner",
            role: "owner",
            currentSessionPrefix: "session",
            connectionId: "connection",
          },
        }}
      >
        <UpdatePane onClose={() => {}} />
      </StateCtx.Provider>
    );
    const view = render(tree(available));
    expect(
      view.queryByRole("link", { name: en.t("settings.update.updateGuide") }),
    ).not.toBeNull();
    await act(async () => {
      view.rerender(tree(quiet));
    });
    await expectQuiet(view);
  });

  it("the host path keeps its version display and body when quiet", () => {
    const hostQuiet = {
      ...oldStatus,
      updateAvailable: false,
      current: { release: null, version: sha },
    } as Status;
    const { view } = renderImage(hostQuiet, "member");
    expect(view.queryByText(sha)).not.toBeNull();
    expect(
      view.queryByRole("heading", { name: en.t("settings.update.newRelease") }),
    ).not.toBeNull();
  });

  it("copies the platform action, not the host updater instructions", async () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (copied = text) },
    });
    const host = renderImage(oldStatus, "owner");
    await act(async () => {
      fireEvent.click(
        host.view.getByRole("button", { name: en.t("common.copy") }),
      );
    });
    expect(copied.includes("isomux-update v2026.9.8")).toBe(true);
    host.view.unmount();

    const { view } = renderImage(imageStatus("render"), "owner");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: en.t("common.copy") }));
    });
    expect(copied.includes("isomux-update")).toBe(false);
    expect(copied.includes(`commit ${sha.slice(0, 7)}`)).toBe(true);
    expect(
      copied.includes("https://isomux.com/docs/hosting-render#update-the-office"),
    ).toBe(true);
  });
});
