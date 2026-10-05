# Pager - v0 design

Status: agreed with Nil on 2026-10-05. Not implemented. Code references describe
the tree at commit `708374c2`.

## Why

A pack is one room of agents plus a just-in-time app that runs one business
process (see the blog draft `nilmamano.com/blog/isomux-packs.mdx`). The promise
is that the member never looks at the room or the app proactively, and gets
involved only when something goes wrong. Today nothing in Isomux reaches a
member whose browser is closed. An agent-only turn sets a badge and plays no
sound (`internal-docs/operator-alerting-design.md`). The pager closes that gap.

## v0 scope

- Agents and apps raise a page through the office API.
- The server delivers the page to the member's Discord, through a Discord
  incoming webhook.
- The page repeats until someone acks it.
- A pager view in the UI lists all pages.

Out of scope for v0 (possible follow-ups):

- Server-side watchdog pages for agent failures: crashes, `error` state, auth
  expiry, running out of credits or usage limit, app crash loops. This is the
  most valuable follow-up. Hook points: `updateState` in
  `server/agent-manager.ts`, the auth-error path that parks an agent at
  `waiting_for_response`, `subscriptionUsage` and `server/office-usage.ts` for
  a warning before the limit, and the systemd restart count in
  `server/app-supervisor.ts`.
- Slack channel.
- Web Push channel (needs a push handler in `ui/sw.js`, VAPID keys, device
  subscriptions, payload encryption, HTTPS, and iOS home-screen install).
- Escalation to other members, on-call lists.
- Ack from inside Discord (needs a Discord bot, not a webhook).
- Breaking through Do Not Disturb.

## The page record

A page is durable state, not a chat message. Fields:

- `id`, `createdAt`, `lastRaisedAt`, `raiseCount`
- `source`: the agent id or app name that raised it, and its room id
- `target`: the member who receives it. In v0 this is the source's owner: the
  agent's manager, or the app's owner.
- `title` (short, one line) and `body` (optional, a few lines)
- `key` (optional): a dedupe key chosen by the source
- `state`: `open`, `acked` or `resolved`, with who did each transition and when
- `delivery`: time of the last send attempt, number of sends, and the last
  failure class (for example `no_webhook`, `http_4xx`, `rate_limited`,
  `network`). Never the webhook URL or the raw response body.

Pages persist across server restarts, with the same storage pattern as the task
board.

Code naming: the UI already uses `page` for its views (`entry.page === "tasks"`
in `ui/App.tsx`). Use a distinct type name in code, for example `PagerEntry`,
and keep "page" for user-facing copy.

## Raising a page

- Agents: a new route, `POST /api/pager`, with `{title, body?, key?}`. The
  token gives the source; the caller cannot set the source or the target.
- Apps: a new app route next to `apps.sendMessage` (`POST /api/app/message`,
  `server/routes/table.ts`). Today that is the only route an app identity
  authorizes, and `server/test-support/routes-table.test.ts` pins it, so the test changes with it.
  Apps need their own path because the normal chain (app messages agent, agent
  decides to page) fails silently when the agent is down.
- Dedupe: if an open or acked page from the same source has the same `key`, the
  server updates that page (`lastRaisedAt`, `raiseCount`, new body) and does not
  create a new one. A health app that checks every 15 minutes then makes one
  page per incident, not one per check. A raise on an acked page does not
  re-open it.
- Resolve: the source can resolve its own page (for example, the health check
  passes again), and the target member can resolve it from the UI.

Both routes go in `ROUTE_LABELS` in `ui/log-view/isomux-curl.ts`, and get an
agent-reference page and a pointer in `server/system-prompt.ts`.

## Delivery: Discord

Discord, not Web Push, because a send is one HTTPS POST with a JSON body to a
URL the member pastes in. There is no service worker work, no key management,
and no device subscriptions.

Member settings (Settings → You):

- Discord webhook URL. The URL is a credential: store it with the member's
  other secrets, show it masked, and never log it or put it in a page record.
- Discord user ID, so the message @mentions the member and the phone pings.
  The send sets `allowed_mentions` to that one user.
- Repeat interval, in minutes, or "never". The default is a constant (5
  minutes), not an env var.
- A "send test page" button.

The message holds the title, the body, the room and source names, and a link to
the page in the pager view of the office. The office origin comes from the same
place other absolute office links come from (unchecked: find that source when
implementing).

Repeat: while a page is `open`, the server re-sends it every repeat interval.
Ack and resolve stop the repeats. Resolve also sends one short "resolved"
message.

Failure: a failed send records its class on the page and the view shows it. The
next repeat tick retries. On a 429, the server waits for Discord's
`retry_after`. A member with no webhook still gets the page in the pager view,
marked as not delivered.

## Pager view

A new view, modeled on the task board (`ui/components/TaskView.tsx`, routed as
`page === "tasks"` in `ui/App.tsx`):

- Lists all pages the member can see, newest first, with open pages on top.
- Filters: state (default: open and acked) and room.
- A row shows the title, source and room, age, raise count, state, and delivery
  status.
- Actions: ack and resolve. The row links to the source agent's chat.
- The Discord link opens the view with that page selected.
- A badge on the view's entry point counts open pages for the member.

Visibility follows room access, the same as tasks.

## Docs to update

The surfaces in `internal-docs/documentation.md`, including the README feature
list, the agent-reference pages, and `server/system-prompt.ts`.
