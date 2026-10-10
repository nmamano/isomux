# Dynamic model discovery

Status: design, not built. Waiting for Nil's go. Tasks c593ff51 and 1f220780 (2026-10-02).

Goal: a new provider model shows up in Isomux without an Isomux release.

## What each engine exposes at runtime

Checked against the installed packages on 2026-10-02. This lane bumps the Claude Agent SDK from 0.3.280 to 0.3.287; each fact names the version it was checked on.

**Claude** (`@anthropic-ai/claude-agent-sdk` 0.3.280). `Query.supportedModels()` returns `ModelInfo[]`: `value`, `resolvedModel`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`, `supportsFastMode`, `supportsAutoMode`. The same list is in `initializationResult().models`. The call needs a live query process but no model turn. A probe on this box returned five rows: `default` (Opus 5.5, 1M), `opus[1m]`, `claude-fable-5-1[1m]`, `sonnet` (resolves to `claude-sonnet-5`), `haiku`. It carries no context window.

The CLI also fetches a signed remote catalog, `https://downloads.claude.ai/model-catalog/v1/catalog.json` (version 1516, expires 2026-10-08), and caches it in `$CLAUDE_CONFIG_DIR/cache/model-catalog/`. Per model it carries `name`, `short_name`, `runtime.family`, `runtime.max_input_tokens`, `runtime.effort_levels`, `runtime.default_effort` and `min_claude_code_version`. It already lists `claude-sonnet-5-5`. But SDK 0.3.280 does not act on it for an id its binary does not know: the `sonnet` alias still resolves to `claude-sonnet-5`, and a turn on an explicit `claude-sonnet-5-5` runs but reports a 200k context window (probe, 2026-10-02; the catalog says 1M). So for Claude, a new model still needs an SDK bump to get the right alias and window. Discovery can show the model sooner; it cannot make the old CLI size it correctly. On 0.3.287 the `sonnet` row resolves to `claude-sonnet-5-5` and lists `max` in `supportedEffortLevels`.

**Can isomux run a separately installed, self-updating Claude CLI?** Mechanically yes. `Options.pathToClaudeCodeExecutable` ("Path to the Claude Code executable. Uses the built-in executable if not specified.") takes any path, and isomux already sets it, to the bundled binary (`CLAUDE_NATIVE_BIN` in server/cwd-utils.ts). The SDK makes no version check: it only passes `CLAUDE_AGENT_SDK_VERSION` to the child in the environment. The SDK does not promise that a CLI of another version works. Instead, `sdk.d.ts` (0.3.287) handles skew field by field, in 17 places. For example: "Requires Claude Code 2.1.261 or newer (the binary bundled with this SDK qualifies); an older binary exits at startup with an unknown-option error", "older CLIs ignore the field", "treat absence as an older CLI". The versions move in lockstep: SDK 0.3.287 bundles Claude Code 2.1.287. A self-updated CLI would run ahead of the SDK isomux was built and tested against, and every feature isomux relies on would become a runtime question. On this box, `~/.local/bin/claude` is 2.1.233 (it did not self-update), which is older than both SDKs. Recommendation: keep the bundled binary. A new Claude model then still ships with an isomux release that bumps the SDK. Discovery can reduce that release to a one-line dependency bump, but it cannot remove it.

**Codex** (`@openai/codex` 0.153.4). Isomux already calls the app-server `model/list` RPC in `codexBackend.listModels()`. Each `Model` carries `model`, `displayName`, `description`, `hidden`, `isDefault`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `upgrade`, `inputModalities`. No context window; the session learns it from `modelContextWindow` in the token-usage notification. The list is the binary's bundled catalog merged with a remote catalog that Codex caches in `$CODEX_HOME/models_cache.json` (here `~/.isomux/codex-home`, last fetched 2026-10-01 with `client_version` 0.153.4; that remote list holds `gpt-reserve`, which the 0.153.4 bundle does not). So Codex discovery works today for the pickers; only the fallback list and the static tables lag.

**OpenCode** (`opencode-ai` 1.18.23). Already dynamic: `discoverOpenCodeModels()` reads the server's `/provider` route per cwd and keeps an allow-listed scalar subset, including `contextLimit`. No static table to retire.

## Worked example: the provider serves a model before the bundled client lists it

On 2026-10-02 Anthropic served `claude-sonnet-5-5`, and the remote catalog listed it with a 1M window. The SDK isomux shipped (0.3.280) did not list it:

1. `supportedModels()` on 0.3.280 resolved `sonnet` to `claude-sonnet-5`. Discovery through the SDK would not have shown Sonnet 5.5 at all.
2. The CLI's cached remote catalog did list it. Discovery that reads the catalog would have shown it.
3. A turn on the explicit id ran and reported a 200k window. Context bars, the fullness notices and the `/context` route would have used the wrong window for every agent on it.
4. SDK 0.3.287 (released the day before) fixed all three. The fix was a dependency bump and a one-line change to `FAMILY_TO_MODEL`.

