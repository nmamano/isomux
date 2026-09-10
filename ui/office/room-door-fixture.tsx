import { afterAll, beforeEach } from "bun:test";
const { useEffect, useState } = await import("react");
const { act, render, fireEvent } = await import("@testing-library/react");
const { OfficeView } = await import("./OfficeView.tsx");
const { NewRoomDialog } = await import("./NewRoomDialog.tsx");
const { RoomTabBar } = await import("./RoomTabBar.tsx");
const { StoreProvider, useAppState, useDispatch, FeaturesProvider } =
  await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");

export const room = (
  id: string,
  name = id,
): import("../../shared/types.ts").RoomWire => ({
  id,
  name,
  prompt: null,
  canCloseWhenEmpty: true,
});
const { SceneDecorationContext } = await import("./scene-decoration.tsx");
let decorateScene = true;
const noop = () => {};
export let snapshot: ReturnType<typeof useAppState>;
export let dispatch: ReturnType<typeof useDispatch>;
export let requests: unknown[] = [];
let reply: () => Promise<unknown>;

function Office({ creationOnly = false }: { creationOnly?: boolean }) {
  const state = useAppState();
  const send = useDispatch();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    snapshot = state;
    dispatch = send;
  }, [state, send]);
  // The creation ordering cases need the real dialog, store and tabs, but
  // not repeated SVG office scenes. One case still mounts the whole office.
  if (creationOnly)
    return (
      <>
        <RoomTabBar />
        {open && <NewRoomDialog onClose={() => setOpen(false)} />}
      </>
    );
  return (
    <OfficeView
      onSpawn={noop}
      onContextMenu={noop}
      onOpenSettings={noop}
      onEditOfficePrompt={noop}
      onOpenThemePicker={noop}
      onOpenTasks={noop}
      onOpenCronjobs={noop}
      onOpenApps={noop}
      onOpenUpdate={noop}
    />
  );
}

export function fullState(rooms: ReturnType<typeof room>[]) {
  shimEmit({
    type: "full_state",
    agents: [],
    rooms,
    office: { name: "Door test", prompt: null },
    recentCwds: [],
    killedAgents: [],
    interactions: [],
  });
}

export function mount(
  rooms = [room("first")],
  embed = false,
  creationOnly = false,
) {
  setShim(noop);
  const tree = (embed: boolean) => (
    <StoreProvider>
      <LanguageProvider>
        <FeaturesProvider features={{ ...PRODUCTION_FEATURES, embed }}>
          <SceneDecorationContext.Provider value={decorateScene}>
            <Office creationOnly={creationOnly} />
          </SceneDecorationContext.Provider>
        </FeaturesProvider>
      </LanguageProvider>
    </StoreProvider>
  );
  const view = render(tree(embed));
  act(() => fullState(rooms));
  return { ...view, setEmbed: (next: boolean) => view.rerender(tree(next)) };
}

export function setupRoomDoorTests({ decorations = true } = {}) {
  beforeEach(() => {
    decorateScene = decorations;
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
export function setReply(next: () => Promise<unknown>) {
  reply = next;
}
export { act, fireEvent, shimEmit };
