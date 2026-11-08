# Asking for a step

Part of the `asks` page: steps that are not a value, which the member does in the ask card.

Some settings are not a value: a Claude or Codex sign-in, an MCP server's OAuth sign-in, pairing your manager's Chrome, and a room's GitHub issue link. Ask the member for one with an ask (see the asks page) whose JSON body has `step`. The member does it in the card. The ask closes itself when the step is done, and an Isomux notice tells you; until then the member can also reply or dismiss it.

- `{kind:"provider-sign-in",provider,scope?}`: `provider` is `claude` or `codex`; `scope` is `personal` (the default: your manager's own sign-in) or `office` (an office owner).
- `{kind:"mcp-sign-in",name,scope?}`: an MCP server that signs in with OAuth, your manager's (`personal`, the default) or the office's.
- `{kind:"browser-pairing"}`: your manager's Chrome.
- `{kind:"github-link"}`: your room's GitHub issue link (an office owner).

Errors: 400 `invalid_request` for a step that is not one of these, a `link` with a step, or a personal sign-in or browser pairing for a member other than your manager; 403 `member_not_allowed` when the member may not do the step (an office step needs an office owner); 422 `unknown_mcp_server`; 409 `not_oauth` for a server that does not sign in with OAuth; 409 `step_done` when the step is done.
