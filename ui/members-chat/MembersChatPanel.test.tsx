// Static-markup tests for the members chat panel: the author labels for the
// three author kinds, the attachment route, the avatar trial, the dates, and
// the controls a reader gets on their own message versus someone else's.
// Server rendering runs no effects, so nothing here fetches or marks read.

import { translatorFor } from "../../shared/i18n/translate.ts";
import { afterEach, describe, it, expect, setSystemTime } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StateCtx, initialState, type AppState } from "../store.tsx";
import { MembersChatPanel } from "./MembersChatPanel.tsx";
import type { MembersChatMessage } from "../../shared/types.ts";

const en = translatorFor("en");
const unescape = (html: string) =>
  html
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
// Each card's title: its author label and time.
const cardTitles = (html: string) =>
  [...html.matchAll(/title="([^"]*)" data-members-chat-message=""/g)].map(
    (match) => unescape(match[1]),
  );

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

afterEach(() => setSystemTime());

describe("MembersChatPanel markup", () => {
  it("renders every author label, the members-chat file route, and the online count", () => {
    const html = render({});
    const titles = cardTitles(html);
    expect(titles.length).toBe(3);
    // A person by name and device; a token and an agent marked as machine-sent.
    expect(titles[0].startsWith("Nil (Phone) · ")).toBe(true);
    expect(
      titles[1].startsWith(
        `${en.t("membersChat.authorApiDevice", { name: "Nil", device: "Laptop" })} · `,
      ),
    ).toBe(true);
    expect(
      titles[2].startsWith(
        `${en.t("common.sender.agent", { name: "Isomux PM" })} · `,
      ),
    ).toBe(true);
    // Only the edited message carries the edited marker.
    expect(
      titles.map((title) => title.endsWith(en.t("membersChat.edited"))),
    ).toEqual([false, false, true]);
    // Machine-sent author lines are italic; a person's is not.
    expect(
      [...html.matchAll(/data-members-chat-author="" style="([^"]*)"/g)].map(
        (match) => match[1].includes("font-style:italic"),
      ),
    ).toEqual([false, true, true]);
    expect(html).toContain('href="/api/members-chat/files/report.pdf"');
    expect(html).not.toContain("/api/files/");
    const online = html.match(/data-online-count="[^"]*"[^>]*>([^<]*)</);
    expect(online?.[1]).toBe(en.t("membersChat.online", { count: "2" }));
    // hasMore offers the older page.
    expect(html).toContain(en.t("membersChat.loadOlder"));
  });

  it("names reactors as the cards name their authors, machine-sent included", () => {
    const html = render({
      membersChat: {
        messages: [
          {
            ...fromNil,
            thumbsUp: [
              {
                kind: "api",
                userId: "u-nil",
                userName: "Nil",
                device: "Laptop",
              },
              { kind: "agent", userId: "u-pau", userName: "Isomux PM" },
            ],
          },
          fromToken,
          fromAgent,
        ],
        hasMore: false,
        loaded: true,
        readPointer: null,
        unread: 0,
      },
    });
    const reactors = html.match(
      new RegExp(
        `title="([^"]*)" aria-label="${en.t("membersChat.reactors", { count: 2 })}"`,
      ),
    );
    expect(reactors !== null).toBe(true);
    const names = unescape(reactors![1]).split(", ");
    const titles = cardTitles(html);
    // The token's and the agent's own cards are the independent oracle.
    expect(names.length).toBe(2);
    // Not the bare name: a script's or an agent's reaction never reads as a person's.
    expect(names[0] !== fromToken.userName).toBe(true);
    expect(names[1] !== fromAgent.userName).toBe(true);
    expect(titles[1].startsWith(`${names[0]} · `)).toBe(true);
    expect(titles[2].startsWith(`${names[1]} · `)).toBe(true);
  });

  it("dates a message by the clock today, the date this year, the year before that", () => {
    setSystemTime(new Date(2026, 8, 5, 15, 0));
    const at = (id: string, timestamp: number) => ({
      ...fromNil,
      id,
      timestamp,
    });
    const titles = cardTitles(
      render({
        membersChat: {
          messages: [
            at("202509-00000001", new Date(2025, 1, 3, 9, 7).getTime()),
            at("202602-00000001", new Date(2026, 1, 3, 9, 7).getTime()),
            at("202609-00000001", new Date(2026, 8, 5, 9, 7).getTime()),
          ],
          hasMore: false,
          loaded: true,
          readPointer: null,
          unread: 0,
        },
      }),
    );
    expect(titles).toEqual([
      "Nil (Phone) · Feb 3, 2025",
      "Nil (Phone) · Feb 3, 09:07",
      "Nil (Phone) · 09:07",
    ]);
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
    expect(empty).toContain(en.t("membersChat.empty"));
    const pending = render({
      membersChat: {
        messages: [],
        hasMore: false,
        loaded: false,
        readPointer: null,
        unread: 0,
      },
    });
    expect(pending).not.toContain(en.t("membersChat.empty"));
  });
});
