# Claude Code Slash Command Architecture

## 1. Hardcoded Commands (fixed logic, not overridable)

### Session & Context

- /clear — wipe conversation history
- /compact [focus] — compress context (optionally with focus)
- /context — visualize context window usage
- /fork — branch conversation into new session
- /resume — pick up a previous session
- /export [file] — export conversation to file/clipboard
- /plan — toggle plan mode (also Shift+Tab)

### Model & Performance

- /model [name] — switch model mid-session
- /fast [on|off] — toggle speed-optimized API settings

### Cost & Usage

- /cost — token usage + $ estimate (API users)
- /usage — plan-level limits + rate limit status
- /stats — usage patterns over time (subscription)

### Code & File Operations

- /diff — interactive diff of all Claude's changes
- /rewind — undo changes + revert conversation
- /copy — copy last response (picker for code blocks)
- /add-dir — add additional working directories

### Side Channel

- /btw [question] — ask without polluting main context

### Configuration & Management

- /config — open settings interface
- /hooks — manage lifecycle hooks
- /permissions — manage tool permissions
- /keybindings — edit key bindings
- /memory — view/edit persistent MEMORY.md
- /mcp — manage MCP server connections
- /ide — manage IDE integrations
- /agents — manage custom subagents
- /skills — list all available skills
- /plugin — manage plugin marketplace

### Background & System

- /bashes — list/manage background tasks
- /doctor — check installation health
- /bug — report bugs to Anthropic
- /install-github-app — set up Claude GitHub PR review app
- /help — list all available commands
- /exit — exit REPL

---

## 2. Bundled Skills (prompt-based, overridable, ship with Claude Code)

All bundled skills are pure prompt-based. Some instruct the model to call
specific tools (e.g. `/loop` tells the model to call CronCreate), but the
skill itself is just a prompt — no CLI runtime machinery is involved.

- /batch [desc] — decompose into 5-30 parallel worktree agents
- /claude-api — load API/SDK reference for detected language
- /claude-in-chrome — automate Chrome browser interactions
- /debug [desc] — diagnose session/tool issues from debug log
- /keybindings-help — customize keyboard shortcuts
- /loop [interval] [prompt] — recurring prompt on a schedule (via CronCreate tool)
- /lorem-ipsum — generate placeholder text
- /review [PR#|URL] — code review (bugs, logic, edge cases)
- /schedule — create cron-scheduled remote agents
- /security-review — security review
- /simplify [focus] — 3 parallel agents for code cleanup/reuse
- /skillify — capture processes as reusable skills
- /stuck — diagnose frozen/slow sessions
- /ultrareview — ultra PR review
- /update-config — configure settings.json

---

## 3. Skill Resolution (name collision -> highest priority wins)

1. Enterprise (org-provisioned, admin-pushed)
2. Personal: ~/.claude/skills/name/SKILL.md
3. Project: .claude/skills/name/SKILL.md
4. Bundled (the 15 above)

Legacy compat: .claude/commands/\*.md still works.
Conflict rule: skill wins over old-style command if same name.

---

## 4. Plugins (namespaced, isolated, no collisions possible)

- Invoked as /plugin-name:skill-name
- Installed via /plugin add github-user/repo
- Can bundle: skills, hooks, subagents, MCP servers
- Namespace prevents any conflict with the skill resolution chain

---

## 5. MCP Prompts (dynamic, from connected servers)

- Invoked as `/mcp__server__prompt` (e.g. `/mcp__github__list_prs`)
- Generated dynamically based on connected MCP servers via /mcp
- Separate namespace, no collision with skills or commands
