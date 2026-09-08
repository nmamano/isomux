// Static-markup tests for the members chat panel: the author labels for the
// three author kinds, the attachment route, the avatar trial, and the controls
// a reader gets on their own message versus someone else's. No React DOM
// harness in the UI suite, so effects (fetch, markRead) never run here.

import { translatorFor } from "../../shared/i18n/translate.ts";
import { describe, it, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StateCtx, initialState, type AppState } from "../store.tsx";
import {
  MembersChatPanel,
  describeMembersChatAuthor,
  formatWhen,
} from "./MembersChatPanel.tsx";
import type { MembersChatMessage } from "../../shared/types.ts";

const t0 = Date.UTC(2026, 8, 5, 12, 0, 0);

const fromNil: MembersChatMessage = {
  id: "202609-00000001",
  kind: "user",
  userId: "u-nil",
  userName: "Nil",
  device: "Phone",
  timestamp: t0,
  content: "morning all",
  attachments: [],
};
const fromToken: MembersChatMessage = {
  id: "202609-00000002",
  kind: "api",
  userId: "u-nil",
  userName: "Nil",
  device: "Laptop",
  timestamp: t0 + 1000,
  content: "posted by a script",
  attachments: [
    {
      filename: "report.pdf",
      originalName: "report.pdf",
      mediaType: "application/pdf",
      size: 12,
    },
  ],
};
const fromAgent: MembersChatMessage = {
  id: "202609-00000003",
  kind: "agent",
  userId: "u-pau",
  userName: "Isomux PM",
  timestamp: t0 + 2000,
  content: "batch done",
  attachments: [],
  editedAt: t0 + 3000,
};

function render(overrides: Partial<AppState>, meId = "u-nil", role = "member") {
  const state: AppState = {
    ...initialState,
    sessionContext: {
      userId: meId,
      username: meId === "u-nil" ? "Nil" : "Pau",
      role,
      currentSessionPrefix: "abcd1234",
      connectionId: "c1",
    } as unknown as AppState["sessionContext"],
    // Keyed by lowercased name, as the store does (ui/user-merge.ts).
    users: new Map([
      [
        "nil",
        {
          id: "u-nil",
          name: "Nil",
          role: "owner",
          avatarColor: "#ff8800",
          avatarVariant: "classic",
          createdAt: 1,
        },
      ],
      [
        "pau",
        {
          id: "u-pau",
          name: "Pau",
          role: "member",
          avatarColor: "#0088ff",
          avatarVariant: "classic",
          createdAt: 2,
        },
      ],
    ]),
    onlineUserIds: ["u-nil", "u-pau"],
    totalOnlineUsers: 2,
    membersChat: {
      messages: [fromNil, fromToken, fromAgent],
      hasMore: true,
      loaded: true,
      readPointer: null,
      unread: 0,
    },
    ...overrides,
  };
  return renderToStaticMarkup(
    createElement(
      StateCtx.Provider,
      { value: state },
      createElement(MembersChatPanel),
    ),
  );
}

describe("describeMembersChatAuthor", () => {
  it("names a person with their device, and marks a token or an agent as machine-sent", () => {
    expect(describeMembersChatAuthor(fromNil, translatorFor("en").t)).toEqual({
      label: "Nil (Phone)",
      nonHuman: false,
    });
    expect(describeMembersChatAuthor(fromToken, translatorFor("en").t)).toEqual({
      label: 'Nil · API token "Laptop"',
      nonHuman: true,
    });
    expect(describeMembersChatAuthor(fromAgent, translatorFor("en").t)).toEqual({
      label: "Isomux PM · agent",
      nonHuman: true,
    });
  });
});

describe("formatWhen", () => {
  it("shows the clock today, the date this year, the year before that", () => {
    const now = new Date(2026, 8, 5, 15, 0).getTime();
    expect(formatWhen("en", new Date(2026, 8, 5, 9, 7).getTime(), now)).toBe("09:07");
    expect(formatWhen("en", new Date(2026, 1, 3, 9, 7).getTime(), now)).toBe(
      "Feb 3, 09:07",
    );
    expect(formatWhen("en", new Date(2025, 1, 3, 9, 7).getTime(), now)).toBe(
      "Feb 3, 2025",
    );
  });
});

describe("MembersChatPanel markup", () => {
  it("renders every author label, the members-chat file route, and the online count", () => {
    const html = render({});
    expect(html).toContain("NIL (PHONE)");
    expect(html).toContain("NIL · API TOKEN &quot;LAPTOP&quot;");
    expect(html).toContain("ISOMUX PM · AGENT");
    expect(html).toContain("· EDITED");
    expect(html).toContain('href="/api/members-chat/files/report.pdf"');
    expect(html).not.toContain("/api/files/");
    expect(html).toContain("2 online");
    expect(html).toContain("Load older");
  });

  it("draws the author ghost only for a person's message, in their own colour", () => {
    const html = render({});
    expect(html.match(/data-author-ghost/g)?.length).toBe(1);
    // Looked up by id, not by the store's name key: Nil's colour, not a fallback.
    const ghost = html.slice(html.indexOf("data-author-ghost"));
    expect(ghost.slice(0, 600)).toContain('fill="#ff8800"');
    // The header draws every online person's ghost.
    expect(html).toContain('title="Pau"');
  });

  it("offers edit on own messages only, and delete on own or, for an owner, on all", () => {
    const asMember = render({}, "u-nil", "member");
    // A person, their API token and their privileged agents are one identity
    // here: Nil owns the first two posts, Pau owns the agent's.
    expect(asMember.match(/title="Edit"/g)?.length).toBe(2);
    expect(asMember.match(/title="Delete"/g)?.length).toBe(2);
    const asOwner = render({}, "u-nil", "owner");
    expect(asOwner.match(/title="Edit"/g)?.length).toBe(2);
    expect(asOwner.match(/title="Delete"/g)?.length).toBe(3);
    const asPau = render({}, "u-pau", "member");
    expect(asPau.match(/title="Edit"/g)?.length).toBe(1);
    expect(asPau.match(/title="Delete"/g)?.length).toBe(1);
  });

  it("shows the empty state once loaded with nothing, and nothing before load", () => {
    const empty = render({
      membersChat: {
        messages: [],
        hasMore: false,
        loaded: true,
        readPointer: null,
        unread: 0,
      },
    });
    expect(empty).toContain("Only people see this chat");
    const pending = render({
      membersChat: {
        messages: [],
        hasMore: false,
        loaded: false,
        readPointer: null,
        unread: 0,
      },
    });
    expect(pending).not.toContain("Only people see this chat");
  });
});
