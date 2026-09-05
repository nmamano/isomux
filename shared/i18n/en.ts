// The English catalog: the typed source of truth for every string the office
// shows a person (internal-docs/i18n-loop.md, rulings 6 and 7).
//
// Keys name the surface and the meaning ("preferences.save"), never the English
// text, so a wording change never renames a key. English copy is frozen: moving
// a string in here never changes it. `as const` keeps every value a literal
// type, which is what lets translate.ts derive the {placeholder} names a key
// takes and check them at the call site.
//
// Plurals are explicit pairs, "<key>.one" and "<key>.other", picked with
// Intl.PluralRules; Spanish and Catalan need no other category.
//
// A string shared verbatim by more than one surface lives under "common.*"
// (ruling 15). A sentence with an inline code span, link or emphasis keeps its
// span as a tag pair ("<code>…</code>") and is read through rich() in
// ui/i18n.tsx, never through t() (ruling 16).
//
// es.ts and ca.ts are typed as complete records over these keys: a key missing
// there is a compile error, and catalog.test.ts proves the rest (no empty
// value, the same placeholders and tags as English).

export const en = {
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.saved": "Saved",
  "common.cancel": "Cancel",
  "common.loading": "Loading…",
  "common.loadingMemory": "Loading memory…",
  "common.memory": "Memory",
  "common.memoryEditorHint":
    "This editor rewrites the file exactly as shown. Use one memory per line.",
  "common.saveFailed": "Save failed",
  "common.nextConversation": "Changes take effect on next conversation.",
  "common.settings": "Settings",
  "common.theme": "Theme",
  "common.preferences": "Preferences",
  "common.checking": "Checking…",
  "common.copied": "Copied",
  "common.copy": "Copy",
  "common.device": "Device",
  "common.discard": "Discard",
  "common.name": "Name",
  "common.noRooms": "No rooms yet.",
  "common.prefix": "Prefix",
  "common.revoke": "Revoke",
  "common.role": "Role",
  "common.rooms": "Rooms",
  "common.signOut": "Sign out",
  "common.user": "User",

  "nav.tasks": "Tasks",
  "nav.schedules": "Schedules",
  "nav.apps": "Apps",
  "nav.changeTheme": "Change theme",
  "nav.showAgentList": "Show agent list",
  "nav.showFloorView": "Show floor view",

  "preferences.intro":
    "These follow you to every device you sign in from. Settings that are about this browser in particular live under My devices.",
  "preferences.language": "Language",
  "preferences.languageHint":
    "The language your agents write in, and the language your voice input and playback use. Agents pick it up on their next conversation. The rest of the interface stays in English for now.",
  "preferences.saved": "Saved.",
  "preferences.saveFailed": "Could not save",

  // The settings page shell: header, sidebar, roster, footer.
  "settings.backToOffice": "Back to office",
  "settings.selectHint": "Select a setting from the list",
  "settings.profilesNote":
    "User profiles are stored on the server. Your notifications and credentials follow you across devices.",
  "settings.signOutHint": "End this device's session",
  "settings.you": "(you)",
  "settings.sidebar.office": "Office",
  "settings.sidebar.access": "Access",
  "settings.sidebar.invites": "Invites",
  "settings.sidebar.sessions": "Sessions",
  "settings.sidebar.connectionsOffice": "Office-wide connections",
  "settings.sidebar.usage": "Usage",
  "settings.sidebar.storage": "Storage",
  "settings.sidebar.updates": "Updates",
  "settings.sidebar.you": "You",
  "settings.sidebar.profile": "Profile",
  "settings.sidebar.connectionsPersonal": "Individual connections",
  "settings.sidebar.apiTokens": "API tokens",
  "settings.sidebar.signInLinks": "Sign-in links",
  "settings.sidebar.deviceLabel": "Device label",
  "settings.sidebar.members": "Members",
  "settings.members.editHint":
    "Only the user themselves and owners can edit a user",
  "settings.members.onlineNow": "Online now",
  "settings.members.online": "online",
  "settings.members.onlineSessions.one": "online · {count} session",
  "settings.members.onlineSessions.other": "online · {count} sessions",
  "settings.members.lastSeen": "last seen {when}",
  "settings.role.owner": "owner",
  "settings.role.member": "member",
  "settings.role.ownerHint":
    "Owner - can invite users, revoke sessions, and set per-user room access",
  "settings.role.memberHint":
    "Member - can act in rooms the owner allowed; can't invite or revoke",

  // The user editor (the Profile row and the roster rows).
  "settings.profile.identity": "Identity",
  "settings.profile.displayName": "Display Name",
  "settings.profile.accessHint":
    "Access: rooms this user can see and act in (owner-managed).",
  "settings.profile.viewHint":
    "Displayed: which of your accessible rooms appear in your own view. Notifications: sound when an agent in that room finishes. A room must be displayed to notify.",
  "settings.profile.roomColumn": "Room",
  "settings.profile.accessColumn": "Access",
  "settings.profile.displayedColumn": "Displayed",
  "settings.profile.notificationsColumn": "Notifications",
  "settings.profile.accessTo": "Access to {room}",
  "settings.profile.display": "Display {room}",
  "settings.profile.notificationsFor": "Notifications for {room}",
  "settings.profile.agentContext": "Agent Context",
  "settings.profile.profilePrompt": "Profile Prompt",
  "settings.profile.profilePromptHint":
    "(auto-injected into the system prompt of agents you own; other users' agents can look it up if they need context on you)",
  "settings.profile.profilePromptTitle": "{user} · Profile Prompt",
  "settings.profile.profilePromptExpandedHint":
    "Auto-injected into the system prompt of agents this user owns; other users' agents can look it up if they need context on them.",
  "settings.profile.profilePromptPlaceholder":
    "A few notes for agents about who you are, your role, how you like to collaborate…",
  "settings.profile.memoryHint":
    "(durable boss-scoped facts for this user; rewrites the file exactly as shown - one memory per line; {size} / {cap})",
  "settings.profile.memoryTitle": "{user} · Memory",
  "settings.profile.memoryPlaceholder": "Some memory relevant to this user",
  "settings.profile.appearance": "Appearance",
  "settings.profile.avatar": "Avatar",
  "settings.profile.avatarHint":
    "(your ghost in the office scene; other users see it next to the agent you're viewing)",
  "settings.profile.discardPrompt": "Discard unsaved changes?",
  "settings.profile.delete": "Delete",
  "settings.profile.deleteHint": "Delete this user",
  "settings.profile.confirmDelete": "Confirm?",
  "settings.profile.deleteFailed": "Delete failed",
  "settings.profile.roomListFailed":
    "Could not confirm your room list; Displayed not saved.",

  "settings.office.title": "Office Settings",
  "settings.office.intro":
    "The framed sign on the office wall opens this page.",
  "settings.office.viewOnly":
    "View only. Only office owners can edit office-wide settings.",
  "settings.office.name": "Office Name",
  "settings.office.nameHint": "(optional, shown in browser tab)",
  "settings.office.namePlaceholder": "Nil's Office",
  "settings.office.rules": "Rules",
  "settings.office.rulesHint": "(system prompt for all agents)",
  "settings.office.rulesTitle": "Office Rules",
  "settings.office.rulesExpandedHint":
    "System prompt for all agents. Changes take effect on next conversation.",
  "settings.office.rulesPlaceholder":
    "e.g. Always write tests. Use TypeScript. Be concise.",
  "settings.office.memoryHint":
    "(durable office-wide facts; raw lines; {size} / {cap})",
  "settings.office.memoryTitle": "Office Memory",
  "settings.office.memoryPlaceholder":
    "Some memory relevant to the entire office",
  "settings.office.reloadFailed":
    "Saved, but this page could not reload the office. Select another row and come back to keep editing.",
  "settings.office.conflict":
    "Office settings changed somewhere else since this page loaded. Select another row and come back to load the latest.",
  "settings.office.loadedVariables.one": "Loaded {count} variable.",
  "settings.office.loadedVariables.other": "Loaded {count} variables.",
  "settings.office.discardConfirm": "Discard unsaved changes to the office?",

  "settings.room.title": "{room} · Settings",
  "settings.room.intro": "Double-click a room tab to come straight here.",
  "settings.room.namePlaceholder": "Room name",
  "settings.room.prompt": "Room Prompt",
  "settings.room.promptHint": "(optional, appended after office prompt)",
  "settings.room.promptTitle": "{room} · Room Prompt",
  "settings.room.promptPlaceholder":
    "e.g. You're in the Marketing room. Match our brand voice.",
  "settings.room.promptNote":
    "Changes take effect on next conversation. Set environment variables under Office-wide or Individual connections.",
  "settings.room.memoryHint":
    "(durable facts for this room; raw lines; {size} / {cap})",
  "settings.room.memoryTitle": "{room} · Memory",
  "settings.room.memoryPlaceholder": "Some memory relevant to this room",
  "settings.room.reloadFailed":
    "Saved, but this page could not reload the room. Select another row and come back to keep editing.",
  "settings.room.conflict":
    "Room settings changed somewhere else since this page loaded. Select another row and come back to load the latest.",
  "settings.room.deleteEmpty": "Delete empty room",
  "settings.room.discardConfirm": "Discard unsaved changes to this room?",

  "settings.theme.intro":
    "Stored in this browser. You can also click the office window to walk through the themes without opening this page.",

  "settings.device.intro":
    'Stored in this browser. Tells agents which device you are on (for example "Phone" against "Laptop") so they can adjust their replies.',
  "settings.device.label": "Device Label",
  "settings.device.optional": "(optional)",
  "settings.device.placeholder": "Phone, Laptop, …",
  "settings.device.discardConfirm":
    "Discard unsaved changes to the device label?",

  "settings.devices.title": "My devices",
  "settings.devices.outstandingLinks": "Outstanding device links",
  "settings.devices.activeSessions": "My active sessions",
  "settings.devices.generateHint":
    "Generate a single-use link to sign another of your devices into your account. The link expires in 1 hour; generating a new one replaces the previous.",
  "settings.devices.generateWarning":
    "Anyone with the link can sign in as you until it expires or is used - treat it like a one-time password and only open it on your own device.",
  "settings.devices.generating": "Generating…",
  "settings.devices.generate": "Generate device link",
  "settings.devices.generateFailed": "Failed to generate device link",

  "settings.update.newRelease": "New Release Available",
  "settings.update.upToDateTitle": "Up to date",
  "settings.update.upToDate": "This office is up to date.",
  "settings.update.releaseNotesParen": "(release notes)",
  "settings.update.githubParen": "(GitHub)",
  "settings.update.toUpdate": "To update:",
  "settings.update.stepPull": "Pull the latest changes",
  "settings.update.stepInstall": "Run <code>bun install</code>",
  "settings.update.stepRestart":
    "Restart isomux for the update to take effect. Dev: <code>bun run dev</code>. User service: <code>systemctl --user restart isomux</code>. System service: <code>sudo systemctl restart isomux</code>.",
  "settings.update.tip":
    "Tip: click the copy button to copy this notice to clipboard, then ask any agent to take care of it.",
  "settings.update.requested":
    "Update requested. The server will restart shortly and this page will reconnect. If nothing happens after a few minutes, check the updater's status file on the server.",
  "settings.update.close": "Close",
  "settings.update.runningOn": "You are on <code>{version}</code>",
  "settings.update.unknownVersion": "an unknown version",
  "settings.update.latestRelease":
    "Latest release: <code>{tag}</code>{published}",
  "settings.update.releaseNotes": "release notes",
  "settings.update.restartWarning":
    "Updating restarts the server, interrupting every agent.",
  "settings.update.busyNone": "No agents are mid-task right now.",
  "settings.update.busy.one": "{count} agent is mid-task right now.",
  "settings.update.busy.other": "{count} agents are mid-task right now.",
  "settings.update.busyUnavailable":
    "The busy-agent count is unavailable right now.",
  "settings.update.ownerOnly": "An office owner can apply it from this dialog.",
  "settings.update.updateNow": "Update now",
  "settings.update.updateNowBusy": "Update now ({count} busy)",
  "settings.update.updating": "Updating…",
  "settings.update.gotIt": "Got it",

  "settings.usage.title": "Office Usage",
  "settings.usage.intro":
    "Subscription plan limits are not shown here. This page reports token usage and estimated cost recorded by Isomux.",
  "settings.usage.scoped":
    "Scoped to the rooms you can access. Schedule usage is not included.",
  "settings.usage.loadFailed": "Could not load usage.",
  "settings.usage.agents": "Agent usage",
  "settings.usage.agentColumn": "Agent",
  "settings.usage.rooms": "Per-room usage",
  "settings.usage.roomsNote":
    "Killed agents contribute to the room they were last in.",
  "settings.usage.roomColumn": "Room",
  "settings.usage.deleted": "deleted",
  "settings.usage.schedules": "Per-schedule usage",
  "settings.usage.scheduleColumn": "Schedule",
  "settings.usage.total": "Total",
  "settings.usage.officeTotal": "Office total",
  "settings.usage.inSession": "In (sess)",
  "settings.usage.outSession": "Out (sess)",
  "settings.usage.costSession": "$ (sess)",
  "settings.usage.inLifetime": "In (life)",
  "settings.usage.outLifetime": "Out (life)",
  "settings.usage.costLifetime": "$ (life)",
  "settings.usage.cacheHit": "{count} ({hit}% hit)",

  "settings.storage.title": "Office Storage",
  "settings.storage.category.transcripts": "Conversation transcripts",
  "settings.storage.category.attachments": "Chat attachments",
  "settings.storage.category.sessionMetadata": "Session metadata",
  "settings.storage.category.codexHome": "Codex home",
  "settings.storage.category.providerHomes": "Personal provider homes",
  "settings.storage.category.cronjobs": "Schedule history",
  "settings.storage.category.otherState": "Everything else",
  "settings.storage.category.backups": "Backups",
  "settings.storage.category.updateSnapshots": "Update snapshots",
  "settings.storage.skip.tooRecent": "newer than the age limit",
  "settings.storage.skip.keepNewest": "among the newest kept for their agent",
  "settings.storage.skip.activeSession":
    "belongs to a conversation that is still live",
  "settings.storage.skip.forkAncestor":
    "another conversation was forked from it",
  "settings.storage.skip.referenced":
    "still shown in a conversation you can read",
  "settings.storage.skip.queueStateUnknown":
    "waiting on a message queue that could not be read",
  "settings.storage.measureFailed": "Could not measure storage.",
  "settings.storage.previewFailed": "The prune request failed.",
  "settings.storage.deleteFailed": "The delete request failed.",
  "settings.storage.deleteDidNotRun":
    "The delete did not run. Nothing was removed.",
  "settings.storage.leaveConfirm":
    "A cleanup is still running. If you leave now you lose the only report of what it deleted. Leave anyway?",
  "settings.storage.deleteSection": "Delete old files",
  "settings.storage.deleteWarningLead":
    "This permanently deletes files from this machine.",
  "settings.storage.deleteWarningBody":
    "There is no undo and no trash. Old conversations and attachments are only ever deleted when you run this cleanup.",
  "settings.storage.whatToDelete": "What to delete",
  "settings.storage.olderThan": "Older than",
  "settings.storage.daysHint": "days. Anything touched more recently is kept.",
  "settings.storage.keepPerAgent": "Always keep, per agent",
  "settings.storage.keepHint":
    "newest conversations, however old they are. 0 spares none on that basis.",
  "settings.storage.preview": "Preview what would be deleted",
  "settings.storage.measuring": "Measuring…",
  "settings.storage.onDisk": "What is on disk",
  "settings.storage.totalSplit":
    "<strong>{total} total</strong> - {state} of office state, plus {outside} outside it.",
  "settings.storage.totalAllState":
    "<strong>{total} total</strong>, all of it office state.",
  "settings.storage.measured": "Measured {when}.",
  "settings.storage.totalOfficeState": "Total office state",
  "settings.storage.outsideOfficeState": "Outside office state",
  "settings.storage.none": "none",
  "settings.storage.outsideNote":
    "Backups and update snapshots sit outside the office state directory, so they are listed after its subtotal. “none” means that location is not set up on this machine.",
  "settings.storage.backupUnavailable": "Backup status unavailable.",
  "settings.storage.noBackupYet": "No backup has run yet.",
  "settings.storage.lastBackupOk": "Last backup {when}, successful.",
  "settings.storage.lastBackupFailed": "Last backup {when} FAILED.",
  "settings.storage.lastBackupFailedWith": "Last backup {when} FAILED: {error}",
  "settings.storage.backupKeeping":
    "Keeping {retention} in <code>{destDir}</code>.",
  "settings.storage.planCount":
    "{count} {target} would be deleted, freeing {size}.",
  "settings.storage.planEmpty":
    "Nothing matches. No {target} are old enough to delete.",
  "settings.storage.planPreviewNote":
    "Nothing has been deleted yet - this is a preview.",
  "settings.storage.skippedRow": "{count} kept ({size}): {reason}",
  "settings.storage.sampleRow": "{path} - {size}, {age}d old",
  "settings.storage.sampleMore": "…and {count} more.",
  "settings.storage.queueUnreadable":
    "Isomux could not read the pending-message queue, so it cannot tell which attachments are still owed to messages that have not been delivered. Nothing will be deleted until that is readable again.",
  "settings.storage.deleteCount": "Delete {count} {target} permanently",
  "settings.storage.cannotUndo": "This cannot be undone.",
  "settings.storage.confirmBody":
    "The preview found {size} of {target} to erase from this machine. A backup may contain another copy, if one ran after these files were written. Isomux scans again before deleting. Files that no longer match or fail a safety check are kept, so the final count may differ from this preview.",
  "settings.storage.confirmPlaceholder": "Type DELETE to confirm",
  "settings.storage.deleting": "Deleting…",
  "settings.storage.deletePermanently": "Delete permanently",
  "settings.storage.aborted": "Stopped before deleting anything: {reason}",
  "settings.storage.deletedResult": "Deleted {count} files, freeing {size}.",
  "settings.storage.refused":
    "{count} could not be removed and were left alone.",

  // Shared building blocks of the access panes (access-shared.tsx): the list
  // sections, the minted-invite box, the blocked-revoke banner. The time values
  // beside them come from shared/i18n/time.ts, not from here.
  "settings.access.none": "None.",
  "settings.access.expired": "expired",
  "settings.access.localTime": "{time} local",
  "settings.access.inviteUrl": "Invite URL",
  "settings.access.copyUrl": "Copy URL",
  "settings.access.urlCopied": "Copied!",
  "settings.access.clipboardBlocked":
    "Clipboard blocked. The URL above is selected - copy it manually.",
  "settings.access.sendUrl":
    "Send this URL to the invitee. It's one-time: opening it on their device signs them in. The URL is shown once - copy it now.",
  "settings.access.dismiss": "Dismiss",

  "settings.invites.intro":
    "Add a new member or owner: issue an invite URL and send it to them out-of-band. Opening it creates their account and signs that device in. For extra devices on an existing account, each user generates their own device link from <i>My devices</i>.",
  "settings.invites.issueFor": "Issue invite for…",
  "settings.invites.namePlaceholder": "New username (e.g. Marc)",
  "settings.invites.existing":
    "<b>{name}</b> already exists, so no invite is needed: to sign in another device, {name} can generate a device link from <i>My devices</i> in their own settings - or you can mint them a recovery link below.",
  "settings.invites.grantRoom": "Grant access to {room}",
  "settings.invites.roomsHint":
    "The invitee lands with access to the checked rooms. Leave all unchecked to grant access later from their user settings.",
  "settings.invites.expiryHint":
    "Invite link expires 24h after issuing if unused. Accepted sessions last up to 1 year (revocable from the Sessions section any time).",
  "settings.invites.minting": "Minting…",
  "settings.invites.issue": "Issue invite",
  "settings.invites.mintFailed": "Failed to mint invite",
  "settings.invites.recovery": "Recovery",
  "settings.invites.recoveryHint":
    "Help an existing user get back in. Device links are self-service, but someone signed out of every device can't mint their own - pick them here and send the link out-of-band. It expires in 24h; minting a new one replaces their previous link.",
  "settings.invites.selectUser": "Select a user…",
  "settings.invites.mintRecovery": "Mint recovery link",
  "settings.invites.recoveryFailed": "Failed to mint recovery link",
  "settings.invites.outstanding": "Outstanding invites",
  "settings.invites.columnFor": "For",
  "settings.invites.columnExpires": "Expires",
  "settings.invites.bootstrap": "(bootstrap)",

  "settings.sessions.intro":
    "Devices signed into this office, across all users. Revoking a session signs that device out. New people get an invite from the Invites section; existing users add devices themselves from <i>My devices</i>.",
  "settings.sessions.columnLastSeen": "Last seen",
  "settings.sessions.columnCreated": "Created",
  "settings.sessions.currentSession": "Current session",
  "settings.sessions.currentSessionHint":
    "Use Sign out at the bottom of the sidebar to end your current session.",
  "settings.sessions.expiryInactivity": "Expires after inactivity",
  "settings.sessions.expiryLatest": "Expires at the latest",

  "settings.externalAccess.intro":
    "Control whether this office is reachable from outside the host machine. Invite links and signed-in devices live in the Invites and Sessions sections.",
  "settings.externalAccess.title": "External access",
  "settings.externalAccess.loopback":
    "Currently loopback-only. The office is reachable from this machine, or from other machines via an SSH tunnel.",
  "settings.externalAccess.external":
    "Currently listening externally. The office is reachable from anywhere the public URL resolves.",
  "settings.externalAccess.enable": "Enable external access",
  "settings.externalAccess.publicUrl": "Public URL",
  "settings.externalAccess.urlHint":
    "Pattern: {pattern} (the address you'll open from your laptop / phone). Saving doesn't change the running server's bind on its own - restart isomux to apply.",
  "settings.externalAccess.envInvalid":
    "Note: <code>ISOMUX_PUBLIC_ORIGIN</code> is set in the environment but not a valid public origin, so the server ignores it. Remove it from your env file or set it to <code>{pattern}</code> or <code>{localhost}</code>.",
  "settings.externalAccess.envMatches":
    "Note: <code>ISOMUX_PUBLIC_ORIGIN={origin}</code> is set in the environment and matches this Public URL. The env var is deprecated - remove it from your env file once this office-config value is saved.",
  "settings.externalAccess.envConflict":
    "Note: <code>ISOMUX_PUBLIC_ORIGIN={origin}</code> is set in the environment. After restart it would override any different value saved here, so the save will be refused until you either match this URL to the env value or remove the env var from your service environment.",
  "settings.externalAccess.discardPrompt":
    "Discard unsaved external-access changes?",
  "settings.externalAccess.updateFailed": "Failed to update settings",
  "settings.externalAccess.restartNote":
    "Saved. Restart isomux for the new bind to take effect. User service: <code>systemctl --user restart isomux</code>. System service: <code>sudo systemctl restart isomux</code>.",
  "settings.externalAccess.signInAfterRestart":
    "After the restart, open this URL on whichever device you want to use from the public address. (It expires 1 hour after minting.)",

  "settings.apiTokens.intro":
    "Drive your office from scripts and automations, and read the replies your agents send back. A token has your own capabilities, except changing who can get into the office. See the <link>Developer API guide</link> for everything a token can do.",
  "settings.apiTokens.howToUse": "How to use",
  "settings.apiTokens.namePlaceholder": "Laptop script",
  "settings.apiTokens.expiresAfter": "Expires after",
  "settings.apiTokens.unlimited": "Unlimited",
  "settings.apiTokens.days": "{count} days",
  "settings.apiTokens.creating": "Creating…",
  "settings.apiTokens.create": "Create token",
  "settings.apiTokens.copyNow": "Copy this token now",
  "settings.apiTokens.shownOnce": "It will not be shown again.",
  "settings.apiTokens.empty": "No API tokens.",
  "settings.apiTokens.neverExpires": "never expires",
  "settings.apiTokens.expiresOn": "expires {date}",
  "settings.apiTokens.lastRequest": "Last authenticated request: {when}",
  "settings.apiTokens.about": "about {date}",
  "settings.apiTokens.never": "never",
  "settings.apiTokens.loadFailed": "Failed to load API tokens",
  "settings.apiTokens.createFailed": "Failed to create API token",
  "settings.apiTokens.revokeFailed": "Failed to revoke API token",

  "settings.connections.officeIntro":
    "The accounts and variables that every agent in this office uses. The provider stores the credentials, not us.",
  "settings.connections.personalIntro":
    "The accounts and variables that the agents you spawn use. They override the office ones. The provider stores the credentials, not us.",
  "settings.connections.refresh": "Refresh",
  "settings.connections.refreshing": "Refreshing…",
  "settings.connections.checkFailed": "Could not check provider accounts.",
  "settings.connections.envTitle": "Environment variables",
  "settings.connections.officeVars": "Variables for every agent in this office",
  "settings.connections.officeVarsHint":
    "These variables load for every agent unless a user variable overrides them.",
  "settings.connections.ownerManaged":
    "Office-wide variables are managed by an office owner.",
  "settings.connections.personalVars": "Variables for agents I spawn",
  "settings.connections.personalVarsHint":
    "These variables load for agents you spawn and override office-wide variables.",
  "settings.connections.providerKeyNote":
    "Add <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, or <code>OPENCODE_API_KEY</code> to use provider API keys. Other per-user variables work the same way, for example, each member can set <code>GH_TOKEN</code> so their agents use their own GitHub credentials. Then <code>/clear</code> agents to apply changes.",
  "settings.connections.crossLinkFromOffice":
    "Your own sign-ins and variables, which override these, are under <link>You → Individual connections</link>.",
  "settings.connections.crossLinkFromPersonal":
    "The office-wide sign-ins and variables these override are under <link>Office → Office-wide connections</link>.",

  "settings.signIn.apiKeyNote":
    "Do you want to use an API token? See Settings → You → Individual connections.",
  "settings.signIn.scopeOffice":
    "Office-wide: sign in for every agent in this office",
  "settings.signIn.scopePersonal": "Individual: sign in for agents I spawn",
  "settings.signIn.officeHint":
    "This subscription is used for every agent in the office except for agents spawned by an office member who has set up <link>Individual connections</link>.",
  "settings.signIn.personalHint": "Use a separate account for your agents.",
  "settings.signIn.status": "Status:",
  "settings.signIn.checking": "Checking connection…",
  "settings.signIn.waiting": "Waiting for provider…",
  "settings.signIn.connectedAs": "Connected as {account}",
  "settings.signIn.connected": "Connected",
  "settings.signIn.unavailable": "Connection unavailable",
  "settings.signIn.notConnected": "Not connected",
  "settings.signIn.startFailed": "Could not start {provider} sign-in.",
  "settings.signIn.submitFailed": "Could not submit the Claude code.",
  "settings.signIn.cancelFailed": "Could not cancel sign-in.",
  "settings.signIn.signOutFailed": "Could not sign out {provider}.",
  "settings.signIn.externalWarning":
    "This signs out {provider} in this machine, even outside the office.",
  "settings.signIn.directoryWarning":
    "This removes the sign-in from the account directory you chose.",
  "settings.signIn.pasteCode": "Paste the code from Claude:",
  "settings.signIn.submitCode": "Submit code",
  "settings.signIn.cancelSignIn": "Cancel sign-in",
  "settings.signIn.signingIn": "Signing in…",
  "settings.signIn.signIn": "Sign in",
  "settings.signIn.codexHint":
    "Signing in gives you a one-time code to enter on OpenAI's page. The page opens in a new tab; you can also open it on any other device.",
  "settings.signIn.claudeHint":
    "Claude opens in your browser. After you sign in, paste the code here.",
  "settings.signIn.linkNotOpen": "Link didn't open?",
  "settings.signIn.linkCopied": "Link copied",
  "settings.signIn.copyLink": "Copy sign-in link",
  "settings.signIn.enterCode": "Enter this one-time code on the OpenAI page:",
  "settings.signIn.signOutDialog": "Sign out {provider}",
  "settings.signIn.signingOut": "Signing out…",
  "settings.signIn.confirmSignOut": "Confirm sign out",
  "settings.signIn.connectedStart":
    "Connected. Start a new conversation to use this account.",
  "settings.signIn.startConversation": "Start a new conversation",

  "settings.env.loadFailed": "Could not load variables",
  "settings.env.saveFailed": "Could not save variables",
  "settings.env.loadingVariables": "Loading variables…",
  "settings.env.variableName": "Variable name",
  "settings.env.valueLabel": "{name} value",
  "settings.env.variable": "Variable",
  "settings.env.valuePlaceholder": "Value",
  "settings.env.remove": "Remove",
  "settings.env.add": "Add variable",
  "settings.env.hideValues": "Hide values",
  "settings.env.showValues": "Show values",
  "settings.env.save": "Save variables",
  "settings.env.saved": "Variables saved",
  "settings.env.duplicate": "Variable names must be unique.",

  "settings.memberConnections.title": "Individual Connections",
  "settings.memberConnections.hint":
    "Variables this user set for their own agents. Names only - values stay private.",
  "settings.memberConnections.loadFailed": "Could not load variables.",
  "settings.memberConnections.empty": "No variables.",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

/** A complete translation: every English key, each with a string. */
export type Catalog = Record<MessageKey, string>;
