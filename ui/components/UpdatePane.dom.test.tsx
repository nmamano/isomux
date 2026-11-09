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
  let post: () => Promise<unknown> = async () => ({ ok: true });
  const posts: unknown[] = [];
  const actions: { type: string }[] = [];
  setApiShim(async (method, path, body) => {
    if (path !== "/api/office/update")
      throw new Error(`Unexpected path ${path}`);
    if (method !== "POST") return { busyAgents: 0, status: initial };
    posts.push(body);
    return post();
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
    posts,
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
  };
}

// The pane in a quiet state: the up-to-date branch, with no release body and
// no guide link. The copy button still copies (task acddc30f); returns what it
// put on the clipboard.
async function expectQuiet(view: ReturnType<typeof render>): Promise<string> {
  expect(
    view.queryByRole("heading", {
      name: t("settings.update.upToDateTitle"),
    }),
  ).not.toBeNull();
  expect(view.queryByText(t("settings.update.upToDate"))).not.toBeNull();
  expect(
    view.queryByRole("heading", { name: t("settings.update.newRelease") }),
  ).toBeNull();
  expect(
    view.queryByRole("link", { name: t("settings.update.updateGuide") }),
  ).toBeNull();
  let copied = "unset";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void (copied = text) },
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: t("common.copy") }));
  });
  expect(copied).not.toBe("unset");
  expect(copied.trim()).not.toBe("");
  return copied;
}

describe("update trigger", () => {
  it("an accepted launch hands over to the update screen", async () => {
    const f = fixture();
    await f.start();
    expect(f.actions).toEqual([
      { type: "update_launching" },
      { type: "update_clicked" },
    ]);
    // The updater installs the release the pane offered.
    expect(f.posts).toEqual([{ tag: "v2026.9.8" }]);
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

  it("a source checkout shows the manual update steps", () => {
    const status: Status = {
      mode: "commit",
      updateAvailable: true,
      current: { release: null, sha: "old-sha" },
      latest: null,
      releaseStanding: "unknown",
      mainAhead: 1,
    };
    const { view } = fixture(status);
    expect(view.queryByText(t("settings.update.stepRefresh"))).not.toBeNull();
    // The commit branch, neither the release body nor the quiet one.
    for (const title of [
      "settings.update.newRelease",
      "settings.update.upToDateTitle",
    ] as const)
      expect(view.queryByRole("heading", { name: t(title) })).toBeNull();
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

  it("an owner sees the installer's messages under a dated heading, a member does not", () => {
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
    view.unmount();

    const member = fixture(withNote, "member").view;
    expect(
      member.queryByRole("heading", { name: t("settings.update.newRelease") }),
    ).not.toBeNull();
    expect(member.queryByText(NOTE)).toBeNull();
  });
});

describe("image deployments (no host updater)", () => {
  const en = translatorFor("en");
  const sha = "c".repeat(40);
  const imageStatus = (
    guide: "kubernetes" | "render" | "container" | "homebrew",
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
        view.queryByRole("link", { name: en.t("settings.update.updateGuide") }),
      ).not.toBeNull();
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

  // A Homebrew install updates in two shell steps, in this order: the upgrade
  // installs the new keg, the restart moves the service onto it.
  it("a Homebrew install shows the upgrade and the restart, in the pane and on the clipboard", async () => {
    const upgrade = "brew upgrade isomux";
    const restart = "brew services restart isomux";
    const guideUrl =
      "https://isomux.com/docs/hosting-local#update-with-homebrew";
    const { view } = renderImage(imageStatus("homebrew", "v2026.9.1"), "owner");
    const link = view.getByRole("link", {
      name: en.t("settings.update.updateGuide"),
    });
    expect(link.getAttribute("href")).toBe(guideUrl);
    const commands = [...link.parentElement!.querySelectorAll("code")].map(
      (c) => c.textContent,
    );
    expect(commands).toEqual([upgrade, restart]);

    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (copied = text) },
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: en.t("common.copy") }));
    });
    expect(copied.includes(guideUrl)).toBe(true);
    expect(copied.indexOf(upgrade)).toBeGreaterThan(-1);
    expect(copied.indexOf(restart)).toBeGreaterThan(copied.indexOf(upgrade));
  });

  it("shows an untagged image as its short commit, a tagged one as its release, an unpinned host as its full version", () => {
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
    tagged.view.unmount();
    const hostUnpinned = {
      ...oldStatus,
      current: { release: null, version: sha },
    } as Status;
    const host = renderImage(hostUnpinned, "member");
    expect(host.view.queryByText(sha)).not.toBeNull();
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
    // The running image as its short commit, as the pane shows it.
    expect(copied.includes(sha.slice(0, 7))).toBe(true);
    expect(copied.includes(sha)).toBe(false);
    expect(
      copied.includes(
        "https://isomux.com/docs/hosting-render#update-the-office",
      ),
    ).toBe(true);
  });
});

