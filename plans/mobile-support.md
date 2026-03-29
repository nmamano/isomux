# Plan: Mobile Support

> Source PRD: Interview with user (2026-03-28). Phone on same Tailscale network opens isomux in mobile browser.

## Architectural decisions

Durable decisions that apply across all phases:

- **Detection**: JS-based `isMobile` boolean in `AppState`, derived from `window.innerWidth < 768` on load and resize. Not CSS-only — we need to swap entire component trees.
- **Top-level routing**: On mobile, `OfficeView` is replaced by `AgentListView`. `LogView` is shared between desktop and mobile with conditional adaptations gated on `isMobile`.
- **Terminal**: `TerminalPanel` is desktop-only. Never rendered on mobile.
- **Server**: No changes. `Bun.serve` already binds `0.0.0.0`, WebSocket uses `location.host`. Works over Tailscale as-is.
- **Sound**: No changes. Autoplay policy handled naturally by user interaction.
- **Dialogs**: Same components (SpawnDialog, EditAgentDialog), made full-width on mobile via `max-width: 100%; width: calc(100% - 32px)`.

---

## Phase 1: Mobile detection + Agent List View

**User stories**: Phone user can see all agents and their states, tap one to focus it, spawn a new agent, and access context actions (edit, kill, new conversation) via overflow menu.

### What to build

Add `isMobile` to `AppState`, updated on load and window resize with a 768px breakpoint. At the top level, render `AgentListView` instead of `OfficeView` when mobile.

`AgentListView` is a full-screen scrollable list. Each row shows: status dot (same colors as desktop), agent name, topic (if set), and a "..." overflow button. Tapping the row focuses the agent (opens LogView). Tapping "..." opens the existing `ContextMenu` positioned near the button. A "+" floating button or top-bar button opens `SpawnDialog`.

The list should use the existing dark/light theme variables. No new data models or server messages — everything needed is already in `AppState.agents`.

### Acceptance criteria

- [ ] `isMobile` flag in store, reactive to window resize
- [ ] `AgentListView` renders on viewports < 768px instead of `OfficeView`
- [ ] Each agent row shows status dot, name, topic
- [ ] Tapping a row focuses the agent (navigates to LogView)
- [ ] "..." button opens context menu with edit, kill, new conversation actions
- [ ] "+" button opens SpawnDialog
- [ ] SpawnDialog and EditAgentDialog render full-width on mobile

---

## Phase 2: Mobile LogView (read-only)

**User stories**: Phone user can read an agent's full conversation log comfortably — proper text sizes, compact header, and smooth scrolling.

### What to build

Adapt the LogView header to a two-row layout on mobile:
- Row 1: Back arrow, agent name + status dot, action button area
- Row 2: Working directory (truncated with ellipsis), copy button
- Drop desk number on mobile (meaningless without isometric view)

Bump font sizes on mobile by ~2px across LogView and LogEntryCard (11px -> 13px, 12px -> 14px, 13px -> 15px; minimum 12px for metadata/labels). The TerminalPanel toggle and panel are hidden on mobile.

Auto-scroll behavior stays the same. Message list fills available space as a flex column.

### Acceptance criteria

- [ ] Two-row header on mobile with all essential info accessible
- [ ] Desk number hidden on mobile
- [ ] Font sizes bumped for readability (no text below 12px on mobile)
- [ ] TerminalPanel toggle and panel hidden on mobile
- [ ] Log entries render without horizontal overflow on ~375px screen
- [ ] Back button returns to AgentListView

---

## Phase 3: Mobile LogView input

**User stories**: Phone user can send messages to an agent, abort a running agent, and use slash commands — all with touch-friendly controls.

### What to build

Add a send button next to the textarea. On mobile, Enter inserts a newline (natural mobile keyboard behavior); tapping the send button submits. When the agent is in a working/thinking state, the send button is replaced by an abort button.

Slash command autocomplete should remain functional — it appears above the textarea and the keyboard push should keep it visible.

The textarea should be comfortable to type in on mobile — full width, reasonable minimum height, and the auto-resize behavior should still work.

### Acceptance criteria

- [ ] Send button visible next to textarea on mobile
- [ ] Tapping send submits the message
- [ ] Abort button replaces send button when agent is working
- [ ] Slash command autocomplete works on mobile
- [ ] Textarea is full-width and comfortable to type in

---

## Phase 4: Viewport & device polish

**User stories**: The mobile experience feels native — no content hidden behind notches or home bars, keyboard doesn't break layout, dialogs feel right.

### What to build

Set the overall layout container to `height: 100dvh` so the on-screen keyboard correctly shrinks the viewport rather than pushing content offscreen. The flex column layout (header / messages / input) will adapt naturally.

Add `viewport-fit=cover` to the HTML meta tag. Apply `env(safe-area-inset-*)` padding to: LogView header (top), input area (bottom), AgentListView (top and bottom). This is a no-op on devices without notches.

Test and fix any remaining edge cases: horizontal overflow on long code blocks, dialog positioning with keyboard open, context menu positioning near screen edges.

### Acceptance criteria

- [ ] `viewport-fit=cover` in meta tag
- [ ] `100dvh` used for main layout height on mobile
- [ ] Safe area insets applied to header, input, and list view edges
- [ ] On-screen keyboard does not obscure the input area
- [ ] Code blocks in log entries handle horizontal overflow (horizontal scroll or wrap)
- [ ] Dialogs remain usable when keyboard is open
