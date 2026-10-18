# Asks

Task fd794190. Design agreed with Nil on 2026-10-18; the mocks Nil approved are in the lane b1034 report.

An ask is a prompt from an agent to one member, answered when the member has time. It stays above the agent's chat input for that member until the member replies or dismisses it, so the agent does not repeat the question and the question does not get lost under later messages.

## Store

- `server/asks.ts` keeps the open entries in `~/.isomux/asks.json`, an array of `{id, agentId, memberUserId?, prompt, createdAt, updatedAt, link?, secret?}`. The load check admits three shapes: a plain ask and a personal secret request name one member; an office secret request names none (see "Secret requests"). Closed entries are not kept: a reply, a dismiss, the agent's delete, or the agent's removal deletes the entry.
- A missing file is an empty list, so an office from before this feature boots unchanged. A corrupt file is moved aside; an unreadable one makes the store refuse every call (the pager store's posture).
- Every change writes the file first and changes memory after.
- Bounds: a prompt is at most 4000 characters; an agent has at most 50 open.

## Routes

The agent manages its own list on `/api/agents/:id/asks` (`self:affordance` and `agentParamMustEqualTokenAgent`, so a token reaches only its own `:id`; an entry of another agent is a 404 on its own path). Create and edit take the text/plain form (`shared/plain-text-form.ts`); create takes `member=<username>`, default the agent's manager, and the member must reach the agent's room.

Create and edit take an optional `link` to an office page (task 3ea6fdb3): one of `OFFICE_LINK_PATHS` in `shared/office-links.ts`, the canonical path of each UI page and `/integrations/<tab>` for each Integrations tab. The page and tab lists live there, and `ui/routes.ts` and the Integrations page read them, so a new page or tab is a target with no second list. The tab forms are link targets, not URL routes. The handlers check the link on write (422 `invalid_link`); the load check takes any non-empty string, so a target a later release drops cannot quarantine the file, and the card draws no link it does not know. On edit an absent `link` keeps it and `""` removes the key. A secret request never has a link.

The member answers on `/api/asks/:id/reply` and `/dismiss` (`agent:converse` or `api:send-message`, `memberScope`). One function, `askVisibleTo` in `server/asks.ts`, decides who sees and answers an ask, from live state: the target member, or every office owner for an office secret request, and only while that member can reach the agent's room. `GET /api/asks`, the `ask_*` push, the answer routes and the secret request routes all call it. On the ask routes anyone it refuses gets the 404 of an unknown id; on a secret request's save and decline routes, 403 `forbidden`.

## The answer

A reply or a dismiss goes through `agentManager.sendMessage`, the path a typed member message takes, with `opts.ask` (`sendMemberMessage` in `server/isomux-office.ts` wraps it for the chat, API-token and ask sends). So it wakes or resumes the agent the same way and is refused only where a typed message is, with the same status and code. The ask closes once the message is accepted, which means its echo is durable or it is in the queue; a refused message leaves it open, and a failure after acceptance (a wake or backend error) closes it, as a typed message leaves the composer. Two differences from a typed message:

- It is never a slash command and never the answer to a pending prompt: it skips the typed-choice claim, and while the agent is busy or parked on a two-step prompt it waits in the queue. When the member's answer ends a prompt on an idle agent (/model, /effort, /resume, a cronjob choice), `sendMessage` flushes the queue, since no turn end does; a permission prompt ends inside a turn, whose end flushes it.
- The agent reads `[Member] [Reply to your ask <id>: "<whole prompt>"] <text>`; a dismiss says `Dismissed your ask` and the text is `Dismissed`. The `user_message` log entry carries `metadata.ask: {id, prompt, dismissed?}`, and the queued item carries the same field, so the note survives a restart in the durable queue.

## Secret requests

A secret request (`server/secret-requests.ts`, `POST /api/agents/:id/secret-requests`) is an ask with `secret: {requestId, scope, name, hosts, form, reason}`; the prompt is the reason. The ask is the only record of an open request, so it survives a restart. It never holds the value: the save body goes to the secret store only.

- A personal request is for the agent's manager when it opened (`memberUserId`). An office request has no `memberUserId` and is for every office owner who can reach the room; the first save or decline closes it for all.
- The member answers on the secret request's save and decline routes. A reply or dismiss gets 409 `secret_request`, so a value typed there never reaches the chat or the agent. The agent's edit gets the same 409; its delete withdraws the request.
- The save creates the secret, then removes the ask, with no await between the permission check and the removal. If the removal fails, the agent is still told, since the secret exists. A decline removes the ask first and tells the agent only after that.
- The chat shows the agent's call, the system line with the outcome and the agent's save or decline message. A `secret-request` log entry from a server before this change draws a read-only card: its outcome, else closed.

## UI

- The store slice `asks` is filled by `useAsksSync` (`GET /api/asks` on each hydration epoch) and kept live by `ask_upserted` and `ask_removed`, which only the sockets of members `askVisibleTo` admits receive.
- `ui/log-view/AsksStack.tsx` draws the stack above the input: open by default on a desktop, collapsed on a phone, 240 px high on a desktop and 45% of the viewport on a phone before it scrolls. Each card is `ui/log-view/AskCard.tsx`, which the Asks page draws too, so a new kind of ask goes in the card; a secret request draws through `SecretAskCard`.
- The Asks page (`/asks`, `ui/components/AsksView.tsx`) lists the member's open asks grouped by agent, the longest wait first; the agent's name opens its chat. The office bar's Asks entry counts the same list. Both read `visibleAsks`: the asks whose agent is in the agents slice. `GET /api/asks` filters on room access, but an agent in a room the member hides never reaches the client, so its asks stay off the page, as they stay off the desks.
- The desk shows a count dot on the nameplate's corner (`DeskUnit`), and a back-room agent the same dot on its smaller plate (`BackRoomScreen`); the trap door shows no count. Desk rows step 60 scene units vertically, so the front dot (7 units above the plate) stays clear of the plate behind it at any scale; in the back room the nearest plate above is a table behind, about 34 units higher, and the dot reaches 5.
- An ask with a link has an "Open <page>" button under its prompt. App provides the opener (`OfficeLinkOpener`, `ui/office-link.tsx`): it opens the page on top of the chat or the Asks page, so Close and Back return there; the ask stays open.
- In the agent's chat, an answer shows a one-line "Ask" link (`ui/log-view/ask-link.tsx`). A click scrolls to the "Create ask" card whose result holds the id; without that card the line is text.
