# Documentation Locations

An index of every place that describes Isomux features to users. When a new feature lands, check each of these to decide whether it needs an update. They drift apart easily - this doc exists so none get forgotten.

These documents are written in my voice, so I need to approve any copy changes before they are applied.

## Terminology

- **meta-harness** is Isomux's category noun (what it is). Use it wherever a surface answers "what is Isomux?"
- **office** is the product metaphor (the UI and experience). Keep it for the visual metaphor and the tagline.
- **orchestration / orchestrator** stays for implementation internals (the session-management layer, provider dispatch) and general-domain discussion, not as Isomux's category label.

Keep these consistent across all surfaces below.

## 1. GitHub README

- **File:** `README.md`
- **Audience:** Developers landing on the GitHub repo.
- **Structure:**
  - Headline tagline (the bold line under the H1): Isomux's one-line category pitch. **Must stay in lockstep with the landing's `<title>`, social meta tags, and hero (section 2), and the org profile tagline (section 11).**
  - `## Feature Highlights` - two subsections, `### Coworkers...` and `### An office made for humans and agents`. **Must stay in lockstep with the landing page's `<ul class="coworker-list">` and `<ul class="office-list">` (see section 2)** - same bullets, same order, same wording. Any edit here needs a matching edit there, and vice versa. Ends with a one-liner linking to `docs/features.md`.
  - `## Get Started` - install & first-run instructions (basic local only). Ends with links to `docs/self-hosted.md`, `docs/vps-install.md`, and the hosted page (section 2b).
  - `## How it works` - one-line link to `docs/how-it-works.md`. Technical overview content lives in the docs.
- **Update when:** any user-visible feature is added, removed, or meaningfully changed.

## 2. Landing page (isomux.com)

- **File:** `site/index.html`
- **Audience:** Visitors to isomux.com.
- **Structure:**
  - `<title>`, social meta tags (og/twitter title + description), and the hero `<p class="tagline">`: Isomux's category pitch. **Must stay in lockstep with the README headline (section 1)** and the org profile tagline (section 11). The `<title>` and social titles use the short form; the description and hero use the full line.
  - `<section id="features">` with `<ul class="coworker-list">`, and `<section id="office">` with `<ul class="office-list">` - **must stay in lockstep with the README's `## Feature Highlights` (section 1)**: same bullets, same order, same wording (modulo HTML markup, inline links, and code-style spans). Any edit here needs a matching edit there, and vice versa. Followed by a one-liner linking to `/docs/features`.
  - `<section id="setup">` - basic local Get Started (always open, no foldables). Ends with links to `/docs/self-hosted` and `/docs/vps-install` for always-on-server setups, and to `/hosted` for the managed version.
  - `<section id="how-it-works">` - one-line link to `/docs/how-it-works`. The actual technical overview lives in the docs.
- **Update when:** headline features change. Always update both this file and the README in the same commit so they don't drift.
- **Deploy note:** static site, served from this repo via Vercel (see `vercel.json`).

## 2b. Hosted landing page (isomux.com/hosted)

- **File:** `site/hosted.html`
- **Audience:** People who want isomux without running a server. Marketing page for the managed product designed in `internal-docs/hosted-isomux-design.md` and `internal-docs/control-plane-design.md`.
- **Structure:** hero (the Discord button carries the not-live status), how it works, what you get, plans, and a Questions list whose last entry, "How private is my server?", is a folded `<details>` holding the access-boundary copy. Self-contained HTML with the landing's palette and theme handling copied in; linked from the landing's setup section and footer.
- **Update when:** the hosted product's promises change - pricing, the access guarantee, cancellation terms, or launch status. Every claim on it traces to a ruling in the two design docs; keep it that way rather than writing new policy in the copy.
- **Related:** `api/chat.ts` carries a short "Hosted Isomux" section so the site chatbot doesn't invent details or imply it has launched.
- **Deploy note:** static, served by Vercel with `cleanUrls`, so the file is served at `/hosted`. Moves to `cloud.isomux.com` if and when the control plane ships.

## 3. Site chatbot system prompt

- **File:** `api/chat.ts` - `SYSTEM_PROMPT` constant (around line 25).
- **Audience:** Indirect. Feeds the chatbot on isomux.com that answers visitor questions.
- **Structure:** voice/tone rules, "What is Isomux?", getting started, self-hosted guide, and a `## Full Feature List` section that mirrors the canonical inventory in `docs/features.md`. References to setup/access detail point readers at `isomux.com/docs/<slug>`.
- **Update when:** any feature changes. The prompt has an explicit "never make up features" guideline, so stale content here makes the bot lie by omission.
- **Deploy note:** Vercel Edge function, redeployed with the site.

## 4. Docs site (isomux.com/docs)

