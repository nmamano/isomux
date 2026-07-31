// Plugin contract for isomux's first-party plugin system.
//
// In-process TypeScript modules, loaded by the Bun runtime at boot from
// <isomuxRoot>/plugins/ and ~/.isomux/plugins/. Two hooks:
//
//   beforeTurn - may inject a prompt prefix wrapped in per-plugin delimiters.
//   afterTurn  - observes the turn outcome (memory writes, audit, etc.).
//
// This file is the canonical definition for isomux's own use. Plugins
// themselves should NOT import from here - they re-declare these shapes
// locally so the contract can evolve before being published as a package.
// See internal-docs/isomux-plugin-system.md.

import type { LogEntry } from "./types.ts";

export interface PluginTurnContext {
  agentId: string;
  agentName: string;
  roomId: string;
  roomName: string;
  /** Backend session id. Null on the very first turn before system_init lands. */
  sessionId: string | null;
  cwd: string;
  /** Display name of the agent's manager (the boss who spawned it). May be
   *  null on legacy unowned agents that pre-date the user/device split. */
  username: string | null;
  /** Stable id of the agent's manager. Use this for partitioning per-boss
   *  data (mem0 user_id, audit identity). Null on legacy unowned agents. */
  userId: string | null;
  /** What the user typed verbatim (e.g. "/grill"). For display/audit. */
  visibleText: string;
  /** The semantic user input for this turn, with both the isomux sender
   *  prefix (`[Nil (Phone)]: `) and any plugin prefix blocks stripped. For
   *  normal sends and edits this is the raw user text; for skills it's the
   *  expanded skill prompt (what the user effectively asked the model to
   *  do); for coalesced queue flushes it's the per-item bodies joined
   *  without sender prefixes. This is the right value for plugins that
   *  want to reason about user intent - memory retrieval queries, audit
   *  records of "what was asked", etc. */
  originalText: string;
  /** Exact pre-plugin SDK prompt: sender prefix applied, plugin prefix
   *  blocks NOT yet prepended. This is the closest thing to "what the
   *  model will see" before plugins add their own context. Useful for
   *  audit/debug plugins that need to reason about the exact backend
   *  payload. Most plugins should prefer `originalText` instead - the
   *  sender prefix is an isomux-routing concern, not user intent. */
  sdkText: string;
}

export interface PluginBeforeTurnResult {
  /** Block of text prepended to the outgoing prompt. The hook bus wraps it
   *  in `--- begin plugin: <id> ---` / `--- end plugin: <id> ---` delimiters,
   *  concatenates with other plugins' blocks in alphabetical id order, and
   *  prepends the result to sdkText with a `User message:` separator.
   *  Empty / whitespace-only prefixes are dropped. */
  promptPrefix?: string;
}

export interface PluginAfterTurnInput {
  /** Outcome of the turn. `afterTurn` fires only after `session.send` has
   *  been attempted/accepted by the backend: `completed` for a normal end,
   *  `failed` for a backend or transport error, `interrupted` for a
   *  user-initiated stop / session swap that landed AFTER send. A turn
   *  cancelled DURING plugin retrieval (Stop, /clear, /resume, etc. before
   *  session.send) skips `afterTurn` entirely - nothing reached the model,
   *  so there is no turn outcome to observe. Plugins must not rely on
   *  `afterTurn` for symmetry with every `beforeTurn` invocation. */
  status: "completed" | "failed" | "interrupted";
  /** The final string sent to the backend. Includes both the sender prefix
   *  (`[Nil (Phone)]`) AND every plugin's prefix block from this turn. The
   *  three text representations available to a plugin:
   *    - `ctx.originalText`  - sender prefix stripped, plugin prefixes stripped.
   *                            Use this for storing the user's semantic
   *                            request (mem0 add()) and for retrieval
   *                            queries (mem0 search()).
   *    - `ctx.sdkText`       - sender prefix applied, plugin prefixes NOT
   *                            yet added. Useful for plugins that need to
   *                            know exactly what isomux routing produced.
   *    - `userTextSent`      - both prefix layers applied. This is what the
   *                            model literally saw. Useful for audit/debug
   *                            plugins that need to reproduce the prompt. */
  userTextSent: string;
  /** The assistant's full natural-language output for this turn,
   *  concatenated from every `text` log entry produced after the snapshot,
   *  in chronological order, joined with blank-line separators. Tool-using
   *  turns frequently emit `text → tool_call → text` patterns; the join
   *  preserves all spans so memory/audit plugins see the complete response.
   *  Empty on failed/interrupted turns where no text landed. */
  assistantText: string;
  /** Log entries produced during this turn, post-snapshot. Includes
   *  tool_call / tool_result / error / system / thinking entries. The
   *  triggering user_message is NOT included - the snapshot is taken
   *  after it's been logged. */
  newLogEntries: LogEntry[];
}

export interface IsomuxPlugin {
  /** Must match the plugin directory name. `[a-z0-9_-]+`. */
  id: string;
  beforeTurn?: (
    ctx: PluginTurnContext,
  ) => Promise<PluginBeforeTurnResult | void> | PluginBeforeTurnResult | void;
  afterTurn?: (
    ctx: PluginTurnContext,
    input: PluginAfterTurnInput,
  ) => Promise<void> | void;
}
