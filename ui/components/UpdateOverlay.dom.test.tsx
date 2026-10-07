import { afterEach, describe, expect, it, spyOn } from "bun:test";
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

  it("the launching tab does not reload on an unknown version", () => {
    const view = show(watching(true), {
      ...status(NEW, ok),
      current: { release: null, version: null },
    });
    expect(reload).not.toHaveBeenCalled();
    expect(
      view.queryByRole("button", { name: t("update.screen.reload") }),
    ).not.toBeNull();
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

  it("shows nothing when no update is watched", () => {
    const view = show(initialUpdateWatch, status(OLD, null));
    expect(view.queryByRole("dialog")).toBeNull();
  });
});
