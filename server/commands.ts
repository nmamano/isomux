// Declarative registry of every known Claude Code command and bundled skill.
// Pure data — no handler logic lives here.
//
// See docs/slash-command-design.md for the full design.

export type CommandType = "hardcoded" | "bundled-skill" | "hybrid";

export type CommandConfig = {
  type: CommandType;
  /** Does Isomux handle this command? */
  supported: boolean;
  /** Show in autocomplete? */
  autocomplete: boolean;
  /** Can user/project/bundled skills shadow this command? */
  overridable: boolean;
  /** Key into commandHandlers (required when supported: true, except for skills-only) */
  handler?: string;
  /** Custom ephemeral message for unsupported commands (default: "/<name> is not available in Isomux.") */
  message?: string;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const commands: Record<string, CommandConfig> = {
  // --- Supported, non-overridable (Isomux built-in handlers) ---
  clear: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "clear",
  },
  context: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "context",
  },
  cost: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
    message: "`/cost` is a Claude Code command for API users. Isomux uses subscription-based billing.",
  },
  help: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "help",
  },
  resume: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "resume",
  },
  login: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "login",
  },
  logout: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "logout",
  },

  // --- Unsupported hardcoded commands (non-overridable) ---
  compact: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
    message: "`/compact` is not yet supported in Isomux. Context is auto-compacted by the SDK.",
  },
  fork: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  export: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  plan: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  model: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  fast: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  usage: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  stats: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  diff: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  rewind: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  copy: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  "add-dir": {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  btw: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  config: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  hooks: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  permissions: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  keybindings: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  memory: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  mcp: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  ide: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  agents: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  skills: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  plugin: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  bashes: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  doctor: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  bug: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  "install-github-app": {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  exit: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
    message: "Use the Isomux UI to manage agents. `/exit` only works in the Claude Code CLI.",
  },
  init: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },
  status: {
    type: "hardcoded",
    supported: false,
    autocomplete: false,
    overridable: false,
  },

  // --- Bundled skills (overridable) ---
  review: {
    type: "bundled-skill",
    supported: false,
    autocomplete: false,
    overridable: true,
  },
  simplify: {
    type: "bundled-skill",
    supported: false,
    autocomplete: false,
    overridable: true,
  },
  debug: {
    type: "bundled-skill",
    supported: false,
    autocomplete: false,
    overridable: true,
  },
  "claude-api": {
    type: "bundled-skill",
    supported: false,
    autocomplete: false,
    overridable: true,
  },

  // --- Hybrid commands (overridable, but runtime machinery not available) ---
  batch: {
    type: "hybrid",
    supported: false,
    autocomplete: false,
    overridable: true,
  },
  loop: {
    type: "hybrid",
    supported: false,
    autocomplete: false,
    overridable: true,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All command names that should appear in autocomplete from the config. */
export function autocompleteCommands(): string[] {
  return Object.entries(commands)
    .filter(([, cfg]) => cfg.autocomplete)
    .map(([name]) => name);
}

/** Unsupported message for a command, with type-aware defaults. */
export function unsupportedMessage(name: string): string {
  const cfg = commands[name];
  if (cfg?.message) return cfg.message;
  if (!cfg) return `\`/${name}\` is not available in Isomux.`;
  if (cfg.type === "hardcoded") {
    return `\`/${name}\` is a Claude Code command, but it's not supported in Isomux.`;
  }
  if (cfg.type === "bundled-skill") {
    return `\`/${name}\` is a Claude Code bundled skill, but it's not supported in Isomux. You can override it by creating your own skill file.`;
  }
  if (cfg.type === "hybrid") {
    return `\`/${name}\` is a Claude Code command that requires CLI runtime machinery not available in Isomux.`;
  }
  return `\`/${name}\` is not available in Isomux.`;
}
