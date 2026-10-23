import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const browser = await import("../reload-browser.ts");
const { UiBuildNotice } = await import("./UiBuildNotice.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

type Action = Parameters<typeof reducer>[1];

const t = translatorFor("en").t;
const OWN = "0123456789abcdef";
const NEW = "fedcba9876543210";
const NEWER = "00000000ffffffff";

// The meta scripts/build.sh fills in; ui/index.html ships the placeholder.
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
afterEach(() => {
  reload?.mockRestore();
  reload = null;
  setMeta(null);
});

// Renders the notice over a live reducer: server messages and the notice's
// own buttons both go through it.
function show(own: string | null) {
  setMeta(own);
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

    // A page served unbuilt still holds ui/index.html's placeholder.
    const placeholder = show("__ISOMUX_UI_BUILD__");
    placeholder.send(fullState(NEW));
    expect(placeholder.reloadButton()).toBeNull();
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
