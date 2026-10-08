import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { StateCtx, DispatchCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { UpdatePane } = await import("./UpdatePane.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { formatDateTime } = await import("../../shared/i18n/time.ts");

type Status = NonNullable<typeof initialState.updateInfo>;
const oldStatus: Extract<Status, { mode: "release" }> = {
  mode: "release",
  updateAvailable: true,
  securityUpdate: null,
  current: { release: "v2026.9.1", version: "v2026.9.1" },
  latest: { tag: "v2026.9.8", publishedAt: null, url: null },
  apply: { kind: "host" },
};
const t = translatorFor("en").t;

afterEach(() => setApiShim(null));

function fixture(
  initial: Status = oldStatus,
  role: "owner" | "member" = "owner",
) {
  let gets = 0;
  let post: () => Promise<unknown> = async () => ({ ok: true });
  const actions: { type: string }[] = [];
  setApiShim(async (method, path) => {
    if (path !== "/api/office/update")
      throw new Error(`Unexpected path ${path}`);
    if (method === "POST") return post();
    gets++;
    return { busyAgents: 0, status: initial };
  });
  const tree = (updateInfo = initial) => (
    <StateCtx.Provider
      value={{
        ...initialState,
        hydrationEpoch: 1,
        updateInfo,
        sessionContext: {
          userId: role,
          username: role,
          role,
          currentSessionPrefix: "session",
          connectionId: "connection",
        },
      }}
    >
      <DispatchCtx.Provider value={(a) => void actions.push(a)}>
        <UpdatePane onClose={() => {}} />
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
  const view = render(tree());
  return {
    view,
    actions,
    gets: () => gets,
    failPost: () => {
      post = async () => {
        throw new Error("polkit denied");
      };
    },
    async start() {
      await act(async () => {});
      await act(async () => {
        fireEvent.click(
          view.getByRole("button", { name: t("settings.update.updateNow") }),
        );
      });
      await act(async () => {
        fireEvent.click(
          view.getByRole("button", {
            name: t("settings.update.updateNowBusy", { count: 0 }),
          }),
        );
      });
    },
    async rerender(status: Status) {
      await act(async () => {
        view.rerender(tree(status));
      });
    },
  };
}

describe("update trigger", () => {
  it("an accepted launch hands over to the update screen", async () => {
    const f = fixture();
    await f.start();
    expect(f.actions).toEqual([
      { type: "update_launching" },
      { type: "update_clicked" },
    ]);
    // The pane keeps no reconnect check of its own: the busy count is its
    // only read, and a status change does not trigger another.
    const reads = f.gets();
    await f.rerender({
      ...oldStatus,
      updateAvailable: false,
      current: { release: "v2026.9.8", version: "v2026.9.8" },
    });
    expect(f.gets()).toBe(reads);
  });

  it("a refused launch stays in the pane with the error", async () => {
    const f = fixture();
    f.failPost();
    await f.start();
    expect(f.actions).toEqual([{ type: "update_launching" }]);
    expect(f.view.queryByText("polkit denied")).not.toBeNull();
    expect(
      f.view.queryByRole("button", {
        name: t("settings.update.updateNowBusy", { count: 0 }),
      }),
    ).not.toBeNull();
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
    expect(f.view.queryByText(t("settings.update.stepRefresh")) !== null).toBe(
      true,
    );
    await f.rerender(status);
    expect(f.gets()).toBe(0);
  });
});

describe("last update note", () => {
  const NOTE = "Restored installer-managed firewall rule: 443/tcp.";
  const withNote: Status = {
    ...oldStatus,
    outcome: {
      target: "v2026.9.1",
      at: "2026-10-07T12:00:00Z",
      messages: [NOTE],
    },
  };

  it("an owner sees the installer's messages under a dated heading", () => {
    const { view } = fixture(withNote);
    // The installer's sentence, as the box wrote it.
    expect(view.queryByText(NOTE)).not.toBeNull();
    const date = formatDateTime(
      "en",
      Date.parse("2026-10-07T12:00:00Z"),
      "fullDate",
    );
    expect(
      view.queryByRole("heading", {
        name: t("settings.update.lastUpdate", { date }),
      }),
    ).not.toBeNull();
  });

  it("a member does not", () => {
    const { view } = fixture(withNote, "member");
    expect(view.queryByText(NOTE)).toBeNull();
  });

  it("no note, no heading", () => {
    const { view } = fixture();
    expect(view.queryByRole("heading", { name: /2026/ })).toBeNull();
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
      kubernetes:
        "https://isomux.com/docs/hosting-kubernetes#update-the-office",
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
    const tagged = renderImage(
      imageStatus("kubernetes", "v2026.9.1"),
      "member",
    );
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

  it("the host path shows an unpinned box as its full version", () => {
    const hostUnpinned = {
      ...oldStatus,
      current: { release: null, version: sha },
    } as Status;
    const { view } = renderImage(hostUnpinned, "member");
    expect(view.queryByText(sha)).not.toBeNull();
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
      copied.includes(
        "https://isomux.com/docs/hosting-render#update-the-office",
      ),
    ).toBe(true);
  });
});

describe("host office on or past the latest release", () => {
  const en = translatorFor("en");
  const onLatest: Status = {
    ...oldStatus,
    updateAvailable: false,
    current: { release: "v2026.9.8", version: "v2026.9.8" },
  };
  // A pre-release box: Latest is older than what runs.
  const pastLatest: Status = {
    ...oldStatus,
    updateAvailable: false,
    current: { release: "v2026.9.9", version: "v2026.9.9" },
  };

  it("reads as up to date and offers no update, for owners and members", async () => {
    for (const status of [onLatest, pastLatest]) {
      for (const role of ["owner", "member"] as const) {
        const f = fixture(status, role);
        await act(async () => {});
        const { view } = f;
        expect(
          view.queryByRole("heading", {
            name: en.t("settings.update.upToDateTitle"),
          }),
        ).not.toBeNull();
        expect(
          view.queryByText(en.t("settings.update.upToDate")),
        ).not.toBeNull();
        expect(
          view.queryByRole("heading", {
            name: en.t("settings.update.newRelease"),
          }),
        ).toBeNull();
        expect(
          view.queryByRole("button", {
            name: en.t("settings.update.updateNow"),
          }),
        ).toBeNull();
        // No release body: neither version line nor the latest tag.
        expect(view.container.textContent?.includes("v2026.9.8")).toBe(false);
        expect(f.gets()).toBe(0);
        view.unmount();
      }
    }
  });

  it("keeps the owner's last update note", () => {
    const NOTE = "Restored installer-managed firewall rule: 443/tcp.";
    const status: Status = {
      ...onLatest,
      outcome: {
        target: "v2026.9.8",
        at: "2026-10-07T12:00:00Z",
        messages: [NOTE],
      },
    };
    const owner = fixture(status);
    expect(owner.view.queryByText(NOTE)).not.toBeNull();
    owner.view.unmount();
    const member = fixture(status, "member");
    expect(member.view.queryByText(NOTE)).toBeNull();
  });
});