- **Sources:** `docs/*.md` (one markdown file per page). Each is rendered to a self-contained HTML page by `scripts/build-docs.ts` at Vercel build time. Output is directory-style (`site/docs/<slug>/index.html`) so any static server resolves clean URLs without needing `cleanUrls`. `site/docs/` is gitignored - only the markdown sources are tracked.
- **Audience:** Anyone who needs more than the README/landing highlights - operators, security reviewers, would-be contributors.
- **Pages (in sidebar/nav order):**
  - `features.md` - canonical long-form feature inventory. Built as the docs **landing page** at `/docs` (not `/docs/features`). Also contains the Backup and Restore section (no separate page).
  - `self-hosted.md` - three-part always-on-server walkthrough: keep it running (systemd), make it reachable (VPN vs public URL), authorize users (links to access-and-invites).
  - `vps-install.md` - one-command unattended VPS setup (`deploy/install.sh`): fresh Ubuntu 24.04 → HTTPS-served office + owner invite link. Keep the parameter table in sync with the script's env vars.
  - `access-and-invites.md` - canonical reachability/auth deep dive: invite-link flow, Tailscale Funnel agent prompt, Caddy, `ISOMUX_PUBLIC_ORIGIN`, cookie semantics. The Funnel prompt lives here, nowhere else.
  - `how-it-works.md` - short multi-provider technical overview (Bun process, Claude SDK + Codex app-server, WebSocket sync, persistence).
  - `security-audit.md` - authorization-system threat model and findings.
- **Frontmatter:** `title`, `description`, `navTitle` (override the sidebar label when the H1 is too long), and `order` (override nav position).
- **Sidebar nav:** every doc page renders a sidebar listing all pages, with the current one highlighted (sticky on desktop, stacked above content on mobile).
- **Build:** `bun run build:docs`. The renderer rewrites local `.md` links to clean `/docs/<slug>` URLs (links to `features.md` → `/docs`) and auto-generates an "On this page" TOC from H2/H3 headings. Trusted-source-only - no HTML sanitization (see the comment at the top of the script if outside contributions to `docs/` are ever accepted).
- **Update when:** any feature is added, removed, or changed that's covered by a page above. `features.md` is the canonical inventory and must be updated alongside any user-visible change.
- **Deploy note:** built and served by Vercel via `vercel.json`'s `buildCommand` (which calls `bun run build:docs`) and `cleanUrls: true`.

## 5. `/help` slash command

- **File:** `server/command-handlers.ts` - the `help` handler (around line 298).
- **Audience:** Agents/users inside Isomux who type `/help` in a conversation.
- **Content:** a docs link, usage tips, and a list of available commands/skills with short descriptions.
- **Related:** `server/commands.ts` holds the command registry with a `description` field on every bundled command - keep those in sync.
- **Update when:** a new slash command or skill is added, or existing command behavior changes.

## 6. Blog post (external repo)

- **File:** `~/nil/nilmamano.com/blog/isomux.mdx` (separate repo: `nilmamano.com`).
- **Audience:** Readers of nilmamano.com - architecture deep dive, not a feature list.
- **Structure:** Introduction, How the Claude Agent SDK Works, How Codex Differs, The Agent Lifecycle, The WebSocket Layer, The Frontend, QoL Features, Final Thoughts.
- **Images:** `~/nil/nilmamano.com/public/blog/isomux/`.
- **Update when:** architecture-level changes land (SDK upgrades, lifecycle changes, new backends, new subsystems). Small feature tweaks usually don't need a blog update; the QoL Features section is the most likely to go stale.
- **Deploy note:** lives in a separate Next.js repo - commit and push there, not here.

## 7. Personal site - homepage highlight (short blurb)

