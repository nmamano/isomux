import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const browser = await import("../reload-browser.ts");
const { UpdateOverlay } = await import("./UpdateOverlay.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { REPO_URL } = await import("../repo.ts");
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

// The failed screen shows an owner the updater's step and message, and copies
// them as a plain-text report, so nobody needs a shell to learn why an update
// stopped (task 0cee48c9).
describe("failed update details", () => {
  const MESSAGE =
    "checkout is dirty: /opt/isomux (changed: a.txt) - refusing to update over local changes";
  const failedP = (over: Partial<Progress> = {}): Progress => ({
    attempt: A1,
    phase: "validate",
    result: "failed",
    target: NEW,
    message: MESSAGE,
    ...over,
  });
  // Clicks the copy button; returns what it put on the clipboard.
  async function copyReport(view: ReturnType<typeof show>): Promise<string> {
    let copied = "unset";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (copied = text) },
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: t("common.copy") }));
    });
    return copied;
  }
  const copyButton = (view: ReturnType<typeof show>) =>
    view.queryByRole("button", { name: t("common.copy") });

  it("an owner reads the message, and copies a report with the step", async () => {
    const view = show(watching(false), status(OLD, failedP()));
    expect(
      view.queryByText(t("update.screen.failed", { version: OLD })),
    ).not.toBeNull();
    // The message whole, in an element of its own.
    expect(view.queryByText(MESSAGE)).not.toBeNull();
    // The screen does not name the step (the message says why); the copied
    // report does.
    expect(
      /\bvalidate\b/.test(view.getByRole("dialog").textContent ?? ""),
    ).toBe(false);
    const lines = (await copyReport(view)).split("\n");
    // One fact per line: the version it runs, the target, the step, the
    // message.
    const lineWith = (s: string) => lines.filter((l) => l.includes(s));
    expect(lineWith(MESSAGE)).toHaveLength(1);
    expect(lineWith(OLD)).toHaveLength(1);
    expect(lineWith(NEW)).toHaveLength(1);
    expect(lineWith(OLD)[0]).not.toBe(lineWith(NEW)[0]);
    expect(lines.filter((l) => /\bvalidate\b/.test(l))).toHaveLength(1);
  });

  it("a member sees the failure without the details", () => {
    const view = show(watching(false), status(OLD, failedP()), "member");
    expect(
      view.queryByText(t("update.screen.failed", { version: OLD })),
    ).not.toBeNull();
    const text = view.getByRole("dialog").textContent ?? "";
    expect(text.includes(MESSAGE)).toBe(false);
    expect(text.includes("validate")).toBe(false);
    expect(copyButton(view)).toBeNull();
  });

  it("with no message, the screen shows no step but the report keeps it", async () => {
    const view = show(
      watching(false),
      status(OLD, failedP({ message: undefined })),
    );
    expect(
      /\bvalidate\b/.test(view.getByRole("dialog").textContent ?? ""),
    ).toBe(false);
    expect(copyButton(view)).not.toBeNull();
    const copied = await copyReport(view);
    expect(copied).toMatch(/\bvalidate\b/);
    expect(copied).toContain(NEW);
  });

  it("with no step, no details", () => {
    // A container office: the server came back on the old version and no
    // record names a step.
    let w = watchOnStatus(initialUpdateWatch, status(OLD, null));
    w = watchOnStatus(
      w,
      status(OLD, { attempt: null, phase: null, result: "requested" }),
    );
    w = watchOnStatus(w, status(OLD, null));
    const view = show(w, status(OLD, null));
    expect(
      view.queryByText(t("update.screen.failed", { version: OLD })),
    ).not.toBeNull();
    expect(copyButton(view)).toBeNull();
  });
});

// An owner's failed screen says where to get help: a new GitHub issue or the
// Isomux Discord (task c3c866e8). Only where the copy button is, so the
// owner has a report to take there.
describe("failed update help links", () => {
  const failedP = (over: Partial<Progress> = {}): Progress => ({
    attempt: A1,
    phase: "validate",
    result: "failed",
    target: NEW,
    message: "checkout is dirty: /opt/isomux",
    ...over,
  });
  const links = (view: ReturnType<typeof show>) =>
    Array.from(view.container.querySelectorAll("a"));
  // One link to the repo's issues and one to a Discord invite, each with a
  // name, each in a new tab so the office tab stays.
  function expectHelpLinks(view: ReturnType<typeof show>) {
    const all = links(view);
    const issue = all.filter((a) =>
      (a.getAttribute("href") ?? "").startsWith(`${REPO_URL}/issues`),
    );
    const discord = all.filter((a) =>
      /^https:\/\/discord\.gg\/\w+$/.test(a.getAttribute("href") ?? ""),
    );
    expect(issue.length).toBe(1);
    expect(discord.length).toBe(1);
    for (const a of [issue[0]!, discord[0]!]) {
      expect((a.textContent ?? "").trim().length > 0).toBe(true);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel") ?? "").toContain("noopener");
    }
  }

  it("an owner gets both links with the updater's message", () => {
    expectHelpLinks(show(watching(false), status(OLD, failedP())));
  });

  it("an owner gets both links when the updater sent no message", () => {
    expectHelpLinks(
      show(watching(false), status(OLD, failedP({ message: undefined }))),
    );
  });

  it("a member gets no links", () => {
    const view = show(watching(false), status(OLD, failedP()), "member");
    expect(
      view.queryByText(t("update.screen.failed", { version: OLD })),
    ).not.toBeNull();
    expect(links(view).length).toBe(0);
  });

  it("with no step (no report to copy), no links", () => {
    let w = watchOnStatus(initialUpdateWatch, status(OLD, null));
    w = watchOnStatus(
      w,
      status(OLD, { attempt: null, phase: null, result: "requested" }),
    );
    w = watchOnStatus(w, status(OLD, null));
    const view = show(w, status(OLD, null));
    expect(
      view.queryByText(t("update.screen.failed", { version: OLD })),
    ).not.toBeNull();
    expect(links(view).length).toBe(0);
  });

  it("a running or finished update shows no links", () => {
    const busy = show(watching(false), status(OLD, running("build")));
    expect(busy.queryByText(t("update.screen.install"))).not.toBeNull();
    expect(links(busy).length).toBe(0);
    busy.unmount();
    const done = show(watching(false), status(NEW, ok, true));
    expect(done.queryByText(t("update.outcome.title"))).not.toBeNull();
    expect(links(done).length).toBe(0);
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
