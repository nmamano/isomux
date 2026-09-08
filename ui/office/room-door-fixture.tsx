import { afterAll, beforeEach } from "bun:test";
const { useEffect } = await import("react");
const { act, render, fireEvent } = await import("@testing-library/react");
const { OfficeView } = await import("./OfficeView.tsx");
const { StoreProvider, useAppState, useDispatch, FeaturesProvider } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");

export const room = (id: string, name = id) => ({ id, name, prompt: null, canCloseWhenEmpty: true });
const noop = () => {};
export let snapshot: ReturnType<typeof useAppState>;
export let dispatch: ReturnType<typeof useDispatch>;
export let requests: unknown[] = [];
let reply: () => Promise<unknown>;

function Office() {
  const state = useAppState();
  const send = useDispatch();
  useEffect(() => {
    snapshot = state;
    dispatch = send;
  }, [state, send]);
  return <OfficeView onSpawn={noop} onContextMenu={noop} onOpenSettings={noop}
    onEditOfficePrompt={noop} onOpenThemePicker={noop} onOpenTasks={noop}
    onOpenCronjobs={noop} onOpenApps={noop} onOpenUpdate={noop} />;
}

export function fullState(rooms: ReturnType<typeof room>[]) {
  shimEmit({ type: "full_state", agents: [], rooms,
    office: { name: "Door test", prompt: null }, recentCwds: [], killedAgents: [], interactions: [] });
}

export function mount(rooms = [room("first")], embed = false) {
  setShim(noop);
  const view = render(<StoreProvider><LanguageProvider>
    <FeaturesProvider features={{ ...PRODUCTION_FEATURES, embed }}><Office /></FeaturesProvider>
  </LanguageProvider></StoreProvider>);
  act(() => fullState(rooms));
  return view;
}

export function setupRoomDoorTests() {
beforeEach(() => {
  window.localStorage.clear();
  requests = [];
  reply = async () => ({ room: room("created", "Room 2") });
  setApiShim(async (method, path, body) => {
    if (method === "POST" && path === "/api/rooms") {
      requests.push(body);
      return reply();
    }
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
});
afterAll(() => {
  setApiShim(null);
  setShim(noop);
  connect(noop, noop);
});

}
export function setReply(next: () => Promise<unknown>) { reply = next; }
export { act, fireEvent, shimEmit };
