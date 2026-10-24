// Task e871e36f: the new-agent dialog starts in the room's working folder, or
// in "~" where the room has none, from both ways in (an empty desk and the
// back room's new agent button), and a folder changed live reaches the next
// dialog. The server default for an API spawn: routes-agents-rest.test.ts.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StoreProvider } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { connect, setShim, shimEmit } = await import("./ws.ts");
const { saveView } = await import("./view-persistence.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

setApiShim(async () => ({}));

afterAll(() => {
  setApiShim(null);
  // The store this file mounts stays wired to shimEmit otherwise (see
  // ui/App.restored-chat.dom.test.tsx).
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

function boot(cwd: string | undefined): View {
  window.localStorage.clear();
  saveView("ricky", { roomId: "r1", agentId: null, panel: null, lobby: false });
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: { username: "ricky", userId: "u1", role: "owner" },
      } as never);
      shimEmit({
        type: "full_state",
        agents: [],
        rooms: [
          {
            id: "r1",
            name: "Room",
            prompt: null,
            canCloseWhenEmpty: true,
            backRoom: true,
            ...(cwd === undefined ? {} : { cwd }),
          },
        ],
        office: {},
        recentCwds: [],
        killedAgents: [],
        interactions: [],
      } as never);
    },
  );
  return render(createElement(StoreProvider, null, createElement(App, {})));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const dialogCwd = () =>
  document.querySelector<HTMLInputElement>(".agent-directory-field input");

async function openFromDesk(view: View) {
  // An empty desk's click target: the room holds no agents, so any one.
  const slot = view.container.querySelector<SVGPathElement>(
    "[data-turn-anchor] path[data-no-pan]",
  );
  expect(slot).not.toBeNull();
  await act(async () => fireEvent.click(slot!));
  await settle();
}

async function closeDialog() {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await settle();
  expect(dialogCwd()).toBeNull();
}

it("seeds the folder from a desk and from the back room, follows a live change, and falls back to ~", async () => {
  const view = boot("~/proj");
  await settle();

  await openFromDesk(view);
  expect(dialogCwd()?.value).toBe("~/proj");
  await closeDialog();

  await act(async () =>
    shimEmit({ type: "room_cwd_updated", roomId: "r1", cwd: null } as never),
  );
  await openFromDesk(view);
  expect(dialogCwd()?.value).toBe("~");
  await closeDialog();

  await act(async () =>
    shimEmit({
      type: "room_cwd_updated",
      roomId: "r1",
      cwd: "/srv/back",
    } as never),
  );
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", bubbles: true }),
    );
  });
  await settle();
  const newAgent = translatorFor("en").t("office.backRoom.newAgent");
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: newAgent })),
  );
  await settle();
  expect(dialogCwd()?.value).toBe("/srv/back");
  view.unmount();
});
