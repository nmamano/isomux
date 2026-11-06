# Pager - v0 design

Status: agreed with Nil on 2026-10-05 and implemented the same day (P1-P4, task
cb34ffc9). Web Push came later (task dc2dc0ea). Since task 74e8fc07 (Nil,
2026-11-06: "Page is an ask") a page is a paged ask: see "Pages as asks". The
sections from "The page record" on describe v0; where they differ, "Pages as
asks" wins. Code references describe the tree at commit `708374c2`.

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
- The Inbox lists all pages (since task 74e8fc07, as asks).

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
  Shipped later (task dc2dc0ea): `server/web-push-*.ts`.
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

## Pages as asks

Task 74e8fc07, in four slices. A page is an ask with an alarm
(internal-docs/asks-design.md, "Paged asks"); the pager store is gone.

- Both delivery channels read page items (`server/page-items.ts`): one per
  recipient of a ringing or acked paged ask, linked to `/inbox/asks/<id>`. A
  paged ask's pending "resolved" message is in memory only.
- Every paged ask has a page id (`page.pageId`, 16 hex; a migrated page keeps
  its own, 8 hex on pages from before 2026-10), indexed from its create in
  `ask_history_pages` (office.sqlite).
- The pager routes keep their API over paged asks
  (`server/routes/handlers/pager.ts`, `server/pager-compat.ts`): a raise opens
  a P1 paged ask for the target, or raises into the open one of that source
  with its key (an agent's: only the one for its manager now), counting the
  raise; the answer is the `PagerEntry` built from the ask, with `askId`.
  Who sees and acts is the ask's rule: the member it is for and office
  owners, and the source agent for its own page. Only a member acks. The
  source agent withdraws its page; a member resolves it as a dismiss that
  tells the agent nothing. Other agents in the room, and an app's message
  target, no longer see or act on it. An app's page whose message target is
  gone is an ask with no agent.
- Migration (`server/pager-migration.ts`), at each boot after the agents are
  restored: every page of `pager.json` and `pager-resolved.jsonl` not yet in
  the index becomes a paged ask (open or acked) or a closed ask in the history
  (resolved, or its agent, app or member gone), in one transaction. The old
  files are only read. `pager-migration.json` holds the archive's size at the
  last complete run, so an unchanged archive is not read again; a page that
  cannot become an ask is left for the next boot.
- Rollback: an older release rings its `pager.json` page while this one rings
  the paged ask, and a page resolved in `pager.json` during a rollback stays an
  open ask after the update. A raise with an old key between the server's
  listen and the migration opens a second ask with that key.
- UI: the Pages tab is gone. `/inbox/pages` and a saved Pages view open the
  Asks view; a `/?pager=<id>` link from an older message pins the page's ask
  (`askIdForPage`, `ui/inbox.ts`). The Inbox badge counts new asks, paged ones
  included.

## Delivery: Discord

Discord, not Web Push, because a send is one HTTPS POST with a JSON body to a
URL the member pastes in. There is no service worker work, no key management,
and no device subscriptions.

Member settings (Integrations → Pager; Settings → You until task db800fd8):

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

Web Push (added later, task dc2dc0ea): the same events also go to each
device where the member turned on notifications, encrypted for the device
(RFC 8291) and signed with the office's VAPID key (`web-push.json`, made on
first use). Every page goes, whatever the member's room notification settings
(PM ruling, 2026-10-16); the turn-end push follows the rooms the member set to the Push view level (pushRooms). Repeat timers are in memory, so a restart between a
resolve and its push loses that "Resolved" push. Sign-out removes the device.
Code: `server/web-push-*.ts`, `ui/sw.js`, `ui/components/PushDevicesBlock.tsx`.

Failure: a failed send records its class on the page's send record. The next
repeat tick retries. On a 429, the server waits for Discord's `retry_after`. A
member with no webhook still gets the page in the Inbox, marked as not
delivered on `GET /api/pager`.

## Pager view and storage of resolved pages

The Pages tab (`ui/components/PagerView.tsx`) and the store's archive
(`pager-resolved.jsonl`, written by `server/pager-store.ts`) were removed by
task 74e8fc07. Resolved pages are closed asks in the ask history; the files
stay for the migration.

## Docs to update

The surfaces in `internal-docs/documentation.md`, including the README feature
list, the agent-reference pages, and `server/system-prompt.ts`.
