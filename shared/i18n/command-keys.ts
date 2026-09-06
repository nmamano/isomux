// The catalog key for every slash command's description, as one explicit
// table (internal-docs/i18n-loop.md, S7). Lives under shared/ because both
// readers need it: the server's /help (server/command-handlers.ts) renders the
// list for the user who typed it, and the UI's slash-command menu
// (ui/log-view/LogView.tsx) renders the same words in the reader's language.
//
// EXPLICIT, not derived. A key could be built from a command name by
// camel-casing it at call time, but then a renamed command would silently miss
// the catalog and fall back to printing its own key. Written out, a command
// with no key is a compile error here and a test failure in catalog.test.ts,
// which holds this table and the registry in server/commands.ts to exactly the
// same name set in both directions.
//
// Command NAMES are not in the catalog: they are what the user types
// (ruling 11). Only the words describing them are.
//
// A LEAF: types only, no runtime imports.

import type { MessageKey } from "./en.ts";

type DescriptionKey = Extract<MessageKey, `commands.${string}.description`>;
type UnsupportedMessageKey = Extract<MessageKey, `commands.${string}.message`>;

export const COMMAND_DESCRIPTION_KEYS = {
  "clear": "commands.clear.description",
  "context": "commands.context.description",
  "help": "commands.help.description",
  "resume": "commands.resume.description",
  "login": "commands.login.description",
  "logout": "commands.logout.description",
  "isomux-all-hands": "commands.isomuxAllHands.description",
  "isomux-system-prompt": "commands.isomuxSystemPrompt.description",
  "isomux-cronjob-system-prompt": "commands.isomuxCronjobSystemPrompt.description",
  "isomux-diff": "commands.isomuxDiff.description",
  "isomux-edit": "commands.isomuxEdit.description",
  "isomux-usage": "commands.isomuxUsage.description",
  "isomux-storage": "commands.isomuxStorage.description",
  "compact": "commands.compact.description",
  "branch": "commands.branch.description",
  "fork": "commands.fork.description",
  "export": "commands.export.description",
  "plan": "commands.plan.description",
  "rename": "commands.rename.description",
  "reset": "commands.reset.description",
  "new": "commands.new.description",
  "model": "commands.model.description",
  "fast": "commands.fast.description",
  "effort": "commands.effort.description",
  "advisor": "commands.advisor.description",
  "cost": "commands.cost.description",
  "usage": "commands.usage.description",
  "stats": "commands.stats.description",
  "extra-usage": "commands.extraUsage.description",
  "rate-limit-options": "commands.rateLimitOptions.description",
  "diff": "commands.diff.description",
  "rewind": "commands.rewind.description",
  "checkpoint": "commands.checkpoint.description",
  "copy": "commands.copy.description",
  "files": "commands.files.description",
  "add-dir": "commands.addDir.description",
  "btw": "commands.btw.description",
  "config": "commands.config.description",
  "settings": "commands.settings.description",
  "hooks": "commands.hooks.description",
  "permissions": "commands.permissions.description",
  "keybindings": "commands.keybindings.description",
  "memory": "commands.memory.description",
  "mcp": "commands.mcp.description",
  "ide": "commands.ide.description",
  "agents": "commands.agents.description",
  "skills": "commands.skills.description",
  "sandbox": "commands.sandbox.description",
  "privacy-settings": "commands.privacySettings.description",
  "theme": "commands.theme.description",
  "color": "commands.color.description",
  "vim": "commands.vim.description",
  "terminal-setup": "commands.terminalSetup.description",
  "reload-plugins": "commands.reloadPlugins.description",
  "tasks": "commands.tasks.description",
  "bashes": "commands.bashes.description",
  "doctor": "commands.doctor.description",
  "feedback": "commands.feedback.description",
  "bug": "commands.bug.description",
  "release-notes": "commands.releaseNotes.description",
  "heapdump": "commands.heapdump.description",
  "status": "commands.status.description",
  "tag": "commands.tag.description",
  "init": "commands.init.description",
  "install-github-app": "commands.installGithubApp.description",
  "pr_comments": "commands.prComments.description",
  "desktop": "commands.desktop.description",
  "mobile": "commands.mobile.description",
  "chrome": "commands.chrome.description",
  "session": "commands.session.description",
  "teleport": "commands.teleport.description",
  "remote-env": "commands.remoteEnv.description",
  "exit": "commands.exit.description",
  "stickers": "commands.stickers.description",
  "upgrade": "commands.upgrade.description",
  "plugin": "commands.plugin.description",
  "batch": "commands.batch.description",
  "claude-api": "commands.claudeApi.description",
  "claude-in-chrome": "commands.claudeInChrome.description",
  "debug": "commands.debug.description",
  "keybindings-help": "commands.keybindingsHelp.description",
  "loop": "commands.loop.description",
  "lorem-ipsum": "commands.loremIpsum.description",
  "review": "commands.review.description",
  "schedule": "commands.schedule.description",
  "security-review": "commands.securityReview.description",
  "simplify": "commands.simplify.description",
  "skillify": "commands.skillify.description",
  "stuck": "commands.stuck.description",
  "ultrareview": "commands.ultrareview.description",
  "update-config": "commands.updateConfig.description",
} as const satisfies Record<string, DescriptionKey>;

/** Every command name the catalog carries a description for. */
export type CatalogCommandName = keyof typeof COMMAND_DESCRIPTION_KEYS;

// The six unsupported commands whose refusal is written for them rather than
// taken from the type-aware default in unsupportedMessage(). Which commands
// have one is registry metadata (server/commands.ts keeps the flag); the prose
// itself is only ever in the catalog.
export const COMMAND_MESSAGE_KEYS = {
  "compact": "commands.compact.message",
  "cost": "commands.cost.message",
  "reload-plugins": "commands.reloadPlugins.message",
  "exit": "commands.exit.message",
  "plugin": "commands.plugin.message",
  "loop": "commands.loop.message",
} as const satisfies Record<string, UnsupportedMessageKey>;

export type CustomMessageCommandName = keyof typeof COMMAND_MESSAGE_KEYS;
