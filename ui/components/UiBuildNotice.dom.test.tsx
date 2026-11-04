import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const browser = await import("../reload-browser.ts");
const build = await import("../ui-build.ts");
const { UiBuildNotice } = await import("./UiBuildNotice.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

type Action = Parameters<typeof reducer>[1];

const t = translatorFor("en").t;
const OWN = "0123456789abcdef";
const NEW = "fedcba9876543210";
const NEWER = "00000000ffffffff";

// The page's build meta. The tab's own id must not come from it: a restored
// tab can pair an old cached page with the current index.js.
function setMeta(content: string | null): void {
  document.head
    .querySelectorAll('meta[name="isomux-ui-build"]')
    .forEach((m) => m.remove());
  if (content === null) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", "isomux-ui-build");
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

function fullState(uiBuild?: string): Action {
  return {
    type: "full_state",
    agents: [],
    recentCwds: [],
    office: { prompt: null, name: null },
    rooms: [],
    killedAgents: [],
    interactions: [],
    ...(uiBuild === undefined ? {} : { uiBuild }),
  };
}

let reload: ReturnType<typeof spyOn<typeof browser, "reloadBrowser">> | null =
  null;
let ownSpy: ReturnType<typeof spyOn<typeof build, "ownUiBuild">> | null = null;
afterEach(() => {
  reload?.mockRestore();
  reload = null;
  ownSpy?.mockRestore();
  ownSpy = null;
  setMeta(null);
});

// Renders the notice over a live reducer: server messages and the notice's
// own buttons both go through it. own is the id the running bundle reports
// (ui/ui-build.ts ownUiBuild); "unstamped" keeps the real, unstamped module.
function show(own: string | null | "unstamped") {
  // A test that renders several times spies afresh each time.
  ownSpy?.mockRestore();
  ownSpy = null;
  reload?.mockRestore();
  if (own !== "unstamped")
    ownSpy = spyOn(build, "ownUiBuild").mockImplementation(() => own);
  reload = spyOn(browser, "reloadBrowser").mockImplementation(() => {});
  let state: typeof initialState = { ...initialState, connected: true };
  const tree = () => (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider
        value={(action) => {
          state = reducer(state, action);
          view.rerender(tree());
        }}
      >
        <UiBuildNotice />
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
  const view = render(tree());
  const send = (action: Action) =>
    act(() => {
      state = reducer(state, action);
      view.rerender(tree());
    });
  const reloadButton = () =>
    view.queryByRole("button", { name: t("update.screen.reload") });
  const dismissButton = () =>
    view.queryByRole("button", { name: t("common.dismiss") });
  return { view, send, reloadButton, dismissButton };
}

describe("new UI build notice", () => {
  it("shows when the server's build on connect differs from this tab's", () => {
    const { send, reloadButton, dismissButton } = show(OWN);
    expect(reloadButton()).toBeNull();
    send(fullState(NEW));
    expect(reloadButton()).not.toBeNull();
    expect(dismissButton()).not.toBeNull();
  });

  it("stays hidden when the builds match or either one is unknown", () => {
    const same = show(OWN);
    same.send(fullState(OWN));
    expect(same.reloadButton()).toBeNull();
    same.view.unmount();

    // An older server, or one whose page has no build id.
    const noServer = show(OWN);
    noServer.send(fullState(NEW));
    noServer.send(fullState());
    expect(noServer.reloadButton()).toBeNull();
    noServer.view.unmount();

    // A tab from before this feature, or the demo.
    const noOwn = show(null);
    noOwn.send(fullState(NEW));
    expect(noOwn.reloadButton()).toBeNull();
    noOwn.view.unmount();

    // A bundle that was never stamped, as in tests and dev.
    const unstamped = show("unstamped");
    unstamped.send(fullState(NEW));
    expect(unstamped.reloadButton()).toBeNull();
  });

  // The restored-tab case: an old cached page with its old meta runs the
  // current index.js. The meta must not decide what the tab runs.
  it("takes this tab's build from the running code, never the page meta", () => {
    setMeta(OWN);
    const unstamped = show("unstamped");
    unstamped.send(fullState(NEW));
    expect(unstamped.reloadButton()).toBeNull();
  });

  it("names both builds by their short ids", () => {
    const { view, send } = show(OWN);
    send(fullState(NEW));
    const text = view.getByRole("status").textContent ?? "";
    expect(text).toContain(OWN.slice(0, 7));
    expect(text).toContain(NEW.slice(0, 7));
    expect(text).not.toContain(OWN.slice(0, 8));
    expect(text).not.toContain(NEW.slice(0, 8));
    // This tab's id comes first, as in "this page ... server ...".
    expect(text.indexOf(OWN.slice(0, 7))).toBeLessThan(
      text.indexOf(NEW.slice(0, 7)),
    );
  });

  it("follows a build that lands with no reconnect, both ways", () => {
    const { send, reloadButton } = show(OWN);
    send(fullState(OWN));
    send({ type: "ui_build", uiBuild: NEW });
    expect(reloadButton()).not.toBeNull();
    // The server serves this tab's build again: nothing to reload.
    send({ type: "ui_build", uiBuild: OWN });
    expect(reloadButton()).toBeNull();
    send({ type: "ui_build", uiBuild: NEW });
    send({ type: "ui_build", uiBuild: null });
    expect(reloadButton()).toBeNull();
  });

  it("Reload reloads the tab, and only on the click", async () => {
    const { send, reloadButton } = show(OWN);
    send(fullState(NEW));
    expect(reload).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(reloadButton()!);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("dismiss hides it until a newer build", async () => {
    const { send, reloadButton, dismissButton } = show(OWN);
    send(fullState(NEW));
    await act(async () => {
      fireEvent.click(dismissButton()!);
    });
    expect(reloadButton()).toBeNull();
    // A reconnect that reports the same build keeps it closed.
    send(fullState(NEW));
    expect(reloadButton()).toBeNull();
    send({ type: "ui_build", uiBuild: NEWER });
    expect(reloadButton()).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
