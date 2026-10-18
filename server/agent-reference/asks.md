# Asks

An ask is a question or request for one member that can wait. It stays above the chat input for that member, with a reply field, until they answer it. Open one instead of asking again in later messages: the member still sees it, so you do not need to repeat it.

Open one with `POST /api/agents/:id/asks`, where `:id` is your own agent id. Send the prompt as a text/plain body, up to 4000 characters. It goes to your manager; to send it to another member who can reach your room, add `member=<username>` to the query. With a quoted heredoc, nothing needs escaping:

```
curl -s -X POST "<office>/api/agents/<your-id>/asks" -H "<authorization>" -H 'Content-Type: text/plain' --data-binary @- <<'EOF'
Pull a per-agent spend breakdown before we change models?
EOF
```

The answer arrives as a normal message from the member, starting with `[Reply to your ask <id>: "<prompt>"]`. If the member dismisses it, the bracket says `Dismissed your ask` and the message is `Dismissed`. Either way the ask closes.

`GET /api/agents/:id/asks/:askId` returns the ask while it is open and 404 once it is closed. `GET /api/agents/:id/asks` lists your open ones. Change the prompt with `PATCH /api/agents/:id/asks/:askId` and a text/plain body. When the question no longer applies, for example because the member answered in the chat, delete it with `DELETE /api/agents/:id/asks/:askId`. You can have 50 open at a time. You can manage only your own asks.

Safe example: `GET /api/agents/<your-id>/asks`.

## Route contract

| Method and route                                   | Request                                                | Success                             |
| -------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `POST /api/agents/:id/asks`                 | text/plain prompt, query `member`; or `{text,member?}` | `201` ask                    |
| `GET /api/agents/:id/asks`                  | None                                                   | Your open asks, oldest first |
| `GET /api/agents/:id/asks/:askId`    | None                                                   | The ask                      |
| `PATCH /api/agents/:id/asks/:askId`  | text/plain prompt; or `{text}`                         | The ask                      |
| `DELETE /api/agents/:id/asks/:askId` | None                                                   | `204`                               |

An ask is `{id, agentId, memberUserId, member, prompt, createdAt, updatedAt}`. A closed or unknown id returns 404. An `:id` other than your own returns 403. An empty or too long prompt returns 400. An unknown `member`, or a member who cannot reach your room, returns 422. With no `member`, an agent without a manager gets 409. More than 50 open asks returns 429.
