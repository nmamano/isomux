import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { AppsView } = await import("./AppsView.tsx");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { connect, setShim } = await import("../ws.ts");
const { en } = await import("../../shared/i18n/en.ts");

setShim(() => {});
afterAll(() => {
  setApiShim(null);
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});

it("says why apps cannot run when the host reports app hosting unavailable", async () => {
  setApiShim(async (method, path) => {
    if (method === "GET" && path === "/api/apps") return [];
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  let dispatch!: ReturnType<typeof useDispatch>;
  function Probe() {
    dispatch = useDispatch();
    return null;
  }
  const view = render(
    <StoreProvider>
      <Probe />
      <AppsView onClose={() => {}} />
    </StoreProvider>,
  );
  await act(async () => {});
  expect(view.queryByRole("note")).toBeNull();

  const fullState = (unavailableFeatures: { apps?: "needs_linux" }) =>
    act(() =>
      dispatch({
        type: "full_state",
        agents: [],
        recentCwds: [],
        office: { prompt: null, name: null },
        rooms: [],
        killedAgents: [],
        unavailableFeatures,
      }),
    );
  await fullState({ apps: "needs_linux" });
  expect(view.getByRole("note").textContent).toBe(
    en["apps.unavailable.needsLinux"],
  );
  await fullState({});
  expect(view.queryByRole("note")).toBeNull();
  view.unmount();
});
