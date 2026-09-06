// Declarative registry of every known Claude Code command and bundled skill.
// Pure data - no handler logic lives here.
//
// Resolution logic lives in
// server/command-handlers.ts (handleSlashCommand).
// Last updated: 2026-03-31 (Claude Code ~1.0.x)
//
// The WORDS are not here. What a command does, and the custom refusal a few of
// them carry, live in the catalog under `commands.<name>.*` and are reached
// through the tables in shared/i18n/command-keys.ts, so /help and the UI menu
// can render them in the reader's language (internal-docs/i18n-loop.md, S7).
// This file keeps the structure a command has: which handler runs it, whether
// a skill may shadow it, whether it appears in autocomplete. Adding a command
// here without adding its description key fails catalog.test.ts.

import {
  COMMAND_DESCRIPTION_KEYS,
  COMMAND_MESSAGE_KEYS,
} from "../shared/i18n/command-keys.ts";
import { keyFrom } from "../shared/i18n/translate.ts";
import type { Translator } from "../shared/i18n/translate.ts";

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
  /**
   * Marks this entry as an alias of another command. The other command is
   * the canonical name; this one is a friendlier shorthand. /help groups
   * canonicals + their aliases so the user sees a single line per command
   * rather than one per name.
   */
  aliasFor?: string;
  /**
   * True for commands whose bare `/name` (no argument) is ALREADY a complete,
   * useful invocation: clicking them in the "Sk" popover EXECUTES the command
   * immediately instead of copying `/name ` into the composer. This covers
   * direct actions (/clear, /context), interactive pickers whose no-arg
   * behavior IS the intended action (/model, /effort, /resume open the picker),
   * and commands with a useful default when no arg is given (/diff diffs the
   * agent cwd - an OPTIONAL directory arg doesn't make the bare form
   * incomplete; users wanting one still type it via slash autocomplete). Left
   * false/absent when the bare invocation is NOT the intended action:
   * /isomux-edit needs a path, and /isomux-cronjob-system-prompt with no arg
   * only prints a usage/listing en route to the required selector. Only
   * meaningful for supported commands surfaced in autocomplete; skills never
   * carry it.
   */
  autoRun?: boolean;
};

// Shorthand for the common unsupported-hardcoded pattern
const UNSUPPORTED_HARDCODED: CommandConfig = {
  type: "hardcoded",
  supported: false,
  autocomplete: false,
  overridable: false,
};

// Shorthand for the common unsupported-bundled-skill pattern
const UNSUPPORTED_BUNDLED_SKILL: CommandConfig = {
  type: "bundled-skill",
  supported: false,
  autocomplete: false,
  overridable: true,
};

// The literal /plugin invocation its refusal quotes. Here rather than in the
// catalog because angle brackets in a catalog value parse as a tag pair.
const PLUGIN_ADD_COMMAND = "/plugin add <name>";