Model release rule (Nil, 2026-10-10): whenever Isomux updates `FAMILY_TO_MODEL` to show a new Claude model, update `CLAUDE_CLOUD_MODEL_DEFAULTS` in `shared/types.ts` in the same change. Check the newest bundled CLI first, then verify provider IDs and supported source regions against the AWS and Google model cards. Record the source and check date. Recheck aliases without a table row too (currently Opus and Fable). Keep explicit pins, preserve region variables, and never add a global fallback. Run `server/backends/claude-cloud-defaults.test.ts`; its alignment test must fail if a picker model changes without its cloud row. Verify launches, titles, model labels, and effort/Auto limits use the same resolved defaults. Report which IDs were tested live; an offline alias or request capture does not prove account access.

So for Claude the rule is: show a model only when the bundled SDK's `supportedModels()` lists it (PM recommendation for Q1 below). Codex had the same case the other way round: Nil asked for "Astra 6.1", and no Codex release or remote catalog lists it on 2026-10-02. Discovery would correctly show nothing.

## What the hardcoded tables carry

| Table | Carries | Discovery source | Fallback when discovery has nothing |
| --- | --- | --- | --- |
| `FAMILY_TO_MODEL` (shared/types.ts) | family → exact Claude id | `supportedModels()[].resolvedModel` of the family alias row | the table, as today |
| `MODEL_FAMILIES`, `ModelFamily` union | the four Claude families, picker order, default. The spawn and edit dialogs read it directly; they do not use the fetched Claude list | none for new families: the CLI exposes aliases, and a new family (a fifth alias) needs new wire values | keep static; a new family stays a release |
| `modelVersionLabel` / `familyDisplayLabel` | "Sonnet 5" label | `ModelInfo.description` prefix or the catalog `name` | derive from `FAMILY_TO_MODEL`, as today |
| `claudeFamilySupportsEffort`, `claudeFamilySupportsMaxEffort`, `effortLevelsFor` | Claude effort levels per family | `ModelInfo.supportsEffort`, `ModelInfo.supportedEffortLevels` | the static rule. This lane adds `max` for sonnet (0.3.287 reports it for Sonnet 5.5). The haiku row reports no effort support (`supportsEffort` absent, 0.3.287), and the CLI drops an effort option on haiku (`get_settings` reports `applied.effort: null`, 2026-10-02), so haiku lists no levels; a stored haiku effort is kept |
| `claudeFamilySupportsAutoPermission` | auto permission mode: opus and fable only | `ModelInfo.supportsAutoMode` | the static rule. Stale on 0.3.287: the sonnet row reports `supportsAutoMode: true`. The gate exists for classifier reliability (shared/types.ts), so it is a policy choice, not only a capability fact |
| `CODEX_MODELS` + adapter `MODEL_OPTIONS` (duplicate) | fallback picker list, labels, default | `model/list` (already used) | keep one list in shared/types.ts and drop the adapter copy |
| `MODEL_STYLES` (ui/model-styles.ts) | badge tint, desk prop (tier) | none: providers do not report a tier | hash fallback colour, no desk prop, as today. Optional: inherit the style of the nearest known slug prefix (`gpt-6.1-sol` → `gpt-5.6-sol`'s tier) |
| `shared/agent-templates.ts` preference lists | template → preferred models | none | first listed model the live list contains, then `CODEX_MODELS[0]`, as today |
| Context window | not stored by Isomux | Claude `getContextUsage()`, Codex token-usage notification, OpenCode `contextLimit` | as today |
| Docs and site copy (api/chat.ts, docs/llm-providers.md) | model names in prose | none | name families, not versions, where the prose allows |

## When discovery runs and how it is cached

- Claude: the server runs one `supportedModels()` probe per environment key (the same key `listModels` gets) at the first `GET /api/backends/claude/models`, and caches the result in memory for an hour. Each live Claude session also reports `initializationResult().models` at start; that refreshes the cache for free. A failed probe falls back to the static rows and is not cached.
- Codex: keep the per-request `model/list` (1-2 s, the call already exists). Add the same one-hour in-memory cache per environment key so every dialog open does not spawn a subprocess.
- OpenCode: unchanged.
- Nothing persists to disk. Each engine's own cache (`models_cache.json`, the CLI catalog cache) already survives restarts.

## A pinned model that disappears

- Claude agents store the family, not the id. On first-party auth Isomux sends the exact id from `FAMILY_TO_MODEL`; on cloud auth it sends the alias (`claudeModelForEnvironment` in server/backends/claude.ts). When discovery fills `FAMILY_TO_MODEL` from `resolvedModel`, a retired version moves the agent to the current model of its family at its next session, and the log header shows the new version.
- Codex agents store the slug. Today the turn fails and the adapter posts "This Codex model isn't available on your current login…". Proposal: keep that, and name the slug in the `Model.upgrade` field of the old entry when `model/list` still returns it as hidden (unchecked whether Codex keeps retired entries there). No silent switch; the member picks.
- OpenCode: unchanged; the provider error reaches the chat.
- The pickers show the stored value even when the list lacks it (EditAgentDialog already does this), so opening settings never drops the pin by itself.

## Open questions for Nil

1. Claude discovery shows a model the bundled CLI does not size correctly (200k instead of 1M). Show it anyway, or hide catalog-only models until the SDK knows them? PM recommends: hide.
2. Should Claude effort levels follow `supportedEffortLevels` (this lane already enables `max` on Sonnet statically)? PM recommends: yes.
3. Fallback styles for unknown models: hash colour only (today), or prefix-inherit tier? PM recommends: hash colour only.
