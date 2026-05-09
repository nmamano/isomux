# iPhone App Design

> This was the output of an autonomous `/grill-me` experiment.

End-to-end design for a native iOS client for isomux. Captures the decisions reached in the design interview between Isomuxer4 and Isomuxer5 (acting on Nil's behalf).

> Status: design complete pending answers to the [open questions](#open-questions) at the end of this doc. No code written yet.

---

## Goals and non-goals

**Goal.** A native iPhone client that lets the boss talk to isomux agents from the phone with the responsiveness of a native app and the reliability of real push notifications. Personal-use first, sideloaded or via TestFlight; not an App Store product.

**v1 scope: chat-first.** Agent list, message thread, send (text + voice + image), receive APNs push, switch rooms/agents, view+create tasks, settings.

**Out of v1.** Terminal, file editor, cronjobs UI, agent spawn/configure/move-desk, real iPad split-pane, character avatars, full markdown (tables, task lists, syntax highlighting), per-agent custom notification sounds, internationalization. See [v2 deferred](#v2-deferred).

**Audience.** Personal / small-group, distributed via TestFlight Internal (≤100 testers, no Apple review). Going to App Store is a different project: multi-tenant, real auth, review compliance.

---

## Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Approach | Native SwiftUI | APNs push, background audio, `Speech` framework, share sheet, Siri shortcuts — all unreachable through a webview. Web UI is already a fine PWA for the in-tab use case. |
| iOS deployment target | iOS 17+ | `@Observable` macro, `Observation` framework, no Combine boilerplate. ~95%+ device adoption. |
| State management | Plain `@Observable` singleton stores | TCA is overkill for a focused chat app; boring SwiftUI is faster. |
| WebSocket | `URLSessionWebSocketTask` | Built-in. Starscream/etc. only needed for older iOS. |
| Persistence | GRDB (SQLite) | Mature, fast, predictable. SwiftData has rough edges in v1. |
| Secrets | Keychain (`kSecAttrSynchronizable = false`) | Server URL, username, device label, APN token. |
| Settings (non-secret) | UserDefaults | Feature toggles only. |
| Dependency manager | Swift Package Manager only | No CocoaPods. Cleaner dep story. |
| Connectivity | Tailscale-only | Phone joins the tailnet, hits `auntie:4000`. No internet exposure, no auth layer, no relay. |
| Distribution | TestFlight Internal | Up to 100 testers, no review. App Store deferred. |
| Repo structure | Monorepo, `ios/` directory | Shared protocol types via codegen, single PR can change both sides. |

---

## Server-side surface area

All the new work the iOS app pushes onto the existing Bun server.

### New HTTP endpoints

- `GET /api/users` — projects `~/.isomux/users.json` to `[{username, displayName}]`. Does **not** expose `notifRooms`, `envFile`, or any other prefs the app shouldn't see.
- `GET /api/logs/:agentId?since_id=&limit=` — paginated log fetch for the `full_resync` fallback path and chat scrollback.

### New WebSocket `ClientCommand` variants

| Command | Payload | Notes |
|---|---|---|
| `register_device_token` | `{token, deviceLabel, platform: "ios", environment: "sandbox" \| "production"}` | Sent on session-init. `environment` is required because TestFlight uses production APNs but Xcode debug builds use sandbox; server routes accordingly. |
| `unregister_device_token` | `{token}` | Sent on user-switch and logout. |
| `subscribe` | `{messageKinds, lastSeenLogIdByAgent, deviceLabel, protocolVersion}` | Sent on session-init. `messageKinds` opt-out filter (phone v1 skips `terminal_output`, `editor_content`, `file_watcher`). `deviceLabel` flows here so it's set even if push permission is denied. `lastSeenLogIdByAgent` drives gap replay. `protocolVersion` enables forward-compat. |
| `subscribe_update` | Same as `subscribe` | Mid-session subscription change. v2 (terminal on iPad, transient editor preview) needs this; cheap to design in now. |
| `mark_read` | `{agentId, lastSeenLogId}` | Fired on chat open AND on every new entry while chat is foregrounded. Server updates per-(username, agentId) `lastViewedAt`. |
| `set_agent_pref` | `{agentId, key, value}` | Server-side per-(username, agentId) prefs. v1 uses keys `auto_tts: bool`, `muted: bool`. |

### New WebSocket `ServerMessage` variants

| Message | Payload | Notes |
|---|---|---|
| `subscribe_ack` | `{serverProtocolVersion}` | Echoes server's protocol version so client can show "update available" banner if mismatched. |
| `replay_complete` | `{agentId}` | Sent after gap replay finishes for an agent; client switches from "catching up" pill to live state. |
| `full_resync_required` | `{agentId}` | Sent when `lastSeenLogId` gap exceeds 500 entries; client falls back to paged HTTP. |

### New server modules

```
server/push/
├── apns.ts       # HTTP/2 client to api.push.apple.com (and api.sandbox.push.apple.com)
├── jwt.ts        # ES256 signer for APNs auth, ~50min token cache
├── tokens.ts     # ~/.isomux/device-tokens.json read/write
└── events.ts     # local EventEmitter agent-manager.ts emits on
```

### Modified existing modules

- `agent-manager.ts` — emit `agent:idle_with_unread`, `agent:queued_delivered`, `agent:error` events on the local EventEmitter. Reuse the existing web "unread" badge heuristic (don't reinvent).
- `command-handlers.ts` — handle the new WS commands above. First check the existing session-identity binding pattern (whether username is per-message or per-connection) before deciding where to attach things.
- `index.ts` — wire `/api/users` and `/api/logs/:agentId` routes.
- `shared/types.ts` — add the new variants. Drives codegen.

### New config

- `~/.isomux/apns/config.json` (gitignored): `{p8KeyPath, keyId, teamId, bundleId}`. Boss generates `.p8` once in Apple Developer portal.
- `~/.isomux/device-tokens.json`: keyed by `username`, value is `[{token, deviceLabel, platform, environment, addedAt}]`.

### Push trigger semantics

- **Unread definition.** An agent has unread state when its most recent assistant `text` or `error` log entry is newer than the user's `lastViewedAt` for that agent.
- **Trigger fires** on `state → idle` AND `unread = true` AND `muted = false`.
- **Clears** when `mark_read` arrives (any client — phone open or web view both clear).
- **Per-agent debounce: 5s.** State flicker shouldn't double-fire. Per-user coalescing (batching multiple agents → one banner) is a v2 ask.
- **Banner.** Title: `<AgentName> · <RoomName>`. Body: latest text trimmed to ~120 chars. Custom payload: `{kind, agentId, lastLogId, room, userId}`. `userId` lets the client silently drop pushes for users who've since switched/signed out.
- **Multi-device fan-out.** Server sends to all tokens for a username — phone + iPad both registered → both get the push.
- **Critical Alerts.** Apple's Critical Alerts entitlement requires case-by-case approval; "dev agents in error state" probably won't qualify. Default plan: ship with `interruption-level: time-sensitive` for `agent:error` (no entitlement needed; Focus modes can opt in). Apply for Critical Alerts only if Nil wants to.
- **APNs response handling.** `200`: ok. `410 Unregistered`: drop token from `device-tokens.json` silently. `429 TooManyRequests`: backoff + retry. Other 4xx: log at `error` level so misconfig surfaces.

### Forward-compat constraint

Anything client-safety-critical (e.g., "your session is killed, stop sending") must be communicated through **existing** message variants, never via a new variant. Old clients silently miss new variants by design.

---

## iOS app: project structure

### Directory layout

```
ios/
├── Isomux.xcodeproj/
├── Isomux/
│   ├── App/             # @main entry, RootView, NavigationCoordinator
│   ├── Features/
│   │   ├── Onboarding/
│   │   ├── Agents/      # agent list, room sections, Active Now carousel
│   │   ├── Chat/        # ChatView + LogEntryCard ports
│   │   ├── Tasks/
│   │   └── Settings/
│   ├── Network/         # WSClient, HTTPClient, push registration
│   ├── Storage/         # GRDB schema, repositories, Keychain wrapper
│   ├── Speech/          # SFSpeechRecognizer, AVSpeechSynthesizer
│   ├── Generated/       # codegen output, .gitignored
│   └── Resources/       # Assets.xcassets, Info.plist
├── IsomuxTests/
└── README.md
```

### Codegen

- Tool: **Quicktype** CLI, invoked via `bun run codegen:ios` in `package.json`.
- Input: `shared/types.ts`. Output: `ios/Isomux/Generated/Protocol.swift`.
- Wired as Xcode "Pre-Build Script" build phase.
- Generated files **gitignored**; source of truth is `shared/types.ts`.
- Standalone `bun run codegen:ios` script for non-Xcode workflows.
- CI fresh-clone check: regenerate, build, fail if anything mismatches.
- **Risk:** Quicktype's Swift output for tagged unions (the `kind`-discriminated `ServerMessage` / `ClientCommand`) can be quirky. Plan a 1-day buffer for either a small post-processor or hand-rolling those specific types. Add codegen round-trip parity tests (encode → decode → re-encode, assert equivalence) for every variant of every WS message type.

### Bundle identity

- Bundle ID: **TBD** (see [open questions](#open-questions)).
- App name: `Isomux`.
- Custom URL scheme: `isomux://` (push deep links use `isomux://agent/<id>`).

---

## Connectivity & security

### Trust model

The phone trusts whatever it talks to on the configured server URL. Tailscale provides the network-layer security. No app-layer auth (no API keys, no OAuth). Settings screen has a caption: "Only point this at servers you trust" — arbitrary servers could craft log entries that exploit rendering bugs.

### App Transport Security

Default ATS blocks plain HTTP, but we accept `http://auntie:4000`. Info.plist needs an exception:
- TestFlight personal-use: `NSAllowsArbitraryLoads = true` is fine.
- App Store (deferred): narrow to `NSAllowsLocalNetworking` if Tailscale qualifies, otherwise per-host scoped exceptions.

### Privacy posture

- **App Store privacy labels** (TestFlight requires them too):
  - `User Content` (messages, images) — NOT linked to identity, NOT used for tracking.
  - `Diagnostics → Crash Data` — collected by TestFlight natively.
  - No third-party SDKs that change this.
- **GRDB sensitivity.** Log cache contains agent thinking and tool calls, which can include API keys, file paths, code with secrets. Mitigations: standard iOS file-system encryption, `URL.isExcludedFromBackup = true` on the DB file, wipe on user-switch/logout, no remote shipping of message content. v2: SQLCipher with a Keychain-stored key if threat model demands it.
- **`os_log`** for diagnostics. No third-party crash service. TestFlight collects crash reports natively.
- **LogEntryCard renderer is a code-review trust boundary.** No HTML eval, no `WebView`, no remote image fetches inline, no eval'd code. Only `AttributedString(markdown:)` (sandboxed) and the structured kind-specific renderers.

### Permission prompts (all lazy)

| Permission | Triggered by |
|---|---|
| Notifications | Onboarding step 4 |
| Microphone | First push-to-talk |
| Camera | First camera button tap |
| Photo Library | Not needed (PhotosPicker bypasses) |

---

## UI

### Navigation

- **Tab bar:** Agents (`person.2.fill`) / Tasks (`checklist`) / Settings (`gearshape.fill`).
- **`NavigationStack`** for drill-down within each tab.
- Bind the stack's path to a single source of truth so push payloads can drive navigation programmatically.
- **No room tab.** Rooms are collapsible section headers under the Agents tab — with 4–6 rooms there's nothing to navigate.

### Agents tab

- **"Active Now"** horizontal carousel at the top (~80pt height). Currently-working agents only, ordered most-recently-active-first, name tie-break. Hidden entirely when empty.
- Below: room-grouped agent list with collapsible room headers. Each row: name, topic, state pill (idle/working/error), unread dot, queued-message indicator.
- Tap row → push `ChatView`.

### ChatView

- Faithful port of the web `LogEntryCard` semantics. **Do NOT flatten to chat bubbles.** The kind-specific cards (text / thinking collapsed / tool_call expandable / tool_result / diff / edit-request / error / user_message) are isomux's actual product surface; bubbles erase the texture of agent reasoning.
- **Status pill** in nav bar: idle / working / interrupted / error.
- **Compose bar:** text field + push-to-talk mic + camera/library + send.
- **Overflow menu (v1):** Interrupt, Kill, Edit/fork past message, Toggle auto-TTS. Restart-agent (kill + relaunch with same config) is a v1 candidate if the existing infrastructure makes it trivial; defer if it requires new server work.
- **Configuration ops** (rename, change cwd, edit instructions, change outfit, move desk/room, spawn new agent) are **v2** — keyboard-heavy and rare, best done from a laptop.

### Chat rendering details

- **Inline formatting**: `AttributedString(markdown:)` for bold/italic/links/inline code. **No markdown image rendering** (security boundary; images flow only as separate attachment entries).
- **Code blocks** (` ``` `): monospace + dim background fill + horizontal scroll. **No syntax highlighting in v1.**
- **Diff entries**: red/green line backgrounds, monospace, `+`/`-` prefix. Match the web LogEntryCard renderer.
- **Tool calls**: collapsed by default (name + truncated args summary); tap to expand (full args + result, JSON-pretty-printed).
- **Thinking entries**: collapsed by default; tap chevron to reveal as italic gray text.
- **Virtualization**: `LazyVStack` inside `ScrollView`.
- **Scrollback**: pull-up at top loads 50 older entries via `GET /api/logs/:agentId?since_id=&limit=50`. Cache hits return instant; misses fetch.
- **Auto-scroll**: on new entry while user is at bottom → smooth-scroll. While scrolled up → "↓ N new" pill, tap to jump.
- **Anchor preservation** on prepend (older entries) or expand/collapse: `ScrollViewReader` capturing topmost-visible-entry-ID before mutation, restoring after layout settles. Plan ~1 day of tuning for this to feel right.
- **GFM caveat**: `AttributedString(markdown:)` doesn't handle tables or task lists. Verify whether agent log entries actually use these before assuming the built-in is enough; if yes, a richer renderer is needed.

### Tasks tab

- Card list grouped by status: Open expanded, In Progress expanded, Done collapsed, Backlog hidden by default.
- Each card: title, priority pill, assignee chip, task ID monospace.
- Filter chips at top (single-select per chip): status, priority, assignee.
- Tap card → detail view with full description, edit buttons.
- FAB `+` → modal: title (required), description (optional multiline), priority picker (default P2), assignee picker (default = current user). New tasks default to **`open`** status, never `backlog`.
- Swipe actions: claim (current user), mark done. Mark-done shows undo banner.
- Always pair task ID with title + one-line gist when surfaced anywhere (push payloads, swipe confirmations).
- **v2:** search, sort, archive, bulk actions.

### Settings screen

```
Profile
  - Username (read-only) → "Switch user…"
  - Device label (editable)
  - Logout (red, less prominent)

Server
  - Server URL (editable + "Test connection")
  - Connection status indicator
  - Protocol version + server version (footer-style)

Notifications
  - "Push notifications" master toggle (mirrors iOS permission)
  - "Notify on agent error" toggle (default on)
  - Muted agents (collapsed list, unmute buttons)

Voice
  - "Speak replies aloud (default)" master toggle
  - Per-agent auto-TTS list (collapsed; only non-default by default; expandable to "All agents")
  - TTS voice picker (default = system Siri voice)
  - TTS rate slider (0.5x–2.0x, default 1.0x)
  - Push-to-talk haptic feedback toggle (default on)

About
  - Version + build number
  - Bundle ID
  - Open source licenses
  - "Export diagnostic logs" (last 24h os_log → share sheet)

Reset
  - "Clear local cache" (footer, gray, confirms)
```

A dedicated Diagnostics section (last reconnect time, WS round-trip latency, log entries cached count) is deferred to v1.5 unless Nil starts asking "why is this slow" frequently.

### Branding

- **Theming**: follow system color scheme (`@Environment(\.colorScheme)`). No app-level toggle in v1.
- **Accent color**: single `AccentColor` in `Assets.xcassets`, picked from the existing web theme palette.
- **App icon**: leverage the existing isomux character/outfit aesthetic. Fast path: export a high-res PNG of the chosen outfit from the web side once, feed Xcode's icon generator. Avoids a Swift SVG rasterizer in v1.
- **Launch screen**: SwiftUI launch screen, app icon centered on solid color matching icon background. No animation.
- **Agent avatars**: letter monograms in v1. Real character avatars are v2 — see [open question 5](#open-questions) for the SwiftUI-port vs server-side-render fork.
- **Universal binary** (iPhone + iPad). v1 ships iPhone layout scaled up on iPad. Real iPad split-pane is v2.

### Accessibility (v1 ambition: solid system defaults)

- VoiceOver: every control has `.accessibilityLabel`. Centralize per-LogEntry-kind summarization in a single `func voiceOverLabel(for entry: LogEntry) -> String` that any new kind must touch — prevents drift as kinds get added.
- "↓ N new" pill exposes a VoiceOver custom action announcing "N new messages, double-tap to scroll to bottom."
- Dynamic Type: system text styles only (`.body`, `.headline`, `.callout`). Verify chat doesn't break at AX5 (largest).
- Contrast: rely on `.primary`/`.secondary` system colors + AccentColor.
- Reduced motion: respect `\.accessibilityReduceMotion` for smooth-scroll and animations.
- Hit targets: 44×44pt minimum.
- Color independence: state pills use icon + color, not color alone.
- Dedicated audit pass deferred to v1.5.

---

## Voice & media

### Speech-to-text (input)

- **Push-to-talk** button using `SFSpeechRecognizer` on-device recognition. Better accuracy than the dictation keyboard; user controls start/stop.
- Live transcript shown above compose bar; release to send-or-edit.
- Speech permission prompted lazily on first hold-to-record.
- **Caveat:** `SFSpeechRecognizer` has a ~60s cap per audio task. Rarely an issue for short voice inputs; flag if users start dictating long context dumps.

### Text-to-speech (output)

- `AVSpeechSynthesizer` — free, on-device, low latency, respects user's system voice preferences.
- **Per-agent auto-TTS toggle** (server-side, follows username across devices). Off by default.
- When on, only auto-speaks `text` log entries (not thinking/tool_calls), trimmed to ~500 chars with a "tap to read full" option.
- **Background audio** entitlement (`audio` mode in Info.plist with "spoken content" rationale). Lets TTS continue with screen off.
- **Locked-screen / driving UX**: don't try to solve in v1. TTS plays through background-audio entitlement, replies require unlock — standard iOS app behavior.

### Audio session strategy

- `.playback + .duckOthers` while TTS active. Ignores mute switch (intended for spoken content); ducks Spotify/podcast rather than fighting them.
- `.ambient` otherwise. Foreground in-app sounds mix with other audio and respect the mute switch.
- **Foreground sound**: port the web's sound-on-idle pattern. When app is foregrounded but on a different screen, play a brief ping when an agent in `notifRooms` goes idle. `AudioServicesPlaySystemSound` with a short WAV; reuse the web's audio file if compatible.

### Image attachments

- `PhotosPicker` (no permission prompt) for library; multi-select up to 5.
- Separate camera button using `UIImagePickerController` (camera mode); camera permission prompted lazily.
- **Pre-upload pipeline**: HEIC → JPEG (UIImage round-trip, trivial), resize longest edge to 2048px, target ~1MB. Server already enforces 20MB/file, 40MB total via existing `/api/upload/:agentId`.
- **Send-original toggle**: v2.
- **File picker (PDFs, etc.)**: v2.

---

## State machines

### Disconnect & backgrounding

- **Foreground disconnect**: exponential backoff (1s, 2s, 5s, 15s, 60s cap). No UI for the first 5s (avoids walking-through-doorway flicker). After 5s: yellow nav-bar pill "Offline — reconnecting." Chat stays fully readable from cached log; outbound messages queue locally with clock icon.
- **Cold-start without connectivity** is a distinct state from "5s+ offline." App launches, GRDB cache populates UI, no WS connect. Show "Connecting…" briefly, then transition to standard offline pill if it never resolves. Without this distinction the user sees populated data they can't act against and is confused.
- **Backgrounding**: let iOS suspend the app after ~30s. WS drops cleanly. APNs takes over. No background WS keep-alive (battery + Apple review heuristics).
- **Foreground-from-background replay**: send `subscribe` with `lastSeenLogIdByAgent`. Server streams the gap. Cap 500 entries per agent → otherwise server sends `full_resync_required` and client falls back to paged HTTP. `replay_complete` clears the catching-up pill.
- **Outbound queue**: pending sends in GRDB with `pending` state, retried on reconnect. Server reject → inline error on bubble with retry/discard. **24h expiry** on pending sends with a "failed to send" surface.

### User-switch & logout

- **Switch user**: confirmation modal ("Cached messages and queued sends will be removed from this device."), `unregister_device_token` for old user, wipe GRDB tables, keep server URL + push permission grant, reload `/api/users`, picker, `register_device_token` for new user on next WS connect.
- **Logout**: separate, less prominent. Same as switch + wipes server URL → returns to onboarding step 1.
- **Voice settings (auto-TTS, mute)**: server-side per (username, agentId) — follow the username, local clear is just cache.

### APN token lifecycle

- **Re-register on every cold launch.** Cheap insurance against silent invalidation.
- **Rotation**: iOS may reissue the token; `didRegisterForRemoteNotificationsWithDeviceToken` handler diffs against last-known and sends `unregister(old)` + `register(new)`.
- **Server dedup**: `(token, username, deviceLabel)` upsert. Same token for different username → re-pair.
- **410 Unregistered**: drop silently. Self-heal on next cold launch.
- **Sign-out-of-iCloud / restore-from-backup**: token may invalidate → next push returns 410 → cleanup → re-register on cold launch. No user action.
- **Sandbox vs production**: TestFlight uses **production** APNs; only Xcode debug builds use sandbox. `register_device_token` includes `environment`; server stores per-token, routes to `api.push.apple.com` or `api.sandbox.push.apple.com` accordingly.

---

## First-launch flow

A single 4-step linear flow, all redoable from Settings:

1. **Server URL**: text field, default `http://auntie:4000`. Validate on Continue by hitting `/api/users`. Error copy explicitly mentions Tailscale: "Couldn't reach server. Make sure Tailscale is on and the URL is correct."
2. **User picker**: list rendered from `/api/users`. Tap to select.
3. **Device label**: pre-filled with `UIDevice.current.name`, editable.
4. **Push permission**: friendly explainer ("Get notified when an agent finishes"), then `UNUserNotificationCenter.requestAuthorization`. Skippable; re-enable from Settings later.

After step 4: register device token (if granted) via `register_device_token`, drop into Agents tab. Subsequent launches skip the wizard. If a step's value goes stale (server unreachable, user no longer in users.json), surface as a banner in Settings rather than blocking the whole app.

---

## Empty & error states catalog

| State | Copy / behavior |
|---|---|
| Onboarding step 1 fail | "Couldn't reach server. Make sure Tailscale is on and the URL is correct." |
| Onboarding step 2: no users | "No users found on this server. Set one up first." + retry |
| Onboarding step 4: push denied | "Notifications are off. You can re-enable in Settings later." + Continue |
| Agents tab: no rooms / no agents | "No agents yet. Spawn one from the desktop UI." |
| Active Now empty | Hide section entirely |
| Tasks tab: no tasks | "No tasks. Tap + to create one." |
| Chat: agent killed mid-session | Banner "This agent was stopped." Compose bar disabled. |
| Chat: agent renamed mid-session | Refresh nav bar header gracefully on next state update |
| Chat: agent removed mid-session | Non-dismissible banner "This agent no longer exists." Compose disabled. |
| Chat send failed (server reject) | Inline error on bubble with Retry / Discard |
| Chat send failed (offline) | Clock icon on bubble + "Will send when reconnected." |
| Voice transcription failed | "Couldn't transcribe. Try again?" |
| Long replay in progress | Subtle "Catching up…" pill in nav bar until `replay_complete` |
| Mic denied on push-to-talk | Alert "Microphone access is off. Enable in Settings to use voice input." + Open Settings |
| Camera denied on camera tap | Alert "Camera access is off. Enable in Settings." + Open Settings |
| Push denied (post-onboarding) | Settings banner "Notifications are off in iOS Settings." + Open Settings |
| Cold-start without connectivity | "Connecting…" briefly, then offline pill if unresolved |
| <5s offline mid-session | No UI |
| 5–60s offline | Yellow nav pill "Offline — reconnecting" |
| >60s offline | Orange nav pill "Offline — tap to retry" |
| App older than server | Dismissible (informational, not blocking) banner "Update available — open TestFlight." |
| Push token registration failure | Silent retry. Logged only. |

---

## Versioning & protocol compatibility

- **Both sides treat unknown message kinds as no-ops with a warning log.** Never crash.
- **`protocolVersion: int`** in `subscribe`. Phone sends what it speaks. Server stores it on the session.
- **`subscribe_ack`** echoes the server's protocol version. Client logs mismatch; if `serverVersion - phoneVersion > 1`, shows the dismissible "Update available" banner.
- **Bump conservatively.** Minor for additive (new variants), major reserved for breaking changes (which we shouldn't ship).
- **Critical client-safety signals never use new variants** — always reuse existing variants so old clients see them.
- **Force-update banner is a nudge, not a wall.** Stale phones still get all features they currently have.
- **No long-lived backwards-compat code paths.** Within ~3 months of stale builds, the banner suffices for personal-use.

---

## v1 sequencing

Each step shippable, roughly in order. Step 0 is admin/Apple bureaucracy and should happen literally day 1 — Apple activation can take a day or two.

| # | Work | Milestone |
|---|---|---|
| 0 | Apple Developer account ($99/yr), bundle ID reservation, .p8 key generation, Xcode project scaffold | Build infrastructure ready |
| 1 | Server: `/api/users` + WS command stubs (no APNs yet). Verify session-identity binding. | Server foundation |
| 2 | iOS scaffold + onboarding + WS connect + agent list (read-only, no chat yet) + basic exponential-backoff reconnect (just resubscribe with empty state) | First TestFlight build — connection-proven |
| 3 | Chat view: text-only send + LogEntryCard port for `text`, `thinking`, `tool_call`, `tool_result`, `error`, `user_message` | First useful build — conversation-proven |
| 4 | Diff and edit-request rendering. Round-trip with at least one real agent. | Conversation-proven with full kinds |
| 5 | Voice input (push-to-talk) + image attachments | Voice + media |
| 6 | Server: APNs module (jwt, apns, tokens, events) + agent-manager event emissions. Independent track; can run in parallel with iOS work from step 2 onward. | Server push pipeline |
| 7 | iOS: device-token registration + push handling + deep-link from notification | First "killer feature" build — push-proven |
| 8 | Tasks tab: list + create + filter chips + swipe-claim/done | Tasks |
| 9 | Settings screen: re-edit onboarding, push toggle, user switch, server URL, auto-TTS per-agent | Settings complete |
| 10 | GRDB log cache + outbound queue + `last_seen_log_id` replay + `full_resync` paging | Offline robustness |
| 11 | Polish: empty states, error states, app icon, launch screen, in-app sound on foreground notifications | v1 launch-ready |

**Note:** the basic-reconnect lives in step 2/3, not step 10. TestFlight builds will hit network drops constantly and need *some* reconnect behavior immediately. Step 10 is the harder pieces: cache hydration, replay protocol, full_resync fallback.

---

## Testing strategy & performance budgets

### Test types in v1

- **Unit tests** (`IsomuxTests/`): `WSClient` state machine, GRDB log cache, outbound queue, onboarding validation, codegen output.
- **Codegen round-trip parity tests**: for every variant of every WS message type, encode → decode → re-encode → assert equivalence. Catches Quicktype regressions silently when `shared/types.ts` evolves.
- **Integration tests**: a `FakeIsomuxServer` in `IsomuxTests/Mocks/` that speaks the WS protocol; drive end-to-end flows.
- **Snapshot tests**: deferred. SwiftUI snapshot testing is fragile and the UI will churn fast.
- **UI tests (XCUITest)**: deferred. Manual TestFlight testing is the verification.
- **Regression policy**: every TestFlight bug fix lands with a test that would have caught it.

### Performance budgets (aspirational, measured before optimizing)

| Metric | Target |
|---|---|
| First paint after launch | <500ms (cached agent list visible from GRDB before WS hello) |
| WS connect → first server message processed | <1s on Tailscale |
| Chat scroll FPS | 60fps with 200 LogEntryCards; 30fps acceptable with 500+ |
| Memory at idle | <150MB resident |
| Push tap → chat opens | <600ms |

### Beta program

- Phase 1: TestFlight Internal — Nil only.
- Phase 2: TestFlight Internal — small invited group (3–5) once chat round-trip is stable.
- Phase 3: TestFlight External — only if distribution beyond personal-use comes up.

---

## v2 deferred

| Feature | Reason for deferral |
|---|---|
| Terminal | Unusable on a phone screen, even when polished |
| File editor | Same |
| Cronjobs UI | Low frequency, configuration-heavy, laptop-friendly |
| Agent spawn / configure (name, cwd, instructions, outfit, room) | Keyboard-heavy; rare from phone |
| Move agent to another desk | Same |
| Real iPad split-pane (rooms / agents / chat columns) | Significant work; iPhone layout works on iPad acceptably |
| Mac Catalyst | Separate scope decision |
| Character/outfit avatars in lists | SwiftUI port or server-side rasterizer is real work; letter monograms ship easy |
| Full markdown (tables, task lists, syntax highlighting) | Requires third-party libs and tuning |
| Per-agent custom notification sounds | v1 ships single default sound |
| Per-user push coalescing (5 agents idle within 2s → one banner) | Annoyance threshold not yet validated |
| Send-original toggle for full-fidelity images | UI design review use case, rare |
| File picker (PDFs, audio, etc.) | Phone-attached non-image files are rare; voice covers most v1 needs |
| Background fetch / silent push for cache freshness | Not yet justified |
| SQLCipher-encrypted GRDB | Threat model doesn't yet require it |
| Diagnostics section in Settings (latency, cache size, last reconnect) | Add when "why is this slow" comes up frequently |
| Apple Watch companion | Out of scope for v1 |
| Universal Links (https://) instead of `isomux://` | Requires owned domain + apple-app-site-association; not worth for personal-use |
| Internationalization | English-only v1; localization is much cheaper to design in than retrofit if distribution broadens |
| Dedicated accessibility audit | Solid defaults v1; bump if external testers report issues |

---

## Risk register

| Risk | Mitigation |
|---|---|
| **Quicktype tagged-union output for `ServerMessage`/`ClientCommand`** quirky/awkward | 1-day buffer for post-processor or hand-written variants; codegen round-trip parity tests |
| **APNs JWT ES256 signing in Bun** (no turnkey lib) | Web Crypto path is clean; ~1 day implementation + debugging |
| **Critical Alerts entitlement denied by Apple** | Default plan ships `time-sensitive` only; entitlement is a stretch goal |
| **Server protocol extension surface (~3–5 days)** could expand if hidden coupling found in `agent-manager.ts` or `command-handlers.ts` | Verify session-identity binding pattern early; budget for it |
| **Avatar rendering** (SwiftUI port vs server-side rasterizer) | Letter monograms ship in v1; pretty avatars = v2 with the path picked |
| **Background audio + Critical Alerts entitlements** Apple approval timelines unpredictable | Background audio is automatic on declaration; Critical Alerts has fallback |
| **TestFlight build/upload first time** (signing certs, provisioning, App Store Connect) | 1–2 days of Apple bureaucracy; allocate in Step 0 |
| **Tailscale MagicDNS resolution flakiness on cellular** | Tailscale-aware error copy already specced (Q15); document in user-facing onboarding |
| **iOS 17+ requirement** | Confirm beta-group hardware in advance; fall back to iOS 16 only if blocker |

---

## Open questions

These were punted to Nil during the interview because they're not architectural — but they have to be answered before work begins.

1. **Bundle ID** — `com.nilmamano.isomux` vs `dev.nilmamano.isomux` vs other. Permanent once reserved.
2. **PWA escape-hatch** — confirm native (current plan), or try iOS 16.4+ Web Push for installed PWAs as v0.5 first. The killer feature pulling the plan toward native is push; if Web Push on a PWA is good enough, native saves months of work.
3. **Apple Developer account ($99/yr)** — OK to sign up.
4. **Critical Alerts entitlement** — apply to Apple (likely denied for dev tools) or skip and ship `time-sensitive` only.
5. **Avatar rendering fork** (v1 letter monograms locked, v2 path TBD) — SwiftUI port of the web character renderer vs server-side `/api/agent/<id>/avatar.png` headless render (e.g., resvg-js).
6. **TestFlight beta group beyond Nil** — anyone else, or solo for now.
7. **v2 priority ranking** — terminal, file editor, cronjobs UI, agent spawn/edit, character avatars, real iPad split-pane, message coalescing, full markdown.
8. **Internationalization scope** — confirm English-only v1.

---

## Done definition

- All 11 sequencing steps complete, on TestFlight Internal.
- Nil uses the app as the primary phone-to-isomux interface for ≥1 week without falling back to the web UI for daily ops.
- No P0 bugs from TestFlight feedback.
- All 8 open questions resolved with decisions recorded in this doc.
