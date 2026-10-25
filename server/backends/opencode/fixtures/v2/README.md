# OpenCode 2.1.4 event frames

Each file holds the `/api/event` frames of one or more sessions, one JSON
frame per line, as `@opencode/cli` 2.1.4 sent them to a deterministic mock
model on 2026-10-25. Folder paths are rewritten to `/work/<repo>` and the
mock's address to `http://127.0.0.1:4096`.

- The files without a prefix come from the gate recordings in
  `internal-docs/opencode-gate/evidence/2.1.4/ev-fx-*.jsonl` (task 4840abc5).
- The `probe-` files come from the probes of task e47be82a: a reject with a
  message, an edit permission, a subagent's permission and its reject, 429
  retries, a 400, an unknown model, an interrupt during a tool, the question
  tool's form, four turns with an instruction change, and a sequence
  collision.
