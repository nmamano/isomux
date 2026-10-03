# Chat affordances

All routes target the current agent.

- `POST /api/agents/:id/read-file` with `{path}` adds an inline image or file chip. Paths can be relative, absolute, or start with `~/`.
- `POST /api/agents/:id/diff` with `{dir?}` shows uncommitted changes, or `{commit}` shows a commit or range.
- `POST /api/agents/:id/edit-file` with `{path}` adds an editor card.
- `POST /api/agents/:id/terminal-command` with `{command}` adds a single-line command for the server terminal. It does not run it. Do not use it for a command that must run on the member's device.
- `POST /api/agents/:id/preview-url` with `{url, viewport?, wait?}` opens an HTTP(S) URL twice in server Chrome and adds a screenshot. Avoid GET URLs with side effects. Decline suspicious public pages because they run on the server. `viewport` is `{width,height}`, integers 320-2560, default 1280x800; `wait` is 0-10000 ms of render budget that fast-forwards page timers. A reachable page always yields a screenshot, even an error page. Errors include `unreachable`, `capture_busy` (retry in a few seconds), and `no_browser`.

Safe example: `POST /api/agents/:id/read-file` with `{"path":"plot.png"}`.

## Route contract

`POST /api/agents/:id/read-file`, `POST /api/agents/:id/diff`, `POST /api/agents/:id/edit-file`, `POST /api/agents/:id/terminal-command`, and `POST /api/agents/:id/preview-url` accept the bodies described above and return `{"ok":true}` after adding the card. Every agent, including a privileged agent, can target only itself. Invalid bodies return 400/422, a forbidden path or different target returns 403, a missing file returns 404, and preview failures return a structured 400/409/502 error with `code`.
