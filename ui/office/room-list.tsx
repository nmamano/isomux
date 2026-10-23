import { createContext, useMemo, type ReactNode } from "react";
import { ordinaryRooms, type RoomWire } from "../../shared/types.ts";
import {
  applyRoomOrder,
  roomsInOrder,
  usePendingView,
} from "./pending-view.ts";
import { selfTuckedRooms, tabBarRooms } from "./room-cycle.ts";

// The member's room list, in one place: the tab bar, the wall doors, the
// lobby door, the ghosts and the phone swipes all read it, so they never
// disagree (task 8070f62b). A drag-reorder or a tuck shows in all of them at
// once; the server state confirms it.
export interface RoomList {
  // The ordinary rooms in the member's order, tucked rooms included.
  rooms: RoomWire[];
  tucked: readonly string[];
  // The room tabs, in order (tabBarRooms): the one list doors and swipes walk.
  tabs: RoomWire[];
  writeOrder: (order: string[], send: () => Promise<unknown>) => void;
  writeTucked: (tucked: string[], send: () => Promise<unknown>) => void;
}

export function sameRoomSet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

// The list from the server state and the pending overlays (null: none).
export function deriveRoomList(
  serverRooms: readonly RoomWire[],
  serverTucked: readonly string[],
  pendingOrder: readonly string[] | null,
  pendingTucked: readonly string[] | null,
  currentRoomId: string | null,
  lobbyOpen: boolean,
): Pick<RoomList, "rooms" | "tucked" | "tabs"> {
  const rooms = pendingOrder
    ? applyRoomOrder(serverRooms, pendingOrder)
    : [...serverRooms];
  const tucked = pendingTucked ?? serverTucked;
  return {
    rooms,
    tucked,
    tabs: tabBarRooms(rooms, tucked, currentRoomId, lobbyOpen),
  };
}

export const RoomListCtx = createContext<RoomList | null>(null);

export function RoomListProvider({
  allRooms,
  users,
  selfId,
  currentRoomId,
  lobbyOpen,
  children,
}: {
  allRooms: readonly RoomWire[];
  users: Map<string, { id: string; tucked?: string[] }>;
  selfId: string | null;
  currentRoomId: string | null;
  lobbyOpen: boolean;
  children: ReactNode;
}) {
  const serverRooms = useMemo(() => ordinaryRooms(allRooms), [allRooms]);
  const serverTucked = useMemo(
    () => selfTuckedRooms(users.values(), selfId),
    [users, selfId],
  );
  const [pendingOrder, writeOrder] = usePendingView(serverRooms, roomsInOrder);
  const [pendingTucked, writeTucked] = usePendingView(
    serverTucked,
    sameRoomSet,
  );
  const value = useMemo<RoomList>(
    () => ({
      ...deriveRoomList(
        serverRooms,
        serverTucked,
        pendingOrder,
        pendingTucked,
        currentRoomId,
        lobbyOpen,
      ),
      writeOrder,
      writeTucked,
    }),
    [
      serverRooms,
      serverTucked,
      pendingOrder,
      pendingTucked,
      currentRoomId,
      lobbyOpen,
      writeOrder,
      writeTucked,
    ],
  );
  return <RoomListCtx.Provider value={value}>{children}</RoomListCtx.Provider>;
}
