// Who a `user_message` came from, and whether the reader should treat it as a
// person. Three senders reach an agent through one queue and land in one log -
// a boss, another agent, and one of the agent's own apps - and the log is what
// anyone reads AFTERWARDS, so the distinction has to survive the trip. Pinned as
// a pure function because the UI has no React render harness (same reason as
// ContextBattery's bandColor).

import { describe, it, expect } from "bun:test";
import { describeMessageSender } from "./LogEntryCard.tsx";

describe("describeMessageSender", () => {
  it("a boss is a human, labelled by name and device", () => {
    expect(describeMessageSender({ username: "Nil", device: "Phone" })).toEqual(
      {
        label: "Nil (Phone)",
        fromHuman: true,
      },
    );
  });

  it("no metadata at all is still the human path (the card falls back to 'You')", () => {
    expect(describeMessageSender(undefined)).toEqual({
      label: undefined,
      fromHuman: true,
    });
  });

  it("an agent sender is labelled agent + room, and is not human", () => {
    expect(
      describeMessageSender({
        sender_agent_name: "Isomuxer3",
        sender_agent_room: "Isomux Dev",
      }),
    ).toEqual({
      label: 'Isomuxer3 · agent · Room "Isomux Dev"',
      fromHuman: false,
    });
  });

  it("an APP sender is labelled as an app, and is not human", () => {
    // The metadata the server stamps for POST /api/app/message (senderMeta's
    // app arm). Without this branch an app's message renders exactly like the
    // boss typing - which is the one reading it must never get wrong.
    expect(describeMessageSender({ sender_app_name: "habits" })).toEqual({
      label: "habits · app",
      fromHuman: false,
    });
  });

  it("an app sender is not made human by carrying a username alongside", () => {
    // The app's owner may well be stamped elsewhere on the entry; the sender is
    // still the app, so the non-human branch has to win.
    expect(
      describeMessageSender({ sender_app_name: "habits", username: "Nil" }),
    ).toEqual({ label: "habits · app", fromHuman: false });
  });
});
