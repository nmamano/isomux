# Documentation Locations

An index of every place that describes Isomux features to users. When a new feature lands, check each of these to decide whether it needs an update. They drift apart easily — this doc exists so none get forgotten.

These documents are written in my voice, so I need to approve any copy changes before they are applied.

## 1. GitHub README

- **File:** `README.md`
- **Audience:** Developers landing on the GitHub repo.
- **Structure:**
  - `## Feature Highlights` — short bulleted list of the headline features.
  - `## Get Started` — install & first-run instructions.
  - `## Full Feature List` — the canonical, comprehensive inventory. Sub-sections mirror the site's chatbot prompt (Office View, Skeuomorphic Details, Agent Creation & Editing, Conversation View, Keyboard Shortcuts, Slash Commands, Inter-agent Communication, Persistence & Lifecycle, Mobile Support, Safety, Notifications, Other).
- **Update when:** any user-visible feature is added, removed, or meaningfully changed.

## 2. Landing page (isomux.com)

- **File:** `site/index.html`
- **Audience:** Visitors to isomux.com.
- **Structure:**
  - `<section id="features">` with `<ul class="feature-highlights">` (~line 648) — mirrors the README's Feature Highlights.
  - Links out to the README's Full Feature List rather than duplicating it.
  - Setup instructions and self-hosted/Tailscale guide further down.
- **Update when:** headline features change. Keep the list short — depth lives in the README.
- **Deploy note:** static site, served from this repo via Vercel (see `vercel.json`).

## 3. Site chatbot system prompt

- **File:** `api/chat.ts` — `SYSTEM_PROMPT` constant (around line 25).
- **Audience:** Indirect. Feeds the chatbot on isomux.com that answers visitor questions.
- **Structure:** voice/tone rules, "What is Isomux?", getting started, self-hosted guide, and a `## Full Feature List` section that mirrors the README.
- **Update when:** any feature changes. The prompt has an explicit "never make up features" guideline, so stale content here makes the bot lie by omission.
- **Deploy note:** Vercel Edge function, redeployed with the site.

## 4. `/help` slash command

- **File:** `server/command-handlers.ts` — the `help` handler (around line 136).
- **Audience:** Agents/users inside Isomux who type `/help` in a conversation.
- **Content:** agent info, usage tips, and a list of available commands/skills with short descriptions.
- **Related:** `server/commands.ts` holds the command registry with a `description` field on every bundled command — keep those in sync.
- **Update when:** a new slash command or skill is added, or existing command behavior changes.

## 5. Blog post (external repo)

- **File:** `~/nil/nilmamano.com/blog/isomux.mdx` (separate repo: `nilmamano.com`).
- **Audience:** Readers of nilmamano.com — architecture deep dive, not a feature list.
- **Structure:** Introduction, How the Claude Agent SDK Works, How Codex Differs, The Agent Lifecycle, The WebSocket Layer, The Frontend, QoL Features, Final Thoughts.
- **Images:** `~/nil/nilmamano.com/public/blog/isomux/`.
- **Update when:** architecture-level changes land (SDK upgrades, lifecycle changes, new backends, new subsystems). Small feature tweaks usually don't need a blog update; the QoL Features section is the most likely to go stale.
- **Deploy note:** lives in a separate Next.js repo — commit and push there, not here.

## 6. Personal site — homepage hero carousel

- **File:** `~/nil/nilmamano.com/app/components/featured-projects-carousel.tsx` (the `projects` const, Isomux entry).
- **Audience:** Visitors landing on nilmamano.com — one-line elevator pitch in a rotating carousel above the fold.
- **Structure:** `title` + `tagline` (~one sentence) + `cta`. Keep the tagline tight; this is hero copy.
- **Update when:** headline framing changes. The tagline should mirror the README's first highlight in spirit, not verbatim.

## 7. Personal site — projects section

- **File:** `~/nil/nilmamano.com/app/lib/research-projects.ts` (the `PROJECTS` array, Isomux entry).
- **Audience:** Visitors scrolling down the personal site homepage to the Projects section.
- **Structure:** `title` + `description` (2 short paragraphs). Slightly longer than the hero tagline; can mention one or two specific features.
- **Update when:** headline framing changes. Keep consistent with the hero carousel.

## 8. Personal site — homepage chatbot system prompt

- **File:** `~/nil/nilmamano.com/app/lib/chat-prompts.ts` (look for the Isomux bullet in the homepage prompt).
- **Audience:** Indirect — feeds the chatbot on nilmamano.com (different from the isomux.com chatbot, which is a separate file).
- **Update when:** the one-line description of Isomux needs to stay accurate (e.g., when the underlying tech stack or scope changes).

## 9. Resume

- **File:** `~/nil/nilmamano.com/_source_assets/resume_nilmamano.tex` (the Isomux bullets under `\section*{Projects}`).
- **Audience:** Recruiters / collaborators who download the resume PDF.
- **Compiled output:** `~/nil/nilmamano.com/public/resume/resume_nilmamano.pdf` — requires `pdflatex` / `latexmk` recompile after edits.
- **Update when:** architecture or scope changes meaningfully (e.g., new backend, new tech in the stack list).

## Secondary / internal references

These aren't user-facing docs, but they do describe features and can fall out of date:

- `AGENTS.md` — developer/agent-facing overview of the codebase (read by Claude Code, Codex, and other tools that follow the AGENTS.md convention). `CLAUDE.md` is a one-line pointer to it. Update when architecture or conventions change.
- `internal-docs/` — design documents for individual features. Historical/reference only; not expected to stay current.
- `server/commands.ts` — per-command `description` fields surface in the slash-command autocomplete UI.
- `server/agent-manager.ts` `buildSystemPrompt()` (around lines 194–225) — the system prompt injected into every spawned agent. Update when the agent's role or capabilities change.

## Quick checklist when adding a user-visible feature

1. `README.md` — Feature Highlights and/or Full Feature List.
2. `site/index.html` — only if it belongs on the headline list.
3. `api/chat.ts` `SYSTEM_PROMPT` — the feature-list section and any relevant guideline.
4. `server/command-handlers.ts` `help` handler and/or `server/commands.ts` — only if it adds a command or changes tips.
5. `nilmamano.com/blog/isomux.mdx` — only for architecture-level changes.
6. `nilmamano.com/app/components/featured-projects-carousel.tsx` and `nilmamano.com/app/lib/research-projects.ts` — only if the change rises to the elevator-pitch level.
7. `nilmamano.com/app/lib/chat-prompts.ts` — only if the one-line summary needs to change.
8. `nilmamano.com/_source_assets/resume_nilmamano.tex` — only for architecture/stack-level changes; remember to recompile the PDF.
