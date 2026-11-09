import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const browser = await import("../reload-browser.ts");
const { UpdateOverlay } = await import("./UpdateOverlay.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { initialUpdateWatch, watchOnClicked, watchOnStatus } =
  await import("../update-watch.ts");

type Status = NonNullable<typeof initialState.updateInfo>;
type Progress = NonNullable<Extract<Status, { mode: "release" }>["progress"]>;
type Watch = typeof initialState.updateWatch;
type Role = "owner" | "member";

const t = translatorFor("en").t;
const OLD = "v2026.9.1";
const NEW = "v2026.9.8";
const A1 = "a".repeat(32);
const NOTE = "Restored installer-managed firewall rule: 443/tcp.";

function status(
  version: string,
  progress: Progress | null,
  withNote = false,
): Extract<Status, { mode: "release" }> {
  return {
    mode: "release",
    updateAvailable: version !== NEW,
    securityUpdate: null,
    current: { release: version, version },
    latest: { tag: NEW, publishedAt: null, url: null },
    apply: { kind: "host" },
    progress,
    ...(withNote
      ? {
          outcome: {
            target: version,
            at: "2026-10-07T12:00:00Z",
            messages: [NOTE],
          },
        }
      : {}),
  };
}
const running = (phase: string): Progress => ({
  attempt: A1,
  phase,
  result: "running",
});
const ok: Progress = { attempt: A1, phase: "finalize", result: "ok" };

// A watch that saw the attempt run on the old version.
function watching(clicked: boolean): Watch {
  let w = watchOnStatus(initialUpdateWatch, status(OLD, null));
  w = watchOnStatus(w, status(OLD, running("build")));
  return clicked ? watchOnClicked(w) : w;
}

let reload: ReturnType<typeof spyOn<typeof browser, "reloadBrowser">> | null =
  null;
afterEach(() => {
  reload?.mockRestore();
  reload = null;
  jest.useRealTimers();
});

// Renders the overlay over a live reducer, so Hide works end to end.
function show(updateWatch: Watch, updateInfo: Status, role: Role = "owner") {
  reload = spyOn(browser, "reloadBrowser").mockImplementation(() => {});
  let state: typeof initialState = {
    ...initialState,
    connected: true,
    updateInfo,
    updateWatch,
    sessionContext: {
      userId: role,
      username: role,
      role,
      currentSessionPrefix: "session",
      connectionId: "connection",
    },
  };
  const tree = () => (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider
        value={(action) => {
          state = reducer(state, action);
          view.rerender(tree());
        }}
      >
        <UpdateOverlay />
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
  const view = render(tree());
  return view;
}

describe("update screen", () => {
  it("covers the office while the update runs, with the step", () => {
    const view = show(watching(false), status(OLD, running("build")));
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(view.queryByText(t("update.screen.title"))).not.toBeNull();
    expect(view.queryByText(t("update.screen.install"))).not.toBeNull();
  });

  it("Hide closes it", async () => {
    const view = show(watching(false), status(OLD, running("build")));
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: t("update.screen.hide") }),
      );
    });
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("the launching tab reloads itself on the new version", () => {
    const view = show(watching(true), status(NEW, ok));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("another tab offers Reload", async () => {
    const view = show(watching(false), status(NEW, ok));
    expect(reload).not.toHaveBeenCalled();
    expect(
      view.queryByText(t("update.screen.done", { version: NEW })),
    ).not.toBeNull();
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: t("update.screen.reload") }),
      );
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("an owner reads the installer's notes before reloading", () => {
    const view = show(watching(true), status(NEW, ok, true));
    expect(reload).not.toHaveBeenCalled();
    expect(view.queryByText(t("update.outcome.title"))).not.toBeNull();
    // The installer's sentence, as the box wrote it.
    expect(view.queryByText(NOTE)).not.toBeNull();
    expect(
      view.queryByRole("button", { name: t("update.screen.reload") }),
    ).not.toBeNull();
  });

  it("a member sees no notes", () => {
    const view = show(watching(false), status(NEW, ok, true), "member");
    expect(
      view.queryByText(t("update.screen.done", { version: NEW })),
    ).not.toBeNull();
    expect(view.queryByText(t("update.outcome.title"))).toBeNull();
    expect(view.queryByText(NOTE)).toBeNull();
  });

  it("a failed update names the version the office runs", () => {
    const view = show(
      watching(false),
      status(OLD, { attempt: A1, phase: "readiness", result: "failed" }),
    );
    expect(
      view.queryByText(t("update.screen.failed", { version: OLD })),
    ).not.toBeNull();
    expect(
      view.queryByRole("button", { name: t("update.screen.reload") }),
    ).toBeNull();
  });
});

// Until the restart the updater only prepares, and the office still runs, so
// the screen says so; from the restart on, and before the updater starts, it
// does not.
describe("update screen: the office keeps working until the restart", () => {
  const keepsWorking = t("update.screen.keepsWorking");
  const says = (view: ReturnType<typeof show>) =>
    (view.container.textContent ?? "").includes(keepsWorking);

  for (const phase of ["fetch", "deps", "build", "image"]) {
    it(`says so in the ${phase} phase`, () => {
      const view = show(watching(false), status(OLD, running(phase)));
      expect(view.queryByRole("dialog")).not.toBeNull();
      expect(says(view)).toBe(true);
    });
  }

  for (const phase of ["stop", "readiness", "publish"]) {
    it(`does not say so in the ${phase} phase`, () => {
      const view = show(watching(false), status(OLD, running(phase)));
      expect(view.queryByText(t("update.screen.restart"))).not.toBeNull();
      expect(says(view)).toBe(false);
    });
  }

  it("does not say so while the update waits for the updater", () => {
    const view = show(
      watching(false),
      status(OLD, { attempt: null, phase: null, result: "requested" }),
    );
    expect(view.queryByText(t("update.screen.requested"))).not.toBeNull();
    expect(says(view)).toBe(false);
  });
});

// The busy screen counts the time since the updater started, from the
// attempt's own start (the server sends it), so a member can see an update
// that takes long.
describe("update screen elapsed time", () => {
  const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
  const startedAt = (started: number | null): Progress => ({
    ...running("build"),
    started,
  });
  // m:ss as a whole token of the screen's text.
  const shows = (view: ReturnType<typeof show>, time: string) =>
    new RegExp(`(^|\\D)${time}(\\D|$)`).test(
      view.getByRole("dialog").textContent ?? "",
    );
  const anyTime = (view: ReturnType<typeof show>) =>
    /\d+:\d\d/.test(view.getByRole("dialog").textContent ?? "");

  it("shows the time since the start and counts on", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    const p = startedAt(NOW - 65_000);
    const view = show(watching(false), status(OLD, p));
    expect(shows(view, "1:05")).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(shows(view, "1:06")).toBe(true);
    expect(shows(view, "1:05")).toBe(false);
  });

  it("a box clock ahead of this browser shows 0:00, not a negative time", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    const view = show(watching(false), status(OLD, startedAt(NOW + 30_000)));
    expect(shows(view, "0:00")).toBe(true);
  });

  it("no start, no time: an older updater or a request not yet running", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    const view = show(watching(false), status(OLD, startedAt(null)));
    // The screen is up, with its step.
    expect(view.queryByText(t("update.screen.install"))).not.toBeNull();
    expect(anyTime(view)).toBe(false);
  });
});
