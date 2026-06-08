/**
 * Plugin discovery and loading.
 *
 * Two ways an operator can enable a plugin in office-config.json's
 * `enabledPlugins` array:
 *
 *   1. Bare string id: `"safety-hooks"` — a bundled, first-party plugin.
 *      Resolved under `<isomuxRoot>/plugins/<id>/index.ts`. No path needed
 *      because the location is part of the isomux distribution.
 *
 *   2. {id, path} object: `{ "id": "mem0", "path": "/home/nil/nil/isomux-mem0" }`
 *      — an external plugin at an operator-controlled location. The path
 *      must be absolute or `~/...` prefixed; basename(path) does NOT have
 *      to match `id` (the plugin's repo may be named differently than its
 *      logical id). The plugin's exported `id` MUST match the configured
 *      one — that's the explicit handshake.
 *
 * No directory scanning. The config is the authoritative trust boundary:
 * if it isn't listed, it isn't loaded. Reviewer1's framing: "configuration
 * should describe all non-bundled code that will execute inside the isomux
 * process."
 *
 * Boot-only: loaded once at server startup. Restart required to pick up
 * code or config changes.
 *
 * Trust model: plugins run with the same privileges as the isomux process.
 * They can read env, read/write filesystem, mutate global state, and make
 * network calls. The explicit-path requirement for external plugins is the
 * cheapest auditable trust signal we can give operators: "here's exactly
 * what code I'm pulling in." See internal-docs/isomux-plugin-system.md.
 */

import { appendFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { STATE_ROOT } from "./config.ts";
import { pathToFileURL } from "url";
import type { IsomuxPlugin } from "../shared/plugin-types.ts";
import type { EnabledPluginEntry } from "./persistence.ts";

const PLUGIN_LOG_PATH = join(STATE_ROOT, "logs", "plugins.jsonl");

export interface LoadedPlugin {
  plugin: IsomuxPlugin;
  /** Resolved realpath of the plugin directory (post-symlink). Logged on
   *  load and on collisions so operators can confirm which copy is running. */
  realpath: string;
}

let loadedPlugins: LoadedPlugin[] = [];

/** Returns the list of plugins loaded at boot, sorted alphabetically by id.
 *  Stable for the server's lifetime — no hot reload in v0. */
export function getEnabledPlugins(): LoadedPlugin[] {
  return loadedPlugins;
}

/** Resolve, validate, and load every entry in `enabledPlugins`. Call once
 *  at boot, after persistence init and before agent spawn. */
export async function loadPlugins(opts: {
  isomuxRoot: string;
  enabledPlugins: EnabledPluginEntry[];
}): Promise<void> {
  // Entries were already deduped + format-validated by loadEnabledPlugins
  // in persistence.ts; the loop here is straight-line per-entry.
  const byId = new Map<string, LoadedPlugin>();

  for (const entry of opts.enabledPlugins) {
    const id = typeof entry === "string" ? entry : entry.id;
    const pluginDir =
      typeof entry === "string"
        ? join(opts.isomuxRoot, "plugins", id)
        : expandPath(entry.path);
    const indexPath = join(pluginDir, "index.ts");

    if (!existsSync(indexPath)) {
      logPluginFailure({
        pluginId: id,
        hook: "discovery",
        durationMs: 0,
        error:
          typeof entry === "string"
            ? `Bundled plugin "${id}" not found at ${indexPath}. String entries resolve under <isomuxRoot>/plugins/. For an external plugin use {id, path} instead.`
            : `Plugin "${id}" not found at configured path: no index.ts at ${indexPath}.`,
      });
      continue;
    }

    let realpath: string;
    try {
      realpath = realpathSync(pluginDir);
    } catch (err) {
      logPluginFailure({
        pluginId: id,
        hook: "discovery",
        durationMs: 0,
        error: `Failed to resolve realpath for ${pluginDir}: ${errMessage(err)}`,
      });
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      // Import via file:// URL from the realpath so Bun's module cache treats
      // this distinctly from any path-string resolution elsewhere.
      mod = (await import(
        pathToFileURL(join(realpath, "index.ts")).href
      )) as Record<string, unknown>;
    } catch (err) {
      logPluginFailure({
        pluginId: id,
        hook: "load",
        durationMs: 0,
        error: `Plugin "${id}" (${realpath}) failed to import: ${errMessage(err)}`,
      });
      continue;
    }

    const plugin = extractPlugin(mod);
    if (!plugin) {
      logPluginFailure({
        pluginId: id,
        hook: "load",
        durationMs: 0,
        error: `Plugin "${id}" (${realpath}) doesn't export a valid IsomuxPlugin (need id + at least one hook, either as default export object or top-level named exports).`,
      });
      continue;
    }

    if (plugin.id !== id) {
      logPluginFailure({
        pluginId: id,
        hook: "load",
        durationMs: 0,
        error: `Plugin "${id}" (${realpath}) exports id="${plugin.id}" but enabledPlugins entry says id="${id}". The exported id MUST match the configured id — they're the trust handshake.`,
      });
      continue;
    }

    if (!plugin.beforeTurn && !plugin.afterTurn) {
      logPluginFailure({
        pluginId: id,
        hook: "load",
        durationMs: 0,
        error: `Plugin "${id}" (${realpath}) has neither beforeTurn nor afterTurn — at least one required.`,
      });
      continue;
    }

    // Dedup happened in persistence; defensive check anyway.
    const existing = byId.get(id);
    if (existing) {
      logPluginFailure({
        pluginId: id,
        hook: "load",
        durationMs: 0,
        error: `Plugin id collision in loader: "${id}" already loaded from ${existing.realpath}; second copy at ${realpath} skipped. This indicates loadEnabledPlugins missed a duplicate.`,
      });
      continue;
    }

    byId.set(id, { plugin, realpath });
    console.log(`[plugins] loaded "${id}" from ${realpath}`);
  }

  // Sort by id so prompt-prefix ordering is deterministic across runs and
  // doesn't depend on enabledPlugins entry order.
  loadedPlugins = Array.from(byId.values()).sort((a, b) =>
    a.plugin.id.localeCompare(b.plugin.id),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~/` to the user's home directory. No other tilde
 *  expansions (no `~user/`, no bare `~`). Absolute paths pass through. */
function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Try to extract an IsomuxPlugin from a freshly-imported module. Accepts:
 *  - `export default { id, beforeTurn?, afterTurn? }`
 *  - Top-level named exports: `export const id = ...; export const beforeTurn = ...`
 *
 *  Hooks that are present but not callable (e.g. `{ id: "x", beforeTurn: true }`)
 *  are dropped here so the loader can reject them once at boot rather than
 *  having every turn fail with a hook-call exception. Returns null when no
 *  recognizable plugin shape is present at all. */
function extractPlugin(mod: Record<string, unknown>): IsomuxPlugin | null {
  const def = (mod as { default?: unknown }).default;
  if (def && typeof def === "object") {
    const candidate = def as Record<string, unknown>;
    if (typeof candidate.id === "string") {
      return materializePlugin(candidate);
    }
  }
  if (typeof mod.id === "string") {
    return materializePlugin(mod);
  }
  return null;
}

/** Build an IsomuxPlugin from a candidate object that has a string `id`.
 *  Functions are kept; non-function hook fields are silently dropped (the
 *  caller's "at least one hook" check then catches a plugin with neither). */
function materializePlugin(
  candidate: Record<string, unknown>,
): IsomuxPlugin | null {
  const id = candidate.id;
  if (typeof id !== "string") return null;
  const plugin: IsomuxPlugin = { id };
  if (typeof candidate.beforeTurn === "function") {
    plugin.beforeTurn = candidate.beforeTurn as IsomuxPlugin["beforeTurn"];
  }
  if (typeof candidate.afterTurn === "function") {
    plugin.afterTurn = candidate.afterTurn as IsomuxPlugin["afterTurn"];
  }
  return plugin;
}

// ---------------------------------------------------------------------------
// Failure logging — JSONL stream at ~/.isomux/logs/plugins.jsonl
// ---------------------------------------------------------------------------
//
// Hook failures and load errors are cross-agent and sometimes pre-agent
// (boot discovery). A dedicated stream keeps them out of chat-log entries
// (a noisy memory plugin would otherwise degrade core chat) while still
// being grep-able for forensics. Records include enough routing fields
// (agentId, roomId, origin) for operators to scope down. Full message text
// is NOT logged — plugin prefixes and user turns can contain secrets.

export interface PluginFailureRecord {
  pluginId: string;
  hook: "discovery" | "load" | "beforeTurn" | "afterTurn";
  agentId?: string;
  roomId?: string;
  origin?: "user" | "queued" | "skill" | "edit-fork";
  durationMs: number;
  error: unknown;
}

export function logPluginFailure(rec: PluginFailureRecord): void {
  const errorSummary =
    rec.error instanceof Error
      ? `${rec.error.name}: ${rec.error.message}`
      : typeof rec.error === "string"
        ? rec.error
        : safeStringify(rec.error);
  const line = JSON.stringify({
    ts: Date.now(),
    pluginId: rec.pluginId,
    hook: rec.hook,
    agentId: rec.agentId,
    roomId: rec.roomId,
    origin: rec.origin,
    durationMs: rec.durationMs,
    error: errorSummary,
  });
  try {
    mkdirSync(dirname(PLUGIN_LOG_PATH), { recursive: true });
    appendFileSync(PLUGIN_LOG_PATH, line + "\n");
  } catch (err) {
    // Fallback to stderr — operator needs to know failures aren't being
    // captured to disk. Don't swallow silently.
    console.error(
      "[plugins] failed to write failure log:",
      err,
      "record was:",
      line,
    );
  }
  // Also echo to stderr so failures surface in `journalctl --user -u isomux`.
  // A consistently misbehaving plugin will be loud here, prompting the
  // operator to disable it.
  console.error(`[plugins] failure: ${line}`);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return safeStringify(err);
}