export const commands: Record<string, CommandConfig> = {
  clear: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "clear",
    autoRun: true,
  },
  context: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "context",
    autoRun: true,
  },
  help: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "help",
    autoRun: true,
  },
  resume: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "resume",
    // Interactive picker: takes no argument text, so auto-run opens the list.
    autoRun: true,
  },
  login: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "login",
    autoRun: true,
  },
  logout: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "logout",
    autoRun: true,
  },
  "isomux-all-hands": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxAllHands",
    autoRun: true,
  },
  "isomux-system-prompt": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxSystemPrompt",
    autoRun: true,
  },
  "isomux-cronjob-system-prompt": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxCronjobSystemPrompt",
  },
  "isomux-diff": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxDiff",
    // No-arg diffs the cwd - a complete, useful invocation. A directory arg is
    // optional and still reachable via slash autocomplete / manual entry.
    autoRun: true,
  },
  "isomux-edit": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxEdit",
  },
  "isomux-usage": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxUsage",
    autoRun: true,
  },
  "isomux-storage": {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxStorage",
    autoRun: true,
  },

  compact: {
    ...UNSUPPORTED_HARDCODED,
  },
  branch: {
    ...UNSUPPORTED_HARDCODED,
  },
  fork: {
    ...UNSUPPORTED_HARDCODED,
  },
  export: {
    ...UNSUPPORTED_HARDCODED,
  },
  plan: { ...UNSUPPORTED_HARDCODED },
  rename: { ...UNSUPPORTED_HARDCODED },
  reset: {
    type: "hardcoded",
    supported: true,
    autocomplete: false,
    overridable: false,
    handler: "clear",
  },
  new: {
    type: "hardcoded",
    supported: true,
    autocomplete: false,
    overridable: false,
    handler: "clear",
  },

  model: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "model",
    // Interactive picker: takes no argument text, so auto-run opens the list.
    autoRun: true,
  },
  fast: {
    ...UNSUPPORTED_HARDCODED,
  },
  effort: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "effort",
    // Interactive picker: takes no argument text, so auto-run opens the list.
    autoRun: true,
  },
  advisor: { ...UNSUPPORTED_HARDCODED },

  cost: {
    ...UNSUPPORTED_HARDCODED,
  },
  usage: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "usage",
    autoRun: true,
  },
  stats: { ...UNSUPPORTED_HARDCODED },
  "extra-usage": {
    ...UNSUPPORTED_HARDCODED,
  },
  "rate-limit-options": {
    ...UNSUPPORTED_HARDCODED,
  },

  diff: {
    type: "hardcoded",
    supported: true,
    autocomplete: true,
    overridable: false,
    handler: "isomuxDiff",
    aliasFor: "isomux-diff",
    // Mirror the canonical isomux-diff: no-arg diffs the cwd. Set explicitly on
    // both names so the alias carries its own autoRun through the wire.
    autoRun: true,
  },
  rewind: {
    ...UNSUPPORTED_HARDCODED,
  },
  checkpoint: {
    ...UNSUPPORTED_HARDCODED,
  },
  copy: {
    ...UNSUPPORTED_HARDCODED,
  },
  files: { ...UNSUPPORTED_HARDCODED },
  "add-dir": {
    ...UNSUPPORTED_HARDCODED,
  },

  btw: {
    ...UNSUPPORTED_HARDCODED,
  },

  config: { ...UNSUPPORTED_HARDCODED },
  settings: {
    ...UNSUPPORTED_HARDCODED,
  },
  hooks: { ...UNSUPPORTED_HARDCODED },
  permissions: {
    ...UNSUPPORTED_HARDCODED,
  },
  keybindings: { ...UNSUPPORTED_HARDCODED },
  memory: {
    ...UNSUPPORTED_HARDCODED,
  },
  mcp: {
    ...UNSUPPORTED_HARDCODED,
  },
  ide: { ...UNSUPPORTED_HARDCODED },
  agents: { ...UNSUPPORTED_HARDCODED },
  skills: {
    ...UNSUPPORTED_HARDCODED,
  },
  sandbox: { ...UNSUPPORTED_HARDCODED },
  "privacy-settings": {
    ...UNSUPPORTED_HARDCODED,
  },
  theme: { ...UNSUPPORTED_HARDCODED },
  color: { ...UNSUPPORTED_HARDCODED },
  vim: { ...UNSUPPORTED_HARDCODED },
  "terminal-setup": {
    ...UNSUPPORTED_HARDCODED,
  },
  "reload-plugins": {
    ...UNSUPPORTED_HARDCODED,
  },

  tasks: {
    ...UNSUPPORTED_HARDCODED,
  },
  bashes: {
    ...UNSUPPORTED_HARDCODED,
  },
  doctor: {
    ...UNSUPPORTED_HARDCODED,
  },
  feedback: {
    ...UNSUPPORTED_HARDCODED,
  },
  bug: { ...UNSUPPORTED_HARDCODED },
  "release-notes": {
    ...UNSUPPORTED_HARDCODED,
  },
  heapdump: {
    ...UNSUPPORTED_HARDCODED,
  },
  status: { ...UNSUPPORTED_HARDCODED },
  tag: { ...UNSUPPORTED_HARDCODED },
  init: {
    ...UNSUPPORTED_HARDCODED,
  },
  "install-github-app": {
    ...UNSUPPORTED_HARDCODED,
  },
  pr_comments: { ...UNSUPPORTED_HARDCODED },

  desktop: { ...UNSUPPORTED_HARDCODED },
  mobile: { ...UNSUPPORTED_HARDCODED },
  chrome: { ...UNSUPPORTED_HARDCODED },
  session: { ...UNSUPPORTED_HARDCODED },
  teleport: {
    ...UNSUPPORTED_HARDCODED,
  },
  "remote-env": {
    ...UNSUPPORTED_HARDCODED,
  },

  exit: {
    ...UNSUPPORTED_HARDCODED,
  },
  stickers: { ...UNSUPPORTED_HARDCODED },
  upgrade: { ...UNSUPPORTED_HARDCODED },
  plugin: {
    ...UNSUPPORTED_HARDCODED,
  },

  batch: {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  "claude-api": {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  "claude-in-chrome": {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  debug: {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  "keybindings-help": {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  loop: {
    ...UNSUPPORTED_BUNDLED_SKILL,
    // The user-visible string is fixed copy: /loop stays unsupported natively
    // and points users at isomux's own recurring-work primitives.
  },
  "lorem-ipsum": {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  review: {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  schedule: {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  "security-review": {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  simplify: {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  skillify: {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  stuck: {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  ultrareview: {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
  "update-config": {
    ...UNSUPPORTED_BUNDLED_SKILL,
  },
};

/**
 * All command names that should appear in autocomplete from the config.
 *
 * No description rides the wire: this list is broadcast per AGENT, not per
 * reader, so a description resolved here would be one language for everybody.
 * Each client words a command from the catalog by name instead. A SKILL's
 * description is user-authored data and still travels as delivered - it is on
 * the skills half of the same wire, not here.
 */
export function autocompleteCommands(): {
  name: string;
  aliasFor?: string;
  autoRun?: boolean;
}[] {
  return Object.entries(commands)
    .filter(([, cfg]) => cfg.autocomplete)
    .map(([name, cfg]) => ({
      name,
      ...(cfg.aliasFor ? { aliasFor: cfg.aliasFor } : {}),
      ...(cfg.autoRun ? { autoRun: true } : {}),
    }));
}

/**
 * The refusal for a command Isomux does not implement, in `t`'s language.
 *
 * A handful of commands carry their own wording (COMMAND_MESSAGE_KEYS); the
 * rest get the type-aware default, which names what the command would have
 * done. Every registry command has a description key, so the parenthetical is
 * always filled; a name the registry never had takes the last branch.
 *
 * `addCommand` is supplied for every key because only /plugin's message uses
 * it: its text shows `/plugin add <name>`, and a bare `<name>` inside a
 * catalog value would parse as an unclosed rich-text tag (ruling 19).
 */
export function unsupportedMessage(t: Translator["t"], name: string): string {
  // Own-property lookups throughout: `name` is whatever the user typed after
  // the slash, so "constructor" and "__proto__" reach here.
  const cfg = Object.hasOwn(commands, name) ? commands[name] : undefined;
  const messageKey = keyFrom(COMMAND_MESSAGE_KEYS, name);
  if (messageKey) return t(messageKey, { addCommand: PLUGIN_ADD_COMMAND });
  const descriptionKey = keyFrom(COMMAND_DESCRIPTION_KEYS, name);
  if (!cfg || !descriptionKey)
    return t("commands.unsupported.notAvailable", { name });
  const description = t(descriptionKey).toLowerCase();
  return cfg.type === "hardcoded"
    ? t("commands.unsupported.hardcoded", { name, description })
    : t("commands.unsupported.bundledSkill", { name, description });
}
