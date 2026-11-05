// A fresh store opens on the lobby unless this browser's last saved view is a
// room (StoreProvider's first frame, task 4843a124). A test that starts in a
// room saves one before it mounts the store, as a member who left a room.
import { saveView } from "../view-persistence.ts";

export function saveRoomView(): void {
  saveView("member", {
    roomId: null,
    agentId: null,
    panel: null,
    lobby: false,
  });
}
