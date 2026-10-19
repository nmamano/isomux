# Asks

An ask is a question or request for one member that can wait. It stays above the chat input for that member and in their Inbox, with a reply field, until they answer it. Open one instead of asking again in later messages: the member still sees it, so you do not need to repeat it.

Open one with `POST /api/agents/:id/asks`, where `:id` is your own agent id. Send the prompt as a text/plain body, up to 4000 characters. It goes to your manager; to send it to another member who can reach your room, add `member=<username>` to the query. With a quoted heredoc, nothing needs escaping:

```
curl -s -X POST "<office>/api/agents/<your-id>/asks" -H "<authorization>" -H 'Content-Type: text/plain' --data-binary @- <<'EOF'
Pull a per-agent spend breakdown before we change models?
EOF
```

When the member must act on an office page, for example to sign in to an MCP server or pair their Chrome, add `link=<page>` to the query (or `link` in a JSON body). The ask card then has a button that opens that page. The value is an office page name in path form, not a URL, and it opens only from the card: `/tasks`, `/automations`, `/apps`, `/skills`, `/integrations`, `/settings`, `/inbox/pages`, `/inbox/asks`, or an Integrations tab: `/integrations/providers` (Claude and Codex sign-in), `/integrations/mcp`, `/integrations/secrets`, `/integrations/variables`, `/integrations/browser` (Chrome pairing).

When the answer is one of a few choices, add 2 to 4 options, one `option=<text>` each in the query (or `options` in a JSON body). Each is at most 80 characters, and they must differ. The card shows a button for each, and a tap sends that option as the reply. The member can still type another answer. A secret request has no options.

The answer arrives as a normal message from the member, starting with `[Reply to your ask <id>: "<prompt>"]`. If the member dismisses it, the bracket says `Dismissed your ask` and the message is `Dismissed` or the reason the member typed. Either way the ask closes.

`GET /api/agents/:id/asks/:askId` returns the ask while it is open and 404 once it is closed. `GET /api/agents/:id/asks` lists your open ones. Change the prompt with `PATCH /api/agents/:id/asks/:askId` and a text/plain body. The edit keeps the link unless you send `link=<page>` to change it or `link=` to remove it. In the same way, `option=` values replace the options, and a single empty `option=` (or `options: []`) removes them. When the question no longer applies, for example because the member answered in the chat, delete it with `DELETE /api/agents/:id/asks/:askId`. You can have 50 open at a time. You can manage only your own asks.

A secret request (see the connections page) is also one of your asks. It has `secret: {requestId, scope, name, hosts, form, reason}`, and its prompt is the reason. The member answers it in its masked form, not with a reply. You cannot edit it, but you can delete it to withdraw the request. An office secret request is for every office owner: it has no `memberUserId`, and `member` is null.

Safe example: `GET /api/agents/<your-id>/asks`.

## Route contract

| Method and route                     | Request                                                                                 | Success                      |
| ------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------- |
| `POST /api/agents/:id/asks`          | text/plain prompt, query `member`, `link`, `option`; or `{text,member?,link?,options?}` | `201` ask                    |
| `GET /api/agents/:id/asks`           | None                                                                                    | Your open asks, oldest first |
| `GET /api/agents/:id/asks/:askId`    | None                                                                                    | The ask                      |
| `PATCH /api/agents/:id/asks/:askId`  | text/plain prompt, query `link`, `option`; or `{text,link?,options?}`                   | The ask                      |
| `DELETE /api/agents/:id/asks/:askId` | None                                                                                    | `204`                        |

An ask is `{id, agentId, memberUserId, member, prompt, createdAt, updatedAt, link?, options?, secret?}`. A closed or unknown id returns 404. An `:id` other than your own returns 403. An empty or too long prompt returns 400. An unknown `member`, or a member who cannot reach your room, returns 422. With no `member`, an agent without a manager gets 409. A `link` that is not one of the pages above returns 422 `invalid_link`. Options that break the rules above return 422 `invalid_options`. More than 50 open asks returns 429. An edit of a secret request returns 409 `secret_request`.
