# Asks

An ask is a question or request for one member that can wait. It stays above the chat input for that member and in their Inbox, with a reply field, until they answer it. Open one instead of asking again in later messages: the member still sees it, so you do not need to repeat it.

Open one with `POST /api/agents/:id/asks`, where `:id` is your own agent id. Send the prompt as a text/plain body, up to 4000 characters. It goes to your manager; to send it to another member who can reach your room, add `member=<username>` to the query. With a quoted heredoc, nothing needs escaping:

```
curl -s -X POST "<office>/api/agents/<your-id>/asks" -H "<authorization>" -H 'Content-Type: text/plain' --data-binary @- <<'EOF'
Pull a per-agent spend breakdown before we change models?
EOF
```

When the member must act on an office page, for example to sign in to an MCP server or pair their Chrome, add `link=<page>` to the query (or `link` in a JSON body). The ask card then has a button that opens that page. The value is an office page name in path form, not a URL: `/tasks`, `/automations`, `/apps`, `/skills`, `/integrations`, `/settings`, `/inbox/pages`, `/inbox/asks`, or an Integrations tab: `/integrations/providers` (Claude and Codex sign-in), `/integrations/mcp`, `/integrations/secrets`, `/integrations/variables`, `/integrations/browser` (Chrome pairing). Each of these paths on the office's web address also opens its page as a plain link. When the member must act in another agent's chat, set `link` to `/agents/<agentId>`: the button opens that agent's chat, and this form opens only from the card. The member must be able to reach the agent's room.

When the answer is one of a few choices, add 2 to 4 options, one `option=<text>` each in the query (or `options` in a JSON body). Each is at most 80 characters, and they must differ. The card shows a button for each. A tap puts that option in the reply field, and the member can edit it before sending. A secret request has no options.

An ask can carry chat affordances, at most 10 in total: `commands` for the member's terminal panel (as terminal-command), `editFiles` to open in the editor (as edit-file) and `readFiles` to show as file or image chips (as read-file). Paths resolve against your cwd, and a read file is copied when you create or edit the ask. In the query, add one `command=`, `editFile=` or `readFile=` per item, percent-encoded with `%20` for a space, since a `+` stays a plus. A command is easier in a JSON body:

```
curl -s -X POST "<office>/api/agents/<your-id>/asks" -H "<authorization>" -H 'Content-Type: application/json' --data-binary @- <<'EOF'
{"text": "Delete the merged branches t-a and t-b?", "commands": ["git branch -D t-a t-b && git push origin --delete t-a t-b"]}
EOF
```

The ask returns the resolved forms: `editFiles` as `{cwd, path}` and `readFiles` as the copies' `{filename, originalName, mediaType, size}`. A secret request has none.

The answer arrives as a normal message from the member, starting with `[Reply to your ask <id>: "<prompt>"]`. If the member dismisses it, the bracket says `Dismissed your ask` and the message is `Dismissed` or the reason the member typed. Either way the ask closes.

`GET /api/agents/:id/asks/:askId` returns the ask while it is open and 404 once it is closed. `GET /api/agents/:id/asks` lists your open ones. Change the prompt with `PATCH /api/agents/:id/asks/:askId` and a text/plain body. The edit keeps the link unless you send a new `link=` value to change it or `link=` to remove it. In the same way, `option=` values replace the options, and a single empty `option=` (or `options: []`) removes them; `commands`, `editFiles` and `readFiles` work the same way. When the question no longer applies, for example because the member answered in the chat, delete it with `DELETE /api/agents/:id/asks/:askId`. You can have 50 open at a time. You can manage only your own asks.

A secret request (see the connections page) is also one of your asks. It has `secret: {requestId, scope, name, hosts, form, reason}`, and its prompt is the reason. The member answers it in its masked form, not with a reply. You cannot edit it, but you can delete it to withdraw the request. An office secret request is for every office owner: it has no `memberUserId`, and `member` is null.

Safe example: `GET /api/agents/<your-id>/asks`.

## Route contract

| Method and route                     | Request                                                                                                                                                    | Success                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `POST /api/agents/:id/asks`          | text/plain prompt, query `member`, `link`, `option`, `command`, `editFile`, `readFile`; or `{text,member?,link?,options?,commands?,editFiles?,readFiles?}` | `201` ask                    |
| `GET /api/agents/:id/asks`           | None                                                                                                                                                       | Your open asks, oldest first |
| `GET /api/agents/:id/asks/:askId`    | None                                                                                                                                                       | The ask                      |
| `PATCH /api/agents/:id/asks/:askId`  | text/plain prompt, query `link`, `option`, `command`, `editFile`, `readFile`; or `{text,link?,options?,commands?,editFiles?,readFiles?}`                   | The ask                      |
| `DELETE /api/agents/:id/asks/:askId` | None                                                                                                                                                       | `204`                        |

An ask is `{id, agentId, memberUserId, member, prompt, createdAt, updatedAt, link?, options?, commands?, editFiles?, readFiles?, secret?}`. A closed or unknown id returns 404. An `:id` other than your own returns 403. An empty or too long prompt returns 400. An unknown `member`, or a member who cannot reach your room, returns 422. With no `member`, an agent without a manager gets 409. A `link` that is not one of the pages above, or names an agent that does not exist or whose room the member cannot reach, returns 422 `invalid_link`. Options that break the rules above return 422 `invalid_options`. A bad command or path returns 422 `invalid_command`, `invalid_edit_file` or `invalid_read_file`, and a credential store path 403 `forbidden_path`. A list that is not strings, an empty list on create, or more than 10 in total returns 422 `invalid_affordances`. A refused create or edit changes nothing. More than 50 open asks returns 429. An edit of a secret request returns 409 `secret_request`.
