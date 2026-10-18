# Actionables

An actionable is a question or request for one member that can wait. It stays above the chat input for that member, with a reply field, until they answer it. Open one instead of asking again in later messages: the member still sees it, so you do not need to repeat it.

Open one with `POST /api/agents/:id/actionables`, where `:id` is your own agent id. Send the prompt as a text/plain body, up to 4000 characters. It goes to your manager; to send it to another member who can reach your room, add `member=<username>` to the query. With a quoted heredoc, nothing needs escaping:

```
curl -s -X POST "<office>/api/agents/<your-id>/actionables" -H "<authorization>" -H 'Content-Type: text/plain' --data-binary @- <<'EOF'
Pull a per-agent spend breakdown before we change models?
EOF
```

The answer arrives as a normal message from the member, starting with `[Reply to your actionable <id>: "<prompt>"]`. If the member dismisses it, the bracket says `Dismissed your actionable` and the message is `Dismissed`. Either way the actionable closes.

`GET /api/agents/:id/actionables/:actionableId` returns the actionable while it is open and 404 once it is closed. `GET /api/agents/:id/actionables` lists your open ones. Change the prompt with `PATCH /api/agents/:id/actionables/:actionableId` and a text/plain body. When the question no longer applies, for example because the member answered in the chat, delete it with `DELETE /api/agents/:id/actionables/:actionableId`. You can have 50 open at a time. You can manage only your own actionables.

Safe example: `GET /api/agents/<your-id>/actionables`.

## Route contract

| Method and route                                     | Request                                       | Success                                |
| ---------------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| `POST /api/agents/:id/actionables`                   | text/plain prompt, query `member`; or `{text,member?}` | `201` actionable                       |
| `GET /api/agents/:id/actionables`                    | None                                          | Your open actionables, oldest first    |
| `GET /api/agents/:id/actionables/:actionableId`      | None                                          | The actionable                         |
| `PATCH /api/agents/:id/actionables/:actionableId`    | text/plain prompt; or `{text}`                | The actionable                         |
| `DELETE /api/agents/:id/actionables/:actionableId`   | None                                          | `204`                                  |

An actionable is `{id, agentId, memberUserId, member, prompt, createdAt, updatedAt}`. A closed or unknown id returns 404. An `:id` other than your own returns 403. An empty or too long prompt returns 400. An unknown `member`, or a member who cannot reach your room, returns 422. With no `member`, an agent without a manager gets 409. More than 50 open actionables returns 429.
