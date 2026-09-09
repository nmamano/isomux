# Lobby chat unread and layout (2026-09-09)

Tasks: 33e17110 (unread signals stay on) and 4580172b (lighter chat layout).

## Unread surfaces and clear paths

- `ui/office/RoomTabBar.tsx` renders `MembersChatUnread` on the Lobby tab.
  On mobile, the dot moves to the Members chat entry when the lobby opens.
  `ui/members-chat/LobbyChat.tsx` renders that entry. Both use the same
  `state.membersChat.unread` through `MembersChatUnread.tsx`; zero removes it.
- The client office state keeps `membersChat.unread`. `ui/store.tsx` replaces
  it on REST page hydration and on `members_chat_read`, and increments its
  local estimate on another author's new message. `full_state` carries no
  members-chat count (`shared/types.ts`); it invalidates the loaded flag so
  `useMembersChatHydration.ts` fetches the count again.
- The visible `MembersChatPanel.tsx` calls POST `/api/members-chat/read` after
  500 ms at the bottom in a visible document. The response clears the count
  locally. The server also sends `members_chat_read` to that user's sockets
  (`server/events/registry.ts`, `server/isomux-office.ts`). A hidden desktop
  panel, closed mobile panel, hidden browser tab, or reader in history does
  not mark messages read.
- The server stores a per-user pointer. `server/members-chat.ts` orders posts
  by file position, skips deleted messages when counting unread, and refuses
  backwards pointer moves. GET `/api/members-chat` returns that pointer/count.
- The UI has no browser Notification/showNotification call for members chat.
  The notification sound in `ui/store.tsx` is for agent turn completion;
  members chat does not trigger it. There is no separate browser notification
  to dismiss for this stream.

## Cause and evidence

Message IDs have a random eight-hex suffix. The old panel guard compared
`newestId <= readPointer`, so a later message with a lower suffix could never
be marked read. The fix tests equality; the server keeps the pointer monotonic.

The same ordering assumption was in fresh-page merging. It could discard a
live arrival with a lower ID or append old cached messages below the new page.
The loader now captures held IDs when it issues a fetch. Its client-local
`heldAtRequest` field removes the request-time cache while retaining arrivals
not in the response. Request cleanup ignores superseded responses, including
when a reconnect starts another fetch. Neither timestamps nor IDs order posts.

Measured on 2026-09-09 in isolated Chrome sessions against the real in-process
server harness with two authenticated cookie users: after one user posts two
messages and the other reads the first, a lower-ID second message leaves
unread=1 and the dot present on desktop and mobile with the old bundle. The
changed bundle sends the read request and reaches unread=0 with no dot.
The browser fixture uses the harness HTTP adapter for API calls, which supplies
its test origin and session cookie. No live office writes were made.

The live office rejected the ordinary worker's GET with 403 as designed. The
PM supplied a privileged-reader metadata sample with pointer
`202609-dd4d0ac3`, unread=4, and newer last message `202609-b43dff11`.
This was the PM's reader, not a verified sample of Nil's reader. It has the
same failing ID order as the isolated reproduction.

## Layout and checks

The members-chat variant of UserMessage uses the office `DM Sans, sans-serif`
stack. The composer, attachment chip, mobile entry, and edit textarea use it
as well. The agent-chat default remains in the shared component.

Adjacent surviving messages collapse the author line when userId, kind and
device match and the gap from the immediately previous message is between
zero and five minutes inclusive. Only user messages collapse; api and agent messages keep their italic author
line on every message. Each group header shows its time, and each message
also has its own time in a title.

Desktop width starts at 520 px. The edge separator supports pointer dragging
and arrow keys, and stores width in the browser's device settings on pointer-up or keydown. The width
is clamped to 300..min(900, viewport width minus 48) on read and resize. Mobile
uses full width, has no separator, and does not read the desktop width setting.

Measured on 2026-09-09 in Chrome at 1440×900: an eight-step drag from 520 to
680 px changed the zoom inset to 692 px. The scene and centered child had zero
style mutations and unchanged rectangles/transforms at all eight steps.
Reload restored 680 px. No deferred inset update is needed.

Regression tests: `read-order.dom.test.tsx`, `hydration-order.dom.test.tsx`,
`collapse.dom.test.tsx`, `width.dom.test.tsx`, `width-i18n.dom.test.tsx`, and
`ui/store.test.ts`. The desktop persistence test now uses one OfficeView mount
instead of five; the default/invalid visibility check lives in the cheaper
device-settings test. Browser reload also checks width persistence.
