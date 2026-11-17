// Settings drilled into one item (task 1f79f2e3): an agent, a room or a
// member opens inside Settings, its parts in the list column and one part in
// the pane. The tests of each editor mount the real page through these
// helpers. Imports the page, so a test loads it with `await import(...)`
// after setUpDomTestFile(), never statically.
//
// DOM contract: a part row is button[data-settings-part="<part>"], the open
// one aria-current="true"; Save is [data-settings-save].
import { act, fireEvent } from "@testing-library/react";
import { createElement, useState, type ReactElement } from "react";
import {
  UserSettingsView,
  type Selection,
} from "../components/UserSettingsView.tsx";
import { RoomPane } from "../components/RoomPane.tsx";
import type { RoomPart } from "../settings-parts.ts";

/** The Settings page opened on `target`. */
export function settingsAt(
  target: Selection,
  onClose: () => void = () => {},
): ReactElement {
  return createElement(UserSettingsView, {
    onSwitchUser: () => {},
    onClose,
    initialTarget: target,
  });
}

export const partRow = (root: ParentNode, part: string) =>
  root.querySelector<HTMLButtonElement>(`button[data-settings-part="${part}"]`);

/** The open part, or null. */
export const openPartId = (root: ParentNode) =>
  root
    .querySelector('button[data-settings-part][aria-current="true"]')
    ?.getAttribute("data-settings-part") ?? null;

/** Opens a part through its row; throws when the row is not listed. */
export async function openPart(root: ParentNode, part: string): Promise<void> {
  const row = partRow(root, part);
  if (!row) throw new Error(`no part row ${part}`);
  await act(async () => {
    fireEvent.click(row);
  });
}

export const saveButton = (root: ParentNode) =>
  root.querySelector<HTMLButtonElement>("[data-settings-save]");

/** RoomPane on its own, for the tests of the room form: its part rows (the
 *  contract's buttons), the open part's body and its footer, without the
 *  Settings page around it (that is UserSettingsView's,
 *  ui/components/UserSettingsView.drill-in.dom.test.tsx). */
export function RoomPaneHost({
  roomId,
  onDeleted,
  part: initial = "general",
}: {
  roomId: string;
  onDeleted: () => void;
  part?: RoomPart;
}) {
  const [part, setPart] = useState<RoomPart | null>(initial);
  return (
    <RoomPane
      roomId={roomId}
      onDeleted={onDeleted}
      part={part}
      onPart={setPart}
    >
      {(view) => (
        <>
          {view.parts.map((p) => (
            <button
              key={p.id}
              data-settings-part={p.id}
              aria-current={p.id === view.part ? "true" : undefined}
              onClick={() => setPart(p.id)}
            >
              {p.label}
            </button>
          ))}
          {view.body}
          {view.footer}
        </>
      )}
    </RoomPane>
  );
}
