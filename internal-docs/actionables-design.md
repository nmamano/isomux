# Actionables

Task fd794190. Design agreed with Nil on 2026-10-18; the mocks Nil approved are in the lane b1034 report.

An actionable is a prompt from an agent to one member, answered when the member has time. It stays above the agent's chat input for that member until the member replies or dismisses it, so the agent does not repeat the question and the question does not get lost under later messages.

## Store

- `server/actionables.ts` keeps the open entries in `~/.isomux/actionables.json`, an array of `{id, agentId, memberUserId, prompt, createdAt, updatedAt}`. Closed entries are not kept: a reply, a dismiss, the agent's delete, or the agent's removal deletes the entry.
- A missing file is an empty list, so an office from before this feature boots unchanged. A corrupt file is moved aside; an unreadable one makes the store refuse every call (the pager store's posture).
- Every change writes the file first and changes memory after.
- Bounds: a prompt is at most 4000 characters; an agent has at most 50 open.

## Routes

The agent manages its own list on `/api/agents/:id/actionables` (`self:affordance` and `agentParamMustEqualTokenAgent`, so a token reaches only its own `:id`; an entry of another agent is a 404 on its own path). Create and edit take the text/plain form (`shared/plain-text-form.ts`); create takes `member=<username>`, default the agent's manager, and the member must reach the agent's room.

The member answers on `/api/actionables/:id/reply` and `/dismiss` (`agent:converse` or `api:send-message`, `memberScope`). Only the target member, while it can reach the agent's room, gets past the handler; anyone else gets the 404 of an unknown id. `GET /api/actionables` lists the caller's open entries in rooms it can reach.

## The answer

A reply or a dismiss goes through `agentManager.sendMessage`, the path a typed member message takes, with `opts.actionable` (`sendMemberMessage` in `server/isomux-office.ts` wraps it for the chat, API-token and actionable sends). So it wakes or resumes the agent the same way and is refused only where a typed message is, with the same status and code. The actionable closes once the message is accepted, which means its echo is durable or it is in the queue; a refused message leaves it open, and a failure after acceptance (a wake or backend error) closes it, as a typed message leaves the composer. Two differences from a typed message:

- It is never a slash command and never the answer to a pending prompt: it skips the typed-choice claim, and while the agent is busy or parked on a two-step prompt it waits in the queue. When the member's answer ends a prompt on an idle agent (/model, /effort, /resume, a cronjob choice), `sendMessage` flushes the queue, since no turn end does; a permission prompt ends inside a turn, whose end flushes it.
- The agent reads `[Member] [Reply to your actionable <id>: "<prompt cut to 80>"] <text>`; a dismiss says `Dismissed your actionable` and the text is `Dismissed`. The `user_message` log entry carries `metadata.actionable: {id, prompt, dismissed?}`, and the queued item carries the same field, so the note survives a restart in the durable queue.

## UI

- The store slice `actionables` is filled by `useActionablesSync` (`GET /api/actionables` on each hydration epoch) and kept live by `actionable_upserted` and `actionable_removed`, which only the target member's sockets receive.
- `ui/log-view/ActionablesStack.tsx` draws the stack above the input: open by default on a desktop, collapsed on a phone, 240 px high on a desktop and 45% of the viewport on a phone before it scrolls.
- The desk shows a count dot on the nameplate's corner (`DeskUnit`), and a back-room agent the same dot on its smaller plate (`BackRoomScreen`); the trap door shows no count. Desk rows step 60 scene units vertically, so the front dot (7 units above the plate) stays clear of the plate behind it at any scale; in the back room the nearest plate above is a table behind, about 34 units higher, and the dot reaches 5.
- In the agent's chat, an answer shows a one-line "Actionable" link (`ui/log-view/actionable-link.tsx`). A click scrolls to the "Create actionable" card whose result holds the id; without that card the line is text.
