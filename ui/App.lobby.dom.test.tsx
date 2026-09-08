// The lobby must keep the page routes reachable for members with no rooms.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { onLanguage } = await import("./test-support/language-fixture.tsx");

setApiShim(async (_method, path) => path.startsWith("/api/members-chat")
  ? { messages: [], hasMore: false, readPointer: null, unread: 0 }
  : {});
afterAll(() => setApiShim(null));
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

for (const [label, path] of [["Apps", "/apps"], ["Schedules", "/cronjobs"]] as const) {
  it(`opens ${path} from its lobby wall control`, async () => {
    const view = render(onLanguage("en", createElement(App), {
      lobbyOpen: true,
      hasReceivedInitialState: true,
      connected: true,
      office: { name: "Test Office", prompt: null, envFile: null },
    }));
    expect(document.title).toBe("Test Office | Isomux");
    const wall = view.container.querySelector(`svg g[aria-label="${label}"]`);
    expect(wall).not.toBeNull();
    await act(async () => { fireEvent.click(wall!); });
    expect(window.location.pathname).toBe(path);
    expect(window.history.state).toEqual({ isomux: true, page: path.slice(1) });
  });
}
