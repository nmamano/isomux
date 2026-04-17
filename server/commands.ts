// Declarative registry of every known Claude Code command and bundled skill.
// Pure data — no handler logic lives here.
//
// See docs/slash-command-design.md for the full design.
// Last updated: 2026-03-31 (Claude Code ~1.0.x)

export type CommandType = "hardcoded" | "bundled-skill";

export type CommandConfig = {
  type: CommandType;
  /** Does Isomux handle this command? */
  supported: boolean;
  /** Show in autocomplete? */
  autocomplete: boolean;
  /** Can user/project/bundled skills shadow this command? */
  overridable: boolean;
  /** Key into commandHandlers (required when supported: true) */
  handler?: string;
  /** Short description of what this command does */
  description?: string;
  /** Custom ephemeral message for unsupported commands (default is type-aware) */
  message?: string;
};

// Shorthand for the common unsupported-hardcoded pattern
const UNSUPPORTED_HARDCODED: Omit<CommandConfig, "message"> = {
  type: "hardcoded",
  supported: false,
  autocomplete: false,
  overridable: false,
};

// Shorthand for the common unsupported-bundled-skill pattern
const UNSUPPORTED_BUNDLED_SKILL: Omit<CommandConfig, "message"> = {
  type: "bundled-skill",
  supported: false,
  autocomplete: false,
  overridable: true,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const commands: Record<string, CommandConfig> = {
  // =========================================================================
  // Supported (Isomux built-in handlers)
  // =========================================================================
  clear: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "clear",
    description: "Wipe conversation history",
  },
  context: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "context",
    description: "Visualize context window usage",
  },
  help: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "help",
    description: "List all available commands",
  },
  resume: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "resume",
    description: "Pick up a previous session",
  },
  login: {
    ...UNSUPPORTED_HARDCODED,
    description: "Log in to your Anthropic account",
    message: "To authenticate:\n1. Open the built-in terminal\n2. Run `claude`\n3. Type `/login`\n4. Follow the auth flow\n\nOnce complete, it takes effect immediately for all Isomux agents.",
  },
  logout: {
    ...UNSUPPORTED_HARDCODED,
    description: "Log out of your Anthropic account",
    message: "To log out:\n1. Open the built-in terminal\n2. Run `claude logout`",
  },
  "isomux-all-hands": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxAllHands",
    description: "Summary of all agents and their conversations",
  },
  "isomux-system-prompt": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxSystemPrompt",
    description: "Show the full system prompt this agent receives",
  },

  // =========================================================================
  // Unsupported hardcoded commands (non-overridable)
  // =========================================================================

  // --- Session & context ---
  compact:    { ...UNSUPPORTED_HARDCODED, description: "Compress context", message: "`/compact` is not yet supported in Isomux. Context is auto-compacted by the SDK." },
  branch:     { ...UNSUPPORTED_HARDCODED, description: "Branch conversation into new session" },
  fork:       { ...UNSUPPORTED_HARDCODED, description: "Branch conversation into new session" },
  export:     { ...UNSUPPORTED_HARDCODED, description: "Export conversation to file" },
  plan:       { ...UNSUPPORTED_HARDCODED, description: "Toggle plan mode" },
  rename:     { ...UNSUPPORTED_HARDCODED, description: "Rename current session" },
  reset:      { type: "hardcoded", supported: true, autocomplete: false, overridable: false, handler: "clear", description: "Reset conversation" },
  new:        { type: "hardcoded", supported: true, autocomplete: false, overridable: false, handler: "clear", description: "Start new conversation" },

  // --- Model & performance ---
  model:      { type: "hardcoded", supported: true, autocomplete: true, overridable: false, handler: "model", description: "Switch model" },
  fast:       { ...UNSUPPORTED_HARDCODED, description: "Toggle speed-optimized mode" },
  effort:     { ...UNSUPPORTED_HARDCODED, description: "Set thinking effort level" },
  advisor:    { ...UNSUPPORTED_HARDCODED, description: "Toggle advisor mode" },

  // --- Cost & usage ---
  cost:       { ...UNSUPPORTED_HARDCODED, description: "Token usage and cost estimate", message: "`/cost` is a Claude Code command for API users. Isomux uses subscription-based billing." },
  usage:      { ...UNSUPPORTED_HARDCODED, description: "Plan-level limits and rate limit status" },
  stats:      { ...UNSUPPORTED_HARDCODED, description: "Usage patterns over time" },
  "extra-usage": { ...UNSUPPORTED_HARDCODED, description: "Extra usage options" },
  "rate-limit-options": { ...UNSUPPORTED_HARDCODED, description: "Rate limit configuration" },

  // --- Code & file operations ---
  diff:       { ...UNSUPPORTED_HARDCODED, description: "Interactive diff of all changes" },
  rewind:     { ...UNSUPPORTED_HARDCODED, description: "Undo changes and revert conversation" },
  checkpoint: { ...UNSUPPORTED_HARDCODED, description: "Undo changes and revert conversation" },
  copy:       { ...UNSUPPORTED_HARDCODED, description: "Copy last response to clipboard" },
  files:      { ...UNSUPPORTED_HARDCODED, description: "List files in context" },
  "add-dir":  { ...UNSUPPORTED_HARDCODED, description: "Add additional working directories" },

  // --- Side channel ---
  btw:        { ...UNSUPPORTED_HARDCODED, description: "Ask without polluting main context" },

  // --- Configuration & management ---
  config:     { ...UNSUPPORTED_HARDCODED, description: "Open settings interface" },
  settings:   { ...UNSUPPORTED_HARDCODED, description: "Open settings interface" },
  hooks:      { ...UNSUPPORTED_HARDCODED, description: "Manage lifecycle hooks" },
  permissions: { ...UNSUPPORTED_HARDCODED, description: "Manage tool permissions" },
  keybindings: { ...UNSUPPORTED_HARDCODED, description: "Edit key bindings" },
  memory:     { ...UNSUPPORTED_HARDCODED, description: "View/edit persistent memory" },
  mcp:        { ...UNSUPPORTED_HARDCODED, description: "Manage MCP server connections" },
  ide:        { ...UNSUPPORTED_HARDCODED, description: "Manage IDE integrations" },
  agents:     { ...UNSUPPORTED_HARDCODED, description: "Manage custom subagents" },
  skills:     { ...UNSUPPORTED_HARDCODED, description: "List all available skills" },
  sandbox:    { ...UNSUPPORTED_HARDCODED, description: "Manage sandbox settings" },
  "privacy-settings": { ...UNSUPPORTED_HARDCODED, description: "Manage privacy settings" },
  theme:      { ...UNSUPPORTED_HARDCODED, description: "Change color theme" },
  color:      { ...UNSUPPORTED_HARDCODED, description: "Change color theme" },
  vim:        { ...UNSUPPORTED_HARDCODED, description: "Toggle vim keybindings" },
  "terminal-setup": { ...UNSUPPORTED_HARDCODED, description: "Configure terminal integration" },
  "reload-plugins": { ...UNSUPPORTED_HARDCODED, description: "Reload installed plugins", message: "To reload plugins, open the built-in terminal (click the terminal icon on the agent's desk), run `claude`, and type `/reload-plugins`." },

  // --- Background & system ---
  tasks:      { ...UNSUPPORTED_HARDCODED, description: "List/manage background tasks" },
  bashes:     { ...UNSUPPORTED_HARDCODED, description: "List/manage background tasks" },
  doctor:     { ...UNSUPPORTED_HARDCODED, description: "Check installation health" },
  feedback:   { ...UNSUPPORTED_HARDCODED, description: "Report bugs to Anthropic" },
  bug:        { ...UNSUPPORTED_HARDCODED, description: "Report bugs to Anthropic" },
  "release-notes": { ...UNSUPPORTED_HARDCODED, description: "View release notes" },
  heapdump:   { ...UNSUPPORTED_HARDCODED, description: "Dump heap for debugging" },
  status:     { ...UNSUPPORTED_HARDCODED, description: "Show system status" },
  tag:        { ...UNSUPPORTED_HARDCODED, description: "Tag current conversation" },
  init:       { ...UNSUPPORTED_HARDCODED, description: "Initialize Claude Code in a project" },
  "install-github-app": { ...UNSUPPORTED_HARDCODED, description: "Set up Claude GitHub PR review app" },
  pr_comments: { ...UNSUPPORTED_HARDCODED, description: "View PR comments" },

  // --- Desktop / mobile / remote ---
  desktop:    { ...UNSUPPORTED_HARDCODED, description: "Open desktop app" },
  mobile:     { ...UNSUPPORTED_HARDCODED, description: "Open mobile app" },
  chrome:     { ...UNSUPPORTED_HARDCODED, description: "Open Chrome extension" },
  session:    { ...UNSUPPORTED_HARDCODED, description: "Manage sessions" },
  teleport:   { ...UNSUPPORTED_HARDCODED, description: "Transfer session to another device" },
  "remote-env": { ...UNSUPPORTED_HARDCODED, description: "Configure remote environment" },

  // --- Misc ---
  exit:       { ...UNSUPPORTED_HARDCODED, description: "Exit Claude Code", message: "Use the Isomux UI to manage agents. `/exit` only works in the Claude Code CLI." },
  stickers:   { ...UNSUPPORTED_HARDCODED, description: "Fun stickers" },
  upgrade:    { ...UNSUPPORTED_HARDCODED, description: "Upgrade Claude Code" },
  plugin:     { ...UNSUPPORTED_HARDCODED, description: "Manage plugins", message: "Plugin management requires the Claude Code CLI directly.\n\nTo manage plugins:\n1. Open the built-in terminal (click the terminal icon on the agent's desk)\n2. Run `claude`\n3. Type `/plugin` to browse, install, enable, or disable plugins\n\nUseful commands:\n- `/plugin` — interactive plugin manager (browse, install, enable/disable)\n- `/plugin add <name>` — install a plugin by name\n- `/plugin marketplace add owner/repo` — add a community marketplace\n\nAfter installing a plugin, run `/reload-plugins` inside the Claude session to activate it." },

  // =========================================================================
  // Bundled skills (overridable — users can shadow with their own skill files)
  // =========================================================================
  batch:              { ...UNSUPPORTED_BUNDLED_SKILL, description: "Decompose into parallel worktree agents" },
  "claude-api":       { ...UNSUPPORTED_BUNDLED_SKILL, description: "Load API/SDK reference for detected language" },
  "claude-in-chrome": { ...UNSUPPORTED_BUNDLED_SKILL, description: "Automate Chrome browser interactions" },
  debug:              { ...UNSUPPORTED_BUNDLED_SKILL, description: "Diagnose session/tool issues from debug log" },
  "keybindings-help": { ...UNSUPPORTED_BUNDLED_SKILL, description: "Customize keyboard shortcuts" },
  loop:               { ...UNSUPPORTED_BUNDLED_SKILL, description: "Run a prompt on a recurring schedule" },
  "lorem-ipsum":      { ...UNSUPPORTED_BUNDLED_SKILL, description: "Generate placeholder text" },
  review:             { ...UNSUPPORTED_BUNDLED_SKILL, description: "Code review for bugs, logic, and edge cases" },
  schedule:           { ...UNSUPPORTED_BUNDLED_SKILL, description: "Create cron-scheduled remote agents" },
  "security-review":  { ...UNSUPPORTED_BUNDLED_SKILL, description: "Security-focused code review" },
  simplify:           { ...UNSUPPORTED_BUNDLED_SKILL, description: "Code cleanup and reuse analysis" },
  skillify:           { ...UNSUPPORTED_BUNDLED_SKILL, description: "Capture processes as reusable skills" },
  stuck:              { ...UNSUPPORTED_BUNDLED_SKILL, description: "Diagnose frozen/slow sessions" },
  ultrareview:        { ...UNSUPPORTED_BUNDLED_SKILL, description: "Ultra-thorough PR review" },
  "update-config":    { ...UNSUPPORTED_BUNDLED_SKILL, description: "Configure settings.json" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All command names that should appear in autocomplete from the config. */
export function autocompleteCommands(): { name: string; description?: string }[] {
  return Object.entries(commands)
    .filter(([, cfg]) => cfg.autocomplete)
    .map(([name, cfg]) => ({ name, description: cfg.description }));
}

/** Unsupported message for a command, with type-aware defaults. */
export function unsupportedMessage(name: string): string {
  const cfg = commands[name];
  const desc = cfg?.description ? ` (${cfg.description.toLowerCase()})` : "";
  if (cfg?.message) return cfg.message;
  if (!cfg) return `\`/${name}\` is not available in Isomux.`;
  if (cfg.type === "hardcoded") {
    return `\`/${name}\`${desc} is a Claude Code command, but it's not supported in Isomux.`;
  }
  if (cfg.type === "bundled-skill") {
    return `\`/${name}\`${desc} is a Claude Code bundled skill, but it's not supported in Isomux. You can override it by creating your own skill file.`;
  }
  return `\`/${name}\` is not available in Isomux.`;
}