- **File:** `~/nil/nilmamano.com/app/lib/highlights.ts` (the `HIGHLIGHTS` array, `agentic-tooling` entry's `blurb`).
- **Audience:** Visitors landing on nilmamano.com - one-line pitch in the homepage highlights.
- **Structure:** `statement` + `blurb` (one to two sentences) + `links`. Keep the blurb tight.
- **Update when:** headline framing changes. Keep in lockstep with the body prose in `highlight-bodies.tsx` (section 8).

## 8. Personal site - homepage highlight (body prose)

- **File:** `~/nil/nilmamano.com/app/lib/highlight-bodies.tsx` (the `HIGHLIGHT_BODIES` map, `agentic-tooling` entry).
- **Audience:** Visitors on the nilmamano.com homepage - the expanded highlight prose with inline links, shared by the desktop orbit center and the mobile list.
- **Structure:** short prose with woven links. Mirror the `highlights.ts` blurb (section 7) in spirit.
- **Update when:** headline framing changes. Keep consistent with section 7.

## 9. Personal site - homepage chatbot system prompt

- **File:** `~/nil/nilmamano.com/app/lib/chat-prompts.ts` (look for the Isomux bullet in the homepage prompt).
- **Audience:** Indirect - feeds the chatbot on nilmamano.com (different from the isomux.com chatbot, which is a separate file).
- **Update when:** the one-line description of Isomux needs to stay accurate (e.g., when the underlying tech stack or scope changes).

## 10. Resume

- **File:** `~/nil/nilmamano.com/_source_assets/resume_nilmamano.tex` (the Isomux bullets under `\section*{Projects}`).
- **Audience:** Recruiters / collaborators who download the resume PDF at `nilmamano.com/resume/resume_nilmamano.pdf`.
- **Compiled output:** `~/nil/nilmamano.com/public/resume/resume_nilmamano.pdf`. Deployed as a static asset by Vercel, so the PDF in `public/resume/` is what visitors download. Edits to the .tex don't ship until the PDF is recompiled and committed alongside.
- **How to recompile (on auntie):** `pdflatex` is installed via `texlive-latex-recommended`, `texlive-latex-extra`, and `texlive-fonts-recommended`. Run two passes (the second is needed so hyperref settles the bookmark outlines):
  ```
  cd ~/nil/nilmamano.com
  pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/tmp/resume-build _source_assets/resume_nilmamano.tex
  pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/tmp/resume-build _source_assets/resume_nilmamano.tex
  cp /tmp/resume-build/resume_nilmamano.pdf public/resume/resume_nilmamano.pdf
  ```
  Aux/log files stay in `/tmp/resume-build` so they don't clutter the repo. Verify with `pdftotext public/resume/resume_nilmamano.pdf - | grep <new copy>` before committing.
- **Update when:** architecture or scope changes meaningfully (e.g., new backend, new tech in the stack list).

## 11. GitHub org profile

- **File:** `profile/README.md` in a separate repo, `github.com/isomux/.github`. Renders on `github.com/isomux` as the org's public landing.
- **Audience:** Developers landing on the org page.
- **Structure:** tagline, three links (isomux.com, source repo, Discord), and the office screenshot hot-linked from the main repo's `site/office.gif`.
- **Update when:** the headline tagline changes (keep aligned with the README's first line) or the showcase screenshot is replaced. Rare.
- **Deploy note:** lives in a separate repo; push directly, no CI. If the main repo is ever transferred from `nmamano/isomux` to `isomux/isomux`, update the source-code link here too.

## Secondary / internal references

These aren't user-facing docs, but they do describe features and can fall out of date:

- `AGENTS.md` - developer/agent-facing overview of the codebase (read by Claude Code, Codex, and other tools that follow the AGENTS.md convention). `CLAUDE.md` is a one-line pointer to it. Update when architecture or conventions change.
- `internal-docs/` - design documents for individual features. Historical/reference only; not expected to stay current, with two maintained exceptions (below). (Operator-facing docs live in `docs/`; see section 4.)
- `internal-docs/backup-restore.md` - the **maintained** break-glass runbook for the daily `~/.isomux` backup: what the tarballs hold, and the stop-service / move-aside / extract / restart restore procedure. Linked from `server/backup.ts`. It stays in `internal-docs/` rather than the docs site because it is an emergency procedure for whoever runs the box, not a feature page; the one-paragraph user-facing summary lives in `docs/features.md`. Keep it current when the backup schedule, archive layout, or state-root resolution changes.
- `internal-docs/testing-guide.md` - the **maintained** living reference for the test suite: the tiers (T0-T3), how to run (`bun test` vs `bun run test:live`), the seam-to-test-file map, and conventions. Unlike the rest of `internal-docs/`, keep this current as the test suite evolves. (Its companion `internal-docs/generic-runtime-refactor.md` stays the historical design/decision record.)
- `server/commands.ts` - per-command `description` fields surface in the slash-command autocomplete UI.
- `server/system-prompt.ts` `buildSystemPrompt()` - the system prompt injected into every spawned agent (called from `server/agent-manager.ts`). Update when the agent's role or capabilities change.

## Quick checklist when adding a user-visible feature

1. `README.md` `## Feature Highlights` - only if the feature is headline-level.
2. `site/index.html` `<ul class="coworker-list">` / `<ul class="office-list">` - keep in lockstep with the README.
3. `docs/features.md` - canonical inventory. Add/edit here whenever any user-visible feature changes.
4. `docs/<other>.md` - touch the relevant page if the feature affects setup, access, backup, etc.
5. `api/chat.ts` `SYSTEM_PROMPT` - the feature-list section and any relevant guideline.
6. `server/command-handlers.ts` `help` handler and/or `server/commands.ts` - only if it adds a command or changes tips.
7. `nilmamano.com/blog/isomux.mdx` - only for architecture-level changes.
8. `nilmamano.com/app/lib/highlights.ts` and `nilmamano.com/app/lib/highlight-bodies.tsx` - only if the change rises to the elevator-pitch level.
9. `nilmamano.com/app/lib/chat-prompts.ts` - only if the one-line summary needs to change.
10. `nilmamano.com/_source_assets/resume_nilmamano.tex` - only for architecture/stack-level changes. Recompile the PDF (see section 10 for the command) and commit `public/resume/resume_nilmamano.pdf` alongside the .tex in the same change.
11. `github.com/isomux/.github` `profile/README.md` - only if the headline tagline or showcase screenshot changes.