describe("an office with no update to offer", () => {
  const en = translatorFor("en");
  const onLatest: Status = {
    ...oldStatus,
    updateAvailable: false,
    current: { release: "v2026.9.8", version: "v2026.9.8" },
  };
  const sha = "c".repeat(40);
  const image = (
    guide: "render" | "kubernetes" | "container",
    release: string | null = null,
  ): Status => ({
    ...oldStatus,
    updateAvailable: false,
    current: { release, version: release ?? sha },
    apply: { kind: "image", guide },
  });

  // The UI reads only `updateAvailable`: the server decides whether a box on
  // or past Latest has an update, so host and image boxes take one branch.
  it("reads as up to date and offers no update, on a host or an image", async () => {
    // Each status with what the copy names: the running release or the short
    // commit, and the latest tag when one is known.
    for (const [status, names] of [
      [onLatest, ["v2026.9.8"]],
      [image("render"), [sha.slice(0, 7), "v2026.9.8"]],
      [{ ...image("kubernetes"), latest: null }, [sha.slice(0, 7)]],
      [image("container", "v2026.9.8"), ["v2026.9.8"]],
      [
        {
          ...onLatest,
          current: { release: "v2026.9.9", version: "v2026.9.9" },
        },
        ["v2026.9.9", "v2026.9.8"],
      ],
    ] as [Status, string[]][]) {
      const { view } = fixture(status);
      await act(async () => {});
      const copied = await expectQuiet(view);
      for (const name of names) expect(copied).toContain(name);
      expect(copied.includes(sha)).toBe(false);
      expect(
        view.queryByRole("button", {
          name: en.t("settings.update.updateNow"),
        }),
      ).toBeNull();
      // No release body: neither version line nor the latest tag.
      expect(view.container.textContent?.includes("v2026.9.8")).toBe(false);
      view.unmount();
    }
  });

  it("keeps the owner's last update note, in the pane and on the clipboard", async () => {
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
    expect(await expectQuiet(owner.view)).toContain(NOTE);
    owner.view.unmount();
    const member = fixture(status, "member");
    expect(member.view.queryByText(NOTE)).toBeNull();
    expect(await expectQuiet(member.view)).not.toContain(NOTE);
  });

  it("a source checkout with nothing new copies what it runs", async () => {
    const commitSha = "d".repeat(40);
    const quiet: Status = {
      mode: "commit",
      updateAvailable: false,
      current: { release: null, sha: commitSha },
      latest: { tag: "v2026.9.8", url: null },
      releaseStanding: "ahead",
      mainAhead: 0,
    };
    const { view } = fixture(quiet);
    const copied = await expectQuiet(view);
    expect(copied).toContain(commitSha.slice(0, 7));
    expect(copied.includes(commitSha)).toBe(false);
    expect(copied).toContain("v2026.9.8");
    view.unmount();

    // A box on a tag names the tag, not the commit.
    const tagged = fixture({
      ...quiet,
      current: { release: "v2026.9.8", sha: commitSha },
      latest: null,
      releaseStanding: "current",
    });
    const taggedCopy = await expectQuiet(tagged.view);
    expect(taggedCopy).toContain("v2026.9.8");
    expect(taggedCopy.includes(commitSha.slice(0, 7))).toBe(false);
  });
});
