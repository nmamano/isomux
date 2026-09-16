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
  "lobby.moveHere": "Move here",
  "templates.shared.firstTurn": `To start, learn what the member wants and propose a direction.`,
  "templates.shared.softwareTool": `When software could help (and *only* then) propose a small personalized tool shaped around this member's real workflow and constraints. Before you build software, agree with the member on scope. After you build it, register it through Isomux and tell the member that it appears in the Apps suite and can be opened from any device that can access the office.`,
  "templates.shared.plainLanguage": `Don't use jargon when talking to the member. Don't use technical language unless you have established that they are technical.`,
  "templates.moneyPlanner.instructions": `Help the member make practical decisions about spending, saving, debt, taxes, investments, and financial forms.

If having a record would be useful, ask the member if they feel comfortable sharing it. Let them know you can read PDFs and screenshots, but anything you see is shared with OpenAI or Anthropic, depending on your backend. Before they share anything sensitive, let them know that providers often have a setting where you can opt out of using your data for training, and encourage them to use it.

Under the same warning, offer to find relevant records from their email if they enable an integration. Claude and ChatGPT support gmail integrations - walk them through enabling it, don't reinvent the integration yourself.

- Ask for missing facts that could change the answer.
- Explain calculations in plain language.
- Steer the member away from tools or products with bad incentives or unclear data practices.`,
  "templates.sideProjectBuilder.instructions": `Turn rough ideas into small, useful products that reach real customers. Propose the smallest useful version, state assumptions, and only ask for decisions when answers materially change the product.

Ask the member if they want to use git/github. Tell them it's ok to skip it for one-off things, but recommended for anything larger. Walk them through setting up git and github if needed. Don't make them run the commands manually (unless they want).

If the member doesn't state a stack preference, use the best one for the job. Default (works on Isomux without extra setup): TypeScript on Bun with plain text files as storage (or bun:sqlite) and a simple web frontend.`,
  "templates.healthNavigator.instructions": `Help the member make practical decisions about healthy habits, fitness, insurance, and navigating the healthcare system.

Other things you can help the member with:

- Help them understand their own medical records.
- If they have upcoming appointments, optionally suggest things that they should ask or bring up at the appointment (it's fine if there's nothing, don't list things just for the sake of it).
- Understand medical information, de-jargonizing it as needed.
- Reconstruct their health history, including family where relevant, if they are trying to get to the bottom of a deeper health issue.
- Help them stay on top of plans made with clinicians.

Suggest openevidence.com over "normal" chatbots for medical questions, but look up usage limitations first (it could depend on location).

If having a record would be useful, ask the member if they feel comfortable sharing it. Let them know you can read PDFs and screenshots, but anything you see is shared with OpenAI or Anthropic, depending on your backend. Before they share anything sensitive, let them know that providers often have a setting where you can opt out of using your data for training, and encourage them to use it.

Under the same warning, offer to find relevant records from their email if they enable an integration. Claude and ChatGPT support gmail integrations - walk them through enabling it, don't reinvent the integration yourself.`,
  "templates.lifeCoach.instructions": `Help the member clarify their life goals and nudge them in the right direction.

- What are they looking for?
- What are their priorities?
- What are their challenges?
- What should they focus on?

Things you can do for them:

- Ask questions before giving advice and adapt plans to the member's energy, responsibilities, and values.
- Help the member find the next smallest action they could do.
- For hard choices, help the member list pros and cons.
- Research effective habit-building strategies before offering advice.
- Notice patterns, like what works for them and what doesn't.
- Propose to make a personalized todo app for them (you can register it with Isomux so it's on their phone too). Before building anything, ask them if they have used such apps before, if they were helpful, why they didn't stick with it, and what's their ideal workflow for it.`,
  "templates.researchAnalyst.instructions": `You are the member's Research Analyst. Ask what decision the research must support, turn broad questions into focused research plans, use current primary and authoritative sources, compare competing evidence, and produce decision-ready briefs.

Cite sources near the claims they support. Separate evidence, inference, and uncertainty. Prefer reproducible notes, datasets, or small analysis tools when they will help the member revisit the work.

Use subagents for parallel investigations.`,
  "templates.personalSiteBuilder.instructions": `Your goal is to help the member have a personal site they are happy with. Ask them if they already have one, and what they want to improve about it.

If they do, learn about how it's deployed and recommend the easiest way for you to iterate on it (be honest if it's better to scrap it and start from scratch).

Help them decide what their site should achieve and understand its audience. Make it responsive. You can ask for examples of personal sites they like for inspiration.

Preserve the member's voice in any copy you write or edit. No AI tells: no em dashes, no "it's not X, it's Y", no editorializing.

Guide the member toward a suitable free hosting option, such as GitHub Pages or Vercel, depending on their needs.

Make the deployment story simple to understand. Make it easy for them to preview changes before they go live (you can register the local version as an Isomux app, or you can drive headless Chrome to show them screenshots). Drive deployments yourself (with the member's permission) when possible.`,
  "templates.cityGuide.instructions": `Help the member discover neighborhoods, food, culture, events, and practical local services around their tastes, location, schedule, budget, and mobility.

Verify current hours, prices, closures, booking rules, and transit details before relying on them.

Be honest about the integrations you have access to and their limitations.`,
  "templates.todoListAssistant.instructions": `Help the member prioritize tasks, track commitments, make progress on their todo list, and be on top of things. All while planning realistic days.

The goal is to have a functional todo system that works for their workflow and their preferences.

Iterate with them to figure out the best method. Learn how the member naturally organizes tasks before proposing a system. Keep maintenance light and preserve the member's wording when useful. A personalized todo app is often useful, but it must match the member's workflow.

If they want it, make a personalized todo app for them (you can register it with Isomux so it's on their phone too). Before building anything, ask them if they have used such apps before, if they were helpful, why they didn't stick with it, and what's their ideal workflow for it.

Some principles for the app:

- Minimize friction for capturing tasks
- Keep unfinished work easy to find
- Don't impose rituals

Some other things that could be helpful:

- Ask questions before giving advice and adapt plans to the member's energy, responsibilities, and values.
- Research effective habit-building strategies before offering advice.
- Notice patterns, like what works for them and what doesn't.

If having email or calendar access would be useful, ask the member if they feel comfortable sharing it. Let them know that Claude and ChatGPT support such integrations - walk them through enabling it, don't reinvent the integration yourself.

Let them know anything you see is shared with OpenAI or Anthropic, depending on your backend. Before they share anything sensitive, let them know that providers often have a setting where you can opt out of using your data for training, and encourage them to use it.`,
  "templates.codeReviewer.instructions": `You are the member's Code Reviewer. Whoever implemented the code may have focused on shipping, not code quality. That's the piece you own.

- The priority is to check correctness and security of the code.
- Look for hacks, bad abstractions, unnecessary duplication, etc. Use judgment to separate findings into blockers vs nitpicks.
- If there's no issue, say it's good to ship. To be clear: it's not mandatory to always find issues.
- Agree with the member on testing strategy. Don't assume everything needs a test.
- Do not modify code unless the member asks you to implement a fix. You can ask the member if the code was implemented by an agent in the office, and offer to message the other agent directly with the feedback.
- Your claims should be based on evidence, not inference.
- Do not assume that backward compatibility is important unless you have established with the member that the product is already live and used.`,
  "templates.relationshipAdvisor.instructions": `Help the member think clearly about relationships, friendships, communication, needs, boundaries, and next steps.

Find the member's attachment style and personality traits. Then, ground your answers with that as context so it resonates with them.

Separate what was actually said from interpretation; you're hearing one side. Help the member understand the other person's perspective, considering that the other person may operate differently than them.

If they want to share conversations, let them know you can read screenshots, but anything you see is shared with OpenAI or Anthropic, depending on your backend. Before they share anything sensitive, let them know that providers often have a setting where you can opt out of using your data for training, and encourage them to use it.

Preserve the member's voice in any message you help write or edit. No AI tells: no em dashes, no "it's not X, it's Y", no editorializing.

Other things you can help the member with:

- Plan dates.
- Suggest personalized gift ideas.`,
  "templates.jobSearchCoach.instructions": `Help the member run a self-assessment on their job search.

- What are they looking for?
- What are their priorities?
- What are their challenges?
- What's their timeline?
- What kind of prep should they focus on?

Then, work with them on a realistic job search strategy.

Things you can offer to do for them, if they want them:

- Search for good prep resources, biased toward free ones.
- Run practice questions with them and give constructive criticism. Suggest they use speech-to-text for their answers. Tell them to not worry about it if some words are not captured properly; you'll find the correct word that's phonetically similar, or ask for clarification if needed.
- Iterate with them on their resume, but tell them that, to avoid getting flagged as AI, they should own the final copy.
- Improve or expand their portfolio.
- Start a local folder to keep track of leads/applications, and/or set up a dashboard app registered with Isomux.
- Research companies they are interviewing for to find connections to the member's background.

Preserve the member's voice in any copy you write or edit. No AI tells: no em dashes, no "it's not X, it's Y", no editorializing.

Don't apply or contact anyone without explicit approval.`,
  "templates.tripPlanner.instructions": `Help the member plan trips around their interests, dates, budget, pace, and accessibility needs.

Verify current entry rules, transport schedules, opening hours, prices, weather, and booking conditions before relying on them; they change often.

Help plan realistic days, including travel and rest time.

Things you can do for them:

- Research destinations and compare options, showing the timing and cost that drive the recommendation.
- Let the member know about lesser-known things to do where they are going.
- Catch conflicts in booking details, and revise the plan when a constraint changes.
- Offer to find bookings and confirmations in their email if they enable an integration. Claude and ChatGPT support gmail integrations - walk them through enabling it, don't reinvent the integration yourself.
- Make them a personalized itinerary app and register it with Isomux, so it's on their phone while traveling. Optionally, they could invite their travel partners to their Isomux office so they can see the itinerary app too, or even ask questions to you directly. But they should be aware that their travel partners would potentially gain access to other agents in the rooms they can see (and terminal access to the entire file system).`,
  "templates.receptionist.instructions": `Help people use Isomux and this office.

## Voice
- Talk like a helpful colleague at the front desk, not a manual.
- Be concise: 2-4 sentences is the sweet spot. If the person wants more, they will ask.
- Answer the question asked. Do not inventory features unless asked for the inventory.
- Never invent a feature, a room, an agent or a person. If you do not know, say so and point at the docs or at an owner.

Never ask for or repeat secrets (API keys, tokens, passwords). Point people to Settings → You → Individual connections.`,
  "templates.receptionist.label": "Isomux Receptionist",
  "templates.receptionist.description": "Help with Isomux and this office.",
  "lobby.receptionistName": "Receptionist",
  "lobby.askHint": "Ask about Isomux or this office",
  "lobby.welcome": "WELCOME",
  "lobby.poster": "THE OFFICE",
  "common.lobby": "Lobby",
  "lobby.officeFallback": "the office",
  "lobby.directory": "DIRECTORY",
  "lobby.employeeLine1": "EMPLOYEE OF",
  "lobby.employeeLine2": "THE MINUTE",
  "lobby.openChat": "{name} - click to open the chat",
  "membersChat.authorAgent": "{name} · agent",
  "membersChat.authorApi": "{name} · API token",
  "membersChat.authorApiDevice": '{name} · API token "{device}"',
  "membersChat.deleteAgain": "Click again to delete",
  "membersChat.sure": "sure?",
  "membersChat.loadFailed": "Could not load the chat",
  "membersChat.olderFailed": "Could not load older",
  "membersChat.uploadFailed": "upload failed",
  "membersChat.uploadStatus": "Upload failed ({status})",
  "membersChat.sendFailed": "Could not send",
  "membersChat.editFailed": "Could not edit",
  "membersChat.deleteFailed": "Could not delete",
  "membersChat.unreadCount.one": "Unread message: {count}",
  "membersChat.unreadCount.other": "Unread messages: {count}",
  "membersChat.retry": "Try again",
  "membersChat.thumbsUp": "Thumbs up",
  "membersChat.removeThumbsUp": "Remove thumbs up",
  "membersChat.reactors": "Thumbs up: {count}",
  "membersChat.reactionFailed": "Could not update reaction",
  "apiCall.membersChat.thumbsUp": "Set members chat thumbs up",
  "membersChat.resize": "Resize chat",
  "membersChat.hide": "Hide chat",
  "membersChat.reply": "Reply",
  "membersChat.cancelReply": "Cancel reply",
  "membersChat.actions": "Message actions",
  "membersChat.replyMissing":
    "The original message was deleted. Cancel the reply or choose another message.",
  "membersChat.pin": "Pin",
  "membersChat.unpin": "Unpin",
  "membersChat.pinned": "Pinned ({count})",
  "membersChat.pinFailed": "Could not update pin",
  "apiCall.membersChat.pin": "Set members chat pin",
  "membersChat.title": "Members chat",
  "membersChat.online": "{count} online",
  "membersChat.loadingOlder": "Loading older…",
  "membersChat.loadOlder": "Load older",
  "membersChat.empty": "Nothing here yet. Only people see this chat.",
  "membersChat.edited": " · edited",
  "membersChat.uploading": "uploading…",
  "membersChat.placeholder": "Message the members…",

  "common.save": "Save",
  "common.saving": "Saving…",
  "common.saved": "Saved",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.loading": "Loading…",
  // Three periods, not the ellipsis of common.loading above: two surfaces
  // spell the word this way and ruling 6 freezes both spellings.
  "common.loadingDots": "Loading...",
  "common.loadingMemory": "Loading memory…",
  "common.memory": "Memory",
  "common.memoryEditorHint":
    "This editor rewrites the file exactly as shown. Use one memory per line.",
  "common.saveFailed": "Save failed",
  "common.memoryConflict":
    "Memory changed since you opened this - reopen the dialog to edit the latest.",
  "common.memorySaveFailed": "Memory save failed",
  "common.unread": "unread",
  "common.roomFallback": "Room {number}",
  "common.nextConversation": "Changes take effect on next conversation.",
  "common.schedule": "Schedule",
  "common.discardPrompt": "Discard unsaved changes?",
  "common.delete": "Delete",
  "common.confirmQuestion": "Confirm?",
  "nav.tasksShortcut": "Tasks (t)",
  "nav.appsShortcut": "Apps (a)",
  "nav.settingsShortcut": "Settings (s)",
  "common.moreActions": "More actions",
  "common.settings": "Settings",
  "common.theme": "Theme",
  "common.preferences": "Preferences",
  "common.checking": "Checking…",
  "common.copied": "Copied",
  "common.copy": "Copy",
  "common.device": "Device",
  "common.discard": "Discard",
  "common.justNow": "just now",
  "common.name": "Name",
  "common.noRooms": "No rooms yet.",
  "common.prefix": "Prefix",
  "common.revoke": "Revoke",
  "common.rules": "Rules",
  "common.role": "Role",
  "common.rooms": "Rooms",
  "common.signOut": "Sign out",
  "common.user": "Member",
  "common.schedules": "Schedules",
  "common.apps": "Apps",
  "common.changeTheme": "Change theme",

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
    "Member profiles are stored on the server. Your notifications and credentials follow you across devices.",
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
  "settings.sidebar.profile": "Profile",
  "settings.sidebar.connectionsPersonal": "Individual connections",
  "settings.sidebar.apiTokens": "API tokens",
  "settings.sidebar.signInLinks": "Sign-in links",
  "settings.sidebar.deviceLabel": "Device label",
  "settings.sidebar.members": "Members",
  "settings.members.editHint":
    "Only the member and office owners can edit a member",
  "settings.members.onlineNow": "Online now",
  "settings.members.online": "online",
  "settings.members.onlineSessions.one": "online · {count} session",
  "settings.members.onlineSessions.other": "online · {count} sessions",
  "settings.members.lastSeen": "last seen {when}",
  "settings.role.officeOwner": "Office owner",
  "settings.role.officeOwnerExplanation":
    "Can access all rooms, invite members, and manage member access and sessions.",
  "settings.role.owner": "office owner",
  "settings.role.member": "member",
  "settings.role.ownerHint":
    "Office owner - can invite members, revoke sessions, and set per-user room access",
  "settings.role.memberHint":
    "Member - can act in rooms an office owner allowed; can't invite or revoke",

  // The member editor (the Profile row and the roster rows).
  "settings.profile.identity": "Identity",
  "settings.profile.displayName": "Display Name",
  "settings.profile.accessHint":
    "Access: rooms this member can see and act in (office-owner managed).",
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
    "(auto-injected into the system prompt of agents you own; other members' agents can look it up if they need context on you)",
  "settings.profile.profilePromptTitle": "{user} · Profile Prompt",
  "settings.profile.profilePromptExpandedHint":
    "Auto-injected into the system prompt of agents this member owns; other members' agents can look it up if they need context on them.",
  "settings.profile.profilePromptPlaceholder":
    "A few notes for agents about who you are, your role, how you like to collaborate…",
  "settings.profile.memoryHint":
    "(durable member-scoped facts for this member; rewrites the file exactly as shown - one memory per line; {size} / {cap})",
  "settings.profile.memoryTitle": "{user} · Memory",
  "settings.profile.memoryPlaceholder": "Some memory relevant to this member",
  "settings.profile.appearance": "Appearance",
  "settings.profile.avatarHint":
    "(your ghost in the office scene; other members see it next to the agent you're viewing)",
  "settings.profile.deleteHint": "Delete this member",
  "settings.profile.deleteFailed": "Delete failed",
  "settings.profile.roomListFailed":
    "Could not confirm your room list; Displayed not saved.",

  "settings.office.title": "Office Settings",
  "settings.office.intro": "Settings that apply to every room.",
  "settings.office.viewOnly":
    "View only. Only office owners can edit office-wide settings.",
  "settings.office.name": "Office Name",
  "settings.office.nameHint": "(optional, shown in browser tab)",
  "settings.office.namePlaceholder": "Nil's Office",
  "settings.office.rulesHint": "(system prompt for all agents)",
  "settings.office.rulesTitle": "Office Rules",
  "settings.office.rulesExpandedHint":
    "System prompt for all agents. Changes take effect on next conversation.",
  "settings.office.rulesPlaceholder":
    "e.g. Always write tests. Use TypeScript. Be concise.",
  "settings.office.experimental": "Experimental",
  "settings.office.browserPanel": "Browser panel (experimental)",
  "settings.office.browserPanelHint":
    "Show the live Browser panel in agent chats. Off by default.",
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
  "settings.room.intro":
    "The vent on the wall, the s key and a double-click on the room tab open this page.",
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
    "If nothing happens after a few minutes, check the updater's status file on the server.",
  "settings.update.waiting": "Keep this pane open until the server restarts.",
  "settings.update.done":
    "The update is done. Refresh the browser to load the updated page.",
  "settings.update.refreshBrowser": "Refresh browser",
  "settings.update.unchanged":
    "The page reconnected, but the running version has not changed.",
  "settings.update.unverified":
    "The page reconnected, but the running version could not be checked.",
  "settings.update.stepRefresh":
    "Refresh the browser after the server restarts.",
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
  "settings.usage.rooms": "Per-room usage",
  "settings.usage.roomsNote":
    "Killed agents contribute to the room they were last in.",
  "settings.usage.roomColumn": "Room",
  "settings.usage.deleted": "deleted",
  "settings.usage.schedules": "Per-schedule usage",
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
  "settings.storage.category.tokenLogs": "API token conversations",
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
  // Under an hour left: Intl would say "in 0h", so the column keeps the text
  // the hand-built formatter printed (ruling 17).
  "settings.access.expiresUnderHour": "0h",
  "settings.access.localTime": "{time} local",
  "settings.access.inviteUrl": "Invite URL",
  "settings.access.copyUrl": "Copy URL",
  "settings.access.urlCopied": "Copied!",
  "settings.access.clipboardBlocked":
    "Clipboard blocked. The URL above is selected - copy it manually.",
  "settings.access.sendUrl":
    "Send this URL to the invitee. It's one-time: opening it on their device signs them in. The URL is shown once - copy it now.",

  "settings.invites.intro":
    "Add a new member or office owner: issue an invite URL and send it to them out-of-band. Opening it creates their account and signs that device in. For extra devices on an existing account, each member generates their own device link from <i>My devices</i>.",
  "settings.invites.memberName": "Member name (optional)",
  "settings.invites.memberNamePlaceholder": "e.g. Marc",
  "settings.invites.changeLater":
    "All of these settings can be changed later. The member can edit this name when they accept the invite.",
  "preAuth.invite.changeLater":
    "You can change your name and language later in Settings.",
  "settings.invites.browserLanguage": "Invitee’s browser language",
  "preAuth.invite.nameTaken": "That name is in use. Choose another name.",
  "preAuth.invite.errorLanguage": "Choose a language.",
  "preAuth.invite.newMember": "New member",
  "settings.invites.issueFor": "Issue invite for…",
  "settings.invites.namePlaceholder": "New username (e.g. Marc)",
  "settings.invites.existing":
    "<b>{name}</b> already exists, so no invite is needed: to sign in another device, {name} can generate a device link from <i>My devices</i> in their own settings - or you can mint them a recovery link below.",
  "settings.invites.grantRoom": "Grant access to {room}",
  "settings.invites.roomsHint":
    "The invitee lands with access to the checked rooms. Leave all unchecked to grant access later from Settings → Members.",
  "settings.invites.expiryHint":
    "Invite link expires 24h after issuing if unused. Accepted sessions last up to 1 year (revocable from the Sessions section any time).",
  "settings.invites.minting": "Minting…",
  "settings.invites.issue": "Issue invite",
  "settings.invites.mintFailed": "Failed to mint invite",
  "settings.invites.recovery": "Recovery",
  "settings.invites.recoveryHint":
    "Help an existing member get back in. Device links are self-service, but someone signed out of every device can't mint their own - pick them here and send the link out-of-band. It expires in 24h; minting a new one replaces their previous link.",
  "settings.invites.selectUser": "Select a member…",
  "settings.invites.mintRecovery": "Mint recovery link",
  "settings.invites.recoveryFailed": "Failed to mint recovery link",
  "settings.invites.outstanding": "Outstanding invites",
  "settings.invites.columnFor": "For",
  "settings.invites.columnExpires": "Expires",
  "settings.invites.bootstrap": "(bootstrap)",

  "settings.sessions.intro":
    "Devices signed into this office, across all members. Revoking a session signs that device out. New people get an invite from the Invites section; existing members add devices themselves from <i>My devices</i>.",
  "settings.sessions.columnLastSeen": "Last seen",
  "settings.sessions.columnCreated": "Created",
  "settings.sessions.currentSession": "Current session",
  "settings.sessions.currentSessionHint":
    "Use Sign out at the bottom of the sidebar to end your current session.",
  "settings.sessions.expiryInactivity": "Expires after inactivity",
  "settings.sessions.expiryLatest": "Expires at the latest",

  "settings.externalAccess.managed":
    "Hosted Isomux manages this office's address; it cannot be changed.",
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
    "These variables load for every agent unless a member variable overrides them.",
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
  "settings.connections.bedrockHint":
    "Want to connect Bedrock? Read <link>here</link>.",

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
    "Personal provider status and variable names for this member's agents.",
  "settings.memberConnections.loadFailed": "Could not load connections.",
  "settings.memberConnections.unknown": "Could not check status.",
  "settings.memberConnections.empty": "No variables.",
  // The dialogs (internal-docs/i18n-loop.md, S4).

  // ExpandableTextarea's own chrome. Its title, hint and placeholder all
  // arrive as props, already translated by the dialog or pane that opens it.
  "dialogs.textarea.expand": "Expand {title}",
  "dialogs.textarea.escCollapse": "Esc to collapse",
  "dialogs.textarea.done": "Done",

  "dialogs.schedulePrompt.title": "Schedules Settings",
  "dialogs.schedulePrompt.rulesHint": "(system prompt for all schedules)",
  "dialogs.schedulePrompt.rulesPlaceholder":
    "e.g. Always write findings to a markdown file. Be terse.",
  "dialogs.schedulePrompt.appliedNextRun":
    "Applied to the next run; in-flight runs use their captured snapshot.",
  "common.field.engine": "Engine",
  "common.field.model": "Model",
  "common.field.effort": "Thinking Effort",
  "common.field.sandbox": "Sandbox",
  "common.field.permissionMode": "Permission Mode",
  "common.field.approvalPolicy": "Approval Policy",
  "common.field.workingDirectory": "Working Directory",

  // Reasoning effort, keyed by the id in EFFORT_LEVELS (shared/types.ts). That
  // table keeps its English label for the server's /effort command until S7;
  // catalog.test.ts holds the two copies to the same text.
  "common.effort.minimal": "Minimal",
  "common.effort.low": "Low",
  "common.effort.medium": "Medium",
  "common.effort.high": "High",
  "common.effort.xhigh": "Extra high",
  "common.effort.max": "Max",
  "common.effort.ultra": "Ultra (Codex only)",

  // The permission options both dialogs offer word-for-word. The ones only the
  // agent dialog or only the schedule dialog shows live under dialogs.*, since
  // the same value id reads differently per engine and per dialog.
  "common.permission.claudeBypass": "Bypass (auto-approve all)",
  "common.permission.codexNever": "Never ask (use sandbox-only)",
  "common.sandbox.readOnly": "Read-only (model can read, never write)",
  "common.sandbox.workspaceWrite": "Workspace write (write inside cwd only)",
  "common.sandbox.dangerFullAccess": "Danger: full access (no sandbox)",

  // The model picker, shared by the agent and schedule dialogs. Model names and
  // the {detail} a backend reports stay as they arrive (ruling 11).
  "common.model.currentOption": "Current model",
  "common.model.currentIs": "Current model: {model}.",
  "common.model.checkFailed":
    "The available models could not be checked. Reopen this dialog to try again.",
  "common.model.notOffered":
    "This login does not offer it. Choose an available model.",
  "common.model.loading": "Loading available models…",
  "common.model.startingOpenCode":
    "OpenCode is starting. Loading available models…",
  "common.model.noneConnected":
    "OpenCode has no connected provider models for this environment.",
  "common.model.selectConnected":
    "Select a connected OpenCode model before saving.",
  "common.model.loadFailed": "Failed to load models",
  "common.model.openCodeListFailed":
    "OpenCode could not list its models. Reopen this dialog.",
  "common.model.codexNotSignedIn":
    "Codex is not signed in. Open a Codex agent and click the sign-in card it emits, then reopen this dialog. (Or set OPENAI_API_KEY in your env.)",
  "common.model.openCodeLoadFailed":
    "Could not load OpenCode models{detail}. Reopen this dialog to try again.",
  "common.model.listLoadFailed":
    "Could not load model list{detail}. Showing fallback list - some options may not work on your account.",

  "dialogs.schedule.titleNew": "New Schedule",
  "dialogs.schedule.titleEdit": "Edit Schedule",
  "dialogs.schedule.namePlaceholder": "Daily summary",
  "dialogs.schedule.daily": "Daily",
  "dialogs.schedule.weekly": "Weekly",
  "dialogs.schedule.interval": "Every N minutes",
  "dialogs.schedule.weekday.sunday": "Sunday",
  "dialogs.schedule.weekday.monday": "Monday",
  "dialogs.schedule.weekday.tuesday": "Tuesday",
  "dialogs.schedule.weekday.wednesday": "Wednesday",
  "dialogs.schedule.weekday.thursday": "Thursday",
  "dialogs.schedule.weekday.friday": "Friday",
  "dialogs.schedule.weekday.saturday": "Saturday",
  "dialogs.schedule.hour": "Hour (0-23)",
  "dialogs.schedule.minute": "Minute (0-59)",
  "dialogs.schedule.intervalMinutes": "Interval (minutes, min 5)",
  "dialogs.schedule.serverLocal": "Times are server-local.",
  "dialogs.schedule.prompt": "Prompt",
  "dialogs.schedule.promptTitle": "Schedule Prompt",
  "dialogs.schedule.promptPlaceholder":
    'e.g. "Summarize what every agent accomplished yesterday."',
  "dialogs.schedule.promptEmpty": "Prompt cannot be empty.",
  "dialogs.schedule.permissionUnattended": "Allow project tools (unattended)",
  "dialogs.schedule.permissionHintOpenCode":
    "Shell and edit tools are allowed. Delegation and questions are denied.",
  "dialogs.schedule.permissionHint":
    "Schedules run unattended - modes that require human approval are not available.",
  "dialogs.schedule.enabled": "Enabled (uncheck to pause without deleting)",
  "dialogs.schedule.create": "Create",

  "dialogs.agent.titleSpawn": "Spawn New Agent",
  "dialogs.agent.titleEdit": "Edit Agent",
  "dialogs.agent.desk": "Desk #{desk}",
  "dialogs.agent.engineBlurb.claude": "Works with your Claude Code login.",
  "dialogs.agent.engineBlurb.codex": "Works with your ChatGPT login.",
  "dialogs.agent.engineBlurb.opencode":
    "Works with models configured through OpenCode.",
  "dialogs.agent.engineSwitchHint":
    "Switching to {engine} starts a new conversation. The current one stays in this agent's resume history.",
  "dialogs.agent.templateHint":
    "Templates fill the fields below. You can edit every suggestion.",
  "dialogs.agent.blank": "Blank",
  "dialogs.agent.blankHint": "Set up the agent yourself.",
  "dialogs.agent.appearance": "Appearance",
  "dialogs.agent.randomize": "Randomize",
  "dialogs.agent.skin": "Skin",
  "dialogs.agent.shirt": "Shirt",
  "dialogs.agent.hairColor": "Hair Color",
  "dialogs.agent.hairStyle": "Hair Style",
  "dialogs.agent.costume": "Costume",
  "dialogs.agent.costume.none": "None",
  "dialogs.agent.costume.doctor": "Doctor",
  "dialogs.agent.costume.police": "Police officer",
  "dialogs.agent.costume.firefighter": "Firefighter",
  "dialogs.agent.costume.chef": "Chef",
  "dialogs.agent.costume.construction": "Construction worker",
  "dialogs.agent.costume.astronaut": "Astronaut",
  "dialogs.agent.hat": "Hat",
  "dialogs.agent.beard": "Beard",
  "dialogs.agent.accessory": "Accessory",
  "dialogs.agent.hairStyle.short": "Short",
  "dialogs.agent.hairStyle.long": "Long",
  "dialogs.agent.hairStyle.ponytail": "Ponytail",
  "dialogs.agent.hairStyle.bun": "Bun",
  "dialogs.agent.hairStyle.pigtails": "Pigtails",
  "dialogs.agent.hairStyle.curly": "Curly",
  "dialogs.agent.hairStyle.bald": "Bald",
  "dialogs.agent.hat.none": "None",
  "dialogs.agent.hat.cap": "Cap",
  "dialogs.agent.hat.beanie": "Beanie",
  "dialogs.agent.hat.bow": "Hair Bow",
  "dialogs.agent.hat.headband": "Headband",
  "dialogs.agent.accessory.none": "None",
  "dialogs.agent.accessory.glasses": "Glasses",
  "dialogs.agent.accessory.headphones": "Headphones",
  "dialogs.agent.accessory.bowTie": "Bow Tie",
  "dialogs.agent.accessory.tie": "Tie",
  "dialogs.agent.accessory.earrings": "Earrings",
  "dialogs.agent.beard.none": "None",
  "dialogs.agent.beard.stubble": "Stubble",
  "dialogs.agent.beard.full": "Full",
  "dialogs.agent.beard.goatee": "Goatee",
  "dialogs.agent.beard.mustache": "Mustache",
  "dialogs.agent.recent": "Recent",
  "dialogs.agent.manager": "Manager",
  "dialogs.agent.managerTitle":
    "Set at spawn - manager cannot be changed after the agent is created.",
  "dialogs.agent.managerNoUser": "(no member assigned)",
  "dialogs.agent.managerUnowned": "(unowned)",
  "dialogs.agent.managerHint":
    "The agent uses this member’s provider connections and personal variables. See Settings → You → Individual connections.",
  "dialogs.agent.privileged": "Privileged operator access",
  "dialogs.agent.privilegedHint":
    "Lets this agent drive other agents' sessions (resume, new conversation, send-now) and manage its own cronjobs, with the spawning member's room-scoped permissions. It still acts as the agent, never as the member.",
  "dialogs.agent.privilegedRestart": "Saving restarts the agent's session.",
  "dialogs.agent.permission.ask": "Ask",
  "dialogs.agent.permission.bypassAll": "Bypass all permissions",
  "dialogs.agent.permission.codexUntrusted": "Untrusted (ask on every tool)",
  "dialogs.agent.permission.codexOnRequest":
    "On request (model asks when needed)",
  "dialogs.agent.permission.claudeAuto":
    "Auto (classifier auto-approves safe actions)",
  "dialogs.agent.permission.claudeDefault": "Default (ask for everything)",
  "dialogs.agent.permission.claudeAcceptEdits":
    "Accept Edits (auto-approve file changes)",
  "dialogs.agent.modelTier.free":
    "Free (the provider may use traffic for training)",
  "dialogs.agent.modelTier.payg": "Pay-as-you-go (OpenCode credits)",
  "dialogs.agent.modelTier.subscription": "Subscription (OpenCode Go)",
  "dialogs.agent.memoryHint":
    "(durable facts for this agent; raw lines; {size} / {cap})",
  "dialogs.agent.memoryTitle": "Agent Memory",
  "dialogs.agent.memoryPlaceholder": "Some memory relevant to this agent",
  "dialogs.agent.customInstructions": "Custom Instructions",
  "dialogs.agent.group.template": "Template",
  "dialogs.agent.group.identity": "Identity",
  "common.instructionsAndMemory": "Instructions and memory",
  "dialogs.agent.spawnPreviewHint":
    "The agent ID will be assigned on spawn. This preview uses “new-agent”.",
  "dialogs.agent.cwdHint":
    "The folder where the agent starts work. The agent can also access files outside this folder.",
  "dialogs.agent.memoryStartsEmpty": "Memory starts empty.",
  "dialogs.agent.group.engine": "Model and behavior",
  "dialogs.agent.group.workspace": "Workspace",
  "dialogs.agent.group.instructions": "Instructions",
  "dialogs.agent.group.access": "Access and location",
  "dialogs.agent.group.restore": "Restore",
  "dialogs.agent.optional": "(optional)",
  "dialogs.agent.customInstructionsHint":
    "Personal system prompt for this agent.",
  "dialogs.agent.showSystemPrompt": "Show full system prompt",
  "dialogs.agent.systemPromptTitle": "Full system prompt",
  "dialogs.agent.systemPromptLoadFailed": "Could not load the system prompt.",
  "dialogs.agent.cronjobPromptTitle": "Schedule (cron job) prompt",
  "dialogs.agent.showCronjobPrompt": "Show schedule (cron job) prompt",
  "dialogs.agent.helpTitle": "Help",
  "dialogs.agent.showHelp": "Show help",
  "dialogs.agent.customInstructionsPlaceholder":
    'e.g. "You are a backend specialist. Always write tests."',
  "dialogs.agent.revive": "Revive a killed agent",
  "dialogs.agent.reviving": "Reviving…",
  "dialogs.agent.reviveFailed": "Revive failed",
  "dialogs.agent.moveToRoom": "Move to Room",
  "dialogs.agent.invalidDirectory": "Invalid directory",
  "dialogs.agent.staleInstructions":
    "Custom instructions changed since you opened this - reopen the dialog to edit the latest.",
  "dialogs.agent.spawn": "Spawn",

  // The spawn dialog's template cards, keyed by the template id in
  // shared/agent-templates.ts. Instructions above are resolved at pick time.
  "templates.moneyPlanner.label": "Money Planner",
  "templates.moneyPlanner.description":
    "Plan spending, saving, goals, and financial decisions.",
  "templates.sideProjectBuilder.label": "Side Project Builder",
  "templates.sideProjectBuilder.description":
    "Turn a rough idea into a small product that ships.",
  "templates.healthNavigator.label": "Health Navigator",
  "templates.healthNavigator.description":
    "Organize health information and prepare for care.",
  "templates.lifeCoach.label": "Life Coach",
  "templates.lifeCoach.description":
    "Clarify goals, choose next steps, and review progress.",
  "templates.researchAnalyst.label": "Research Analyst",
  "templates.researchAnalyst.description":
    "Investigate questions and produce decision-ready briefs.",
  "templates.personalSiteBuilder.label": "Personal Site Builder",
  "templates.personalSiteBuilder.description":
    "Design, build, and publish a personal website.",
  "templates.cityGuide.label": "City Guide",
  "templates.cityGuide.description":
    "Discover places and plan around how you explore.",
  "templates.todoListAssistant.label": "Todo List Assistant",
  "templates.todoListAssistant.description":
    "Turn commitments into a personal system that stays useful.",
  "templates.codeReviewer.label": "Code Reviewer",
  "templates.codeReviewer.description":
    "Find consequential defects and explain precise fixes.",
  "templates.relationshipAdvisor.label": "Relationship Advisor",
  "templates.relationshipAdvisor.description":
    "Think through communication, needs, and next steps.",
  "templates.jobSearchCoach.label": "Job Search Coach",
  "templates.jobSearchCoach.description":
    "Focus a search and improve applications and interviews.",
  "templates.tripPlanner.label": "Trip Planner",
  "templates.tripPlanner.description":
    "Build practical trips around your interests and limits.",
  // The API-call card (S5): what an agent's curl against the isomux API
  // did, in one line. A route's static label and the parameter-aware
  // sentence for the same call share a key when their English matches.
  "apiCall.membersChat.read": "Read members chat",
  "apiCall.membersChat.post": "Post to members chat",
  "apiCall.membersChat.edit": "Edit members chat message",
  "apiCall.membersChat.delete": "Delete members chat message",
  "apiCall.membersChat.markRead": "Mark members chat read",
  "apiCall.tasks.list": "List tasks",
  "apiCall.tasks.create": "Create task",
  "apiCall.tasks.claim": "Claim task",
  "apiCall.tasks.complete": "Complete task",
  "apiCall.tasks.update": "Update task",
  "apiCall.tasks.delete": "Delete task",
  "apiCall.tasks.listOpen": "List open tasks",
  "apiCall.tasks.listOpenGlobal": "List open tasks (office-global only)",
  "apiCall.tasks.listOpenInRoom": "List open tasks in one room",
  "apiCall.tasks.listAll": "List all tasks",
  "apiCall.tasks.listAllGlobal": "List all tasks (office-global only)",
  "apiCall.tasks.listAllInRoom": "List all tasks in one room",
  "apiCall.tasks.listStatus": "List {status} tasks",
  "apiCall.tasks.listStatusGlobal": "List {status} tasks (office-global only)",
  "apiCall.tasks.listStatusInRoom": "List {status} tasks in one room",
  "apiCall.tasks.createTitled": "Create task: {title}",
  "apiCall.tasks.createPlain": "Create a task",
  "apiCall.tasks.updateOne": "Update task {task}",
  "apiCall.tasks.deleteOne": "Delete task {task}",
  "apiCall.tasks.readOne": "Read task {task}",
  "apiCall.tasks.claimFor": "Claim task {task} for {assignee}",
  "apiCall.tasks.claimOne": "Claim task {task}",
  "apiCall.tasks.markDone": "Mark task {task} done",
  "apiCall.agents.list": "List office agents",
  "apiCall.agents.listKilled": "List killed agents",
  "apiCall.agents.listInvalidFilter": "List agents (invalid killed filter)",
  "apiCall.agents.sendMessage": "Send agent message",
  "apiCall.agents.sendMessageTo": "Send a message to {who}",
  "apiCall.agents.steerMessage": "Interrupt {who} with a message",
  "apiCall.agents.scheduleMessage": "Schedule a message to {who}",
  "apiCall.agents.spawn": "Spawn a new agent",
  "apiCall.agents.spawnNamed": "Spawn agent {name}",
  "apiCall.agents.editSettings": "Edit {who}'s settings",
  "apiCall.agents.remove": "Remove agent {who}",
  "apiCall.agents.handoff": "Hand off to fresh session",
  "apiCall.agents.handoffFor": "Hand off {who} to a fresh session",
  "apiCall.agents.scheduledList": "List scheduled messages",
  "apiCall.agents.scheduledListFor": "List {who}'s outgoing scheduled messages",
  "apiCall.agents.scheduledCancel": "Cancel scheduled message",
  "apiCall.agents.scheduledCancelFor":
    "Cancel one of {who}'s outgoing scheduled messages",
  "apiCall.agents.shareFile": "Share file to chat",
  "apiCall.agents.shareFileDetail": "Share a file to chat",
  "apiCall.agents.previewUrl": "Screenshot page to chat",
  "apiCall.agents.previewUrlDetail": "Screenshot a page to chat",
  "apiCall.agents.browser": "Use the browser",
  "apiCall.agents.browserDetail": "Use the browser",
  "apiCall.agents.showDiff": "Show diff in chat",
  "apiCall.agents.showDiffDetail": "Show a diff in chat",
  "apiCall.agents.offerFile": "Offer file in editor",
  "apiCall.agents.offerFileDetail": "Offer a file in the editor",
  "apiCall.agents.suggestCommand": "Suggest terminal command",
  "apiCall.agents.suggestCommandDetail": "Suggest a terminal command",
  "apiCall.agents.context": "Check context usage",
  "apiCall.agents.subscription": "Check subscription usage",
  "apiCall.agents.logsSearch": "Search conversation logs",
  "apiCall.agents.logsSearchFor": 'Search {who}\'s logs for "{query}"',
  "apiCall.agents.logsAround": "Read around an entry in {who}'s logs",
  "apiCall.agents.logsSession": "Read a session from {who}'s logs",
  "apiCall.agents.logsList": "List {who}'s log sessions",
  "apiCall.agents.instructions": "Read agent instructions",
  "apiCall.agents.systemPrompt": "Read the agent system prompt",
  "apiCall.agents.clearConversation": "Clear {who}'s conversation",
  "apiCall.agents.flushQueue": "Flush {who}'s queue now",
  "apiCall.agents.interrupt": "Interrupt {who}",
  "apiCall.agents.resume": "Resume a session for {who}",
  "apiCall.agents.sessions": "List {who}'s sessions",
  "apiCall.agents.move": "Move {who}",
  "apiCall.agents.revive": "Revive {who}",
  "apiCall.agents.cancelQueued": "Cancel a queued message to {who}",
  "apiCall.agents.editMessage": "Edit a message in {who}'s chat",
  "apiCall.apiTokens.list": "List API tokens",
  "apiCall.apiTokens.create": "Create API token",
  "apiCall.apiTokens.revoke": "Revoke API token",
  "apiCall.providerAccounts.check": "Check provider accounts",
  "apiCall.providerAccounts.signInStart": "Start provider sign-in",
  "apiCall.providerAccounts.signInCancel": "Cancel provider sign-in",
  "apiCall.providerAccounts.signOut": "Sign out provider account",
  "apiCall.providerAccounts.refresh": "Refresh provider accounts",
  "apiCall.providerAccounts.signInCode": "Submit provider sign-in code",
  "apiCall.env.readUser": "Read managed environment",
  "apiCall.env.saveUser": "Save managed environment",
  "apiCall.env.readOffice": "Read office environment",
  "apiCall.env.saveOffice": "Save office environment",
  "apiCall.inbox.messageBoss": "Sent message to external token",
  "apiCall.inbox.drain": "Drain API token inbox",
  "apiCall.memory.read": "Read memory",
  "apiCall.memory.append": "Append memory",
  "apiCall.memory.replace": "Replace memory",
  "apiCall.memory.readAgent": "Read memories for this agent",
  "apiCall.memory.readRoom": "Read room memories",
  "apiCall.memory.readOffice": "Read office memories",
  "apiCall.memory.readBoss": "Read member memories",
  "apiCall.memory.readAny": "Read memories",
  "apiCall.memory.saveAgent": "Save a memory for this agent",
  "apiCall.memory.saveRoom": "Save a room memory",
  "apiCall.memory.saveOffice": "Save an office memory",
  "apiCall.memory.saveBoss": "Save a member memory",
  "apiCall.memory.save": "Save a memory",
  "apiCall.memory.rewriteAgent": "Rewrite memories for this agent",
  "apiCall.memory.rewriteRoom": "Rewrite room memories",
  "apiCall.memory.rewriteOffice": "Rewrite office memories",
  "apiCall.memory.rewriteBoss": "Rewrite member memories",
  "apiCall.memory.rewriteAny": "Rewrite memories",
  "apiCall.rooms.create": "Create a room",
  "apiCall.rooms.createNamed": "Create room {name}",
  "apiCall.rooms.rename": "Rename room to {name}",
  "apiCall.rooms.setPet": "Set a room's pet",
  "apiCall.rooms.setSkin": "Set a room's look",
  "apiCall.rooms.update": "Update a room",
  "apiCall.rooms.close": "Close a room",
  "apiCall.rooms.updateSettings": "Update room settings",
  "apiCall.rooms.swapDesks": "Swap desks in a room",
  "apiCall.cronjobs.list": "List cronjobs",
  "apiCall.cronjobs.create": "Create a cronjob",
  "apiCall.cronjobs.read": "Read a cronjob",
  "apiCall.cronjobs.systemPrompt": "Read a cronjob prompt",
  "apiCall.cronjobs.update": "Update a cronjob",
  "apiCall.cronjobs.delete": "Delete a cronjob",
  "apiCall.cronjobs.listRuns": "List cronjob runs",
  "apiCall.cronjobs.triggerRun": "Trigger a cronjob run",
  "apiCall.cronjobs.readRun": "Read a cronjob run",
  "apiCall.cronjobs.listRecentRuns": "List recent cron runs",
  "apiCall.apps.list": "List apps",
  "apiCall.apps.register": "Register app",
  "apiCall.apps.read": "Read app",
  "apiCall.apps.preview": "Capture app preview",
  "apiCall.apps.update": "Update app",
  "apiCall.apps.delete": "Delete app",
  "apiCall.apps.logs": "Read app logs",
  "apiCall.apps.start": "Start app",
  "apiCall.apps.stop": "Stop app",
  "apiCall.apps.restart": "Restart app",
  "apiCall.skillUsage.read": "Read skill-use counts",
  "apiCall.version.check": "Check isomux version",
  "apiCall.storage.usage": "Check office disk usage",
  "apiCall.storage.prune": "Prune stored history",
  "apiCall.usage.tokens": "Check office token usage",
  "apiCall.body.jq": "body built with jq",
  "apiCall.body.jqReads": "body built with jq (reads {files})",
  "apiCall.body.heredoc": "body from heredoc",
  "apiCall.body.output": "output saved to {file}",
  "apiCall.body.outputAppended": "output appended to {file}",
  "apiCall.body.more": "+{count} more",
  "common.copiedNotice": "Copied!",
  "common.tasks": "Tasks",
  "common.avatar": "Avatar",
  "common.agent": "Agent",
  "common.dismiss": "Dismiss",
  "common.you": "You",
  "common.send": "Send",
  "common.modified": "modified",
  "common.terminal": "Terminal",
  "common.browser": "Browser",
  "common.days.other": "{count} days",
  "common.days.one": "{count} day",
  "common.sender.agent": "{name} · agent",
  "common.sender.agentInRoom": '{name} · agent · Room "{room}"',
  "common.sender.app": "{name} · app",
  "common.sender.cronjob": "{name} · schedule",
  "cards.userMessage.expand": "Expand message",
  "cards.userMessage.collapse": "Collapse message",
  "cards.userMessage.toRemoteBoss": "To remote member",
  "cards.userMessage.toRemoteBossNamed": 'To remote member "{name}"',
  "cards.userMessage.editAndBranch": "Edit & branch",
  "cards.thinking.label": "Thinking...",
  "cards.toolCall.input": "Input",
  "cards.toolCall.output": "Output",
  "cards.toolCall.denied": "Denied",
  "cards.toolCall.groupCount": "{count} tool calls",
  "cards.toolResult.showMore": "Show more",
  "cards.toolResult.showLess": "Show less",
  "cards.fileView.fullSize": "Full size",
  "cards.fileView.earlierAttachment":
    "The agent viewed a file attached earlier in this chat. Click to show it.",
  "cards.editRequest.open": "Open in editor",
  "cards.editRequest.openHint": "Open {path} in the editor side panel",
  "cards.terminalCommand.copy": "Copy to terminal",
  "cards.tool.noOutput": "(no output)",
  "cards.tool.morePaths": "{path} +{count} more",
  "cards.terminalCommand.copyHint":
    "Open the terminal panel and type this command at the prompt (not auto-executed)",
  "cards.markdown.mermaidError": "Mermaid error",
  "cards.markdown.mermaidLoadFailed": "Failed to load mermaid",
  "cards.diff.status.added": "added",
  "cards.diff.status.deleted": "deleted",
  "cards.diff.status.renamed": "renamed",
  "cards.diff.status.copied": "copied",
  "cards.diff.status.untracked": "untracked",
  "cards.diff.status.binary": "binary",
  "cards.diff.reasonTruncated":
    "The total patch was over 2 MB so the diff content was not shipped to the browser. Re-run /isomux-diff after narrowing the working tree, or open this file in your editor.",
  "cards.diff.reasonBinary": "Binary file - no textual diff to render.",
  "cards.diff.reasonUntracked":
    "Untracked file too large to synthesize a patch (>1 MB). Open in your editor, or `git add` it and re-run.",
  "cards.diff.reasonNoPatch": "No patch content for this file.",
  "cards.diff.closeHint": "Close (Esc)",
  "cards.diff.openTruncated": "Open (patch not shipped)",
  "cards.diff.openBinary": "Open (binary)",
  "cards.diff.openUntracked": "Open (untracked, too large)",
  "cards.diff.openLines": "Open ({lines} lines)",
  "cards.diff.unified": "Unified",
  "cards.diff.split": "Split",
  "cards.diff.collapseAll": "Collapse all",
  "cards.diff.expandAll": "Expand all",
  "cards.diff.summaryOnly": "· patch > 2 MB · summary only",
  "cards.diff.headerLine": "+{additions} -{deletions} across {files}",
  "cards.diff.fileCount.one": "{count} file",
  "cards.diff.fileCount.other": "{count} files",
  "contextBattery.detail":
    "Context: {tokens} / {maxTokens} tokens used ({remaining}% left).",
  "contextBattery.nudge":
    "Consider asking the agent to wrap up, or /clear for a fresh session.",
  "contextBattery.unknown":
    "Context usage not measured yet. It updates when the agent finishes a turn.",
  "contextBattery.ariaKnown":
    "Context battery {remaining}% remaining. Tap for details.",
  "contextBattery.ariaUnknown":
    "Context usage not measured yet. Tap for details.",
  "logView.state.thinking": "Thinking",
  "logView.state.toolExecuting": "Running tool",
  "logView.pendingPrompt.permission": "Waiting for permission",
  "logView.pendingPrompt.resume": "Waiting for a session pick",
  "logView.pendingPrompt.model": "Waiting for a model pick",
  "logView.pendingPrompt.effort": "Waiting for an effort pick",
  "logView.pendingPrompt.cronjob": "Waiting for a cronjob pick",
  "logView.abort": "Abort",
  "logView.abortTitle": "Abort (Ctrl+C)",
  "logView.restartingSession": "Restarting session...",
  "logView.queue.flushNow": "Send now",
  "logView.queue.flushHint":
    "Send queued messages now - interrupts the current turn (Ctrl+Enter)",
  "logView.queue.cancel": "Cancel this queued message",
  "logView.interaction.current": "Current",
  "logView.interaction.failed": "Could not apply that choice.",
  "logView.nav.agentTitle": "Agent settings",
  "logView.nav.copyTitle": "Copy the entire chat",
  "logView.nav.avatarTitle": "View avatar",
  "logView.nav.editor": "Editor",
  "logView.nav.editorTitle": "Open file editor (Ctrl+E)",
  "logView.nav.browserTitle": "Open live browser",
  "logView.nav.terminalTitle": "Open terminal (Ctrl+`)",
  "logView.nav.endConversation": "End",
  "logView.nav.endConversationTitle":
    "End conversation. You can resume it later with /resume.",
  "logView.backToOffice": "← Back to Office",
  "logView.backToOfficeTitle": "Back to office (Esc)",
  "logView.editTopic": "Click to edit topic",
  "logView.regenerateTopic": "Regenerate topic from conversation",
  "logView.noHistoryToSummarize": "No conversation history to summarize",
  "logView.lastMessagePrefix": "↑ You:",
  "logView.emptyStart": "Send a message to start a conversation or",
  "logView.emptyResume": "resume a past one",
  "logView.sendFailedBanner":
    "Couldn't send - reconnecting. Your message is still in the box; try again once the banner clears.",
  "logView.attachTooLarge": "File too large (max 200MB)",
  "logView.attachUploading": "uploading…",
  "logView.attachFiles": "Attach files",
  "logView.scrollToBottom": "Scroll to bottom",
  "logView.composer.type": "Type a message or / for commands...",
  "logView.composer.typeShort": "Type a message...",
  "logView.composer.queueShort": "Type to queue...",
  "logView.composer.queueLong":
    "Type to queue - sends when current turn ends · {modifier}Enter to send now",
  "logView.composer.editing": "Editing message above...",
  "logView.composer.queue": "Queue message",
  "logView.cite.label": "Cite",
  "logView.cite.hint": "Cite selected text in input",
  "logView.skills.title": "Skills & commands",
  "logView.skills.buttonLabel": "Sk",
  "logView.uploadFailed": "Upload failed ({status})",
  "logView.skills.filter": "Filter skills & commands...",
  "logView.skills.noMatch": "No matching skills or commands",
  "logView.skills.group.mostUsed": "Most used",
  "logView.skills.group.commands": "Commands",
  "logView.skills.group.bundled": "Bundled",
  "logView.skills.group.project": "Project",
  "logView.skills.group.plugin": "Plugin",
  "logView.voice.talkHint": "Click to talk (Ctrl+Space to hold)",
  "logView.voice.blocked":
    "Voice input is blocked. Check this site's microphone permission in your browser.",
  "logView.voice.noMicrophone": "No microphone was found.",
  "logView.voice.network": "Voice input could not reach the speech service.",
  "logView.voice.failed": "Voice input failed.",
  "logView.voice.speak": "Speak",
  "logView.voice.stop": "Stop",
  "logView.voice.noVoice": "No {language} voice is installed on this device",
  "logView.voice.language.en": "English",
  "logView.voice.language.es": "Spanish",
  "logView.voice.language.ca": "Catalan",
  "logView.voice.language.zh": "Simplified Chinese",
  "logView.voice.httpsTitle": "Voice input requires HTTPS",
  "logView.voice.httpsStep1":
    "Enable HTTPS in your <console>Tailscale admin console</console> (DNS page), then run these on the host (use the built-in terminal):",
  "logView.voice.httpsStep2":
    "Visit the HTTPS URL Tailscale prints (e.g. <url>{example}</url>).",
  "panels.resizer.label": "Resize side panel",
  "panels.terminal.ready": "Ready",
  "panels.terminal.busy": "Busy: {process}",
  "panels.terminal.interrupt": "Interrupt",
  "panels.terminal.interruptHint": "Interrupt the foreground command",
  "panels.terminal.restart": "Restart",
  "panels.terminal.restartHint": "Restart the terminal",
  "panels.terminal.close": "Close terminal",
  "panels.terminal.sendToChat": "Send to chat",
  "panels.terminal.sendToChatHint":
    "Insert the selected text into the chat input as a code block",
  "panels.terminal.shellExited": "Shell exited ({code})",
  "panels.terminal.unavailable": "Terminal unavailable",
  "panels.terminal.busyIssue": "Not sent: {process} is using the terminal",
  "panels.terminal.paste": "Paste",
  "panels.terminal.pastePrompt": "Paste:",
  "panels.editor.close": "Close editor",
  "panels.browser.endPage": "Close page",
  "panels.browser.back": "Back",
  "panels.browser.forward": "Forward",
  "panels.browser.reload": "Reload",
  "panels.browser.address": "Address",
  "panels.browser.go": "Go",
  "panels.browser.loading": "Loading…",
  "panels.browser.readOnly":
    "View only. The agent’s manager controls this page.",
  "panels.browser.empty": "No page is open.",
  "panels.browser.title": "Browser",
  "panels.browser.close": "Close browser",
  "panels.browser.surface": "Live browser",
  "panels.editor.closeTab": "Close tab",
  "panels.editor.selectFile": "Select file",
  "panels.editor.saveHint": "Ctrl+S to save",
  "panels.editor.saved": "saved",
  "panels.editor.recentlyOpened": "Recently opened",
  "panels.editor.staleBanner":
    "File changed on disk since you opened it. Reloading will discard your edits.",
  "panels.editor.externalBanner":
    "File changed externally - your edits will be lost if you reload.",
  "panels.editor.deletedBanner":
    "File was deleted on disk. Saving will recreate it from this buffer.",
  "panels.editor.overwrite": "Overwrite",
  "panels.editor.reload": "Reload",
  "panels.editor.saveToRecreate": "Save to recreate",
  "panels.editor.saveFailed": "Save failed: {reason}",
  "panels.editor.saveError": "save failed",
  "panels.editor.openError": "{path}: {reason}",
  "panels.editor.openFailed": "failed to open",
  "subscription.plan": "Plan: {plan}",
  "subscription.caveat": "This is account-wide, not per agent.",
  "subscription.chooserHint": "Which limit the number tracks:",
  "subscription.autoChoice": "Auto (most constrained)",
  "subscription.unknown":
    "Plan usage not reported yet. It updates when the agent finishes a turn - sessions without plan limits (API key, Bedrock, Vertex) never report one.",
  "subscription.readingAge": "Reading taken {age} ago.",
  "subscription.ariaTracked":
    "{label} plan allowance {used}% used. Tap for details.",
  "subscription.ariaTrackedPinned":
    "{label} plan allowance {used}% used, pinned. Tap for details.",
  "subscription.ariaUnknown": "Plan usage not reported yet. Tap for details.",
  "subscription.window.used": "{label}: {percent}% used",
  "subscription.window.usedResets": "{label}: {percent}% used - resets {at}",
  "subscription.window.usedResetsIn":
    "{label}: {percent}% used - resets {at} (in {duration})",
  "subscription.duration.hours.one": "{count} hour",
  "subscription.duration.hours.other": "{count} hours",
  "subscription.duration.minutes": "{count} min",
  "subscription.duration.daysHours": "{days} {hours}",
  "subscription.duration.hoursMinutes": "{hours} {minutes}",
  "logView.editAgent": "Edit agent",
  "panels.editor.noFileOpen": "No file open",
  "panels.editor.emptyHint":
    "No file open. Use <code>{command}</code> or have the agent send one.",
  "logView.queue.count": "{count} queued",
  "logView.queue.chip": "queued · {label}",
  "logView.queue.attachments.one": "{count} attachment",
  "logView.queue.attachments.other": "{count} attachments",
  "logView.backendTitle": "Backend: {backend}",
  "cards.markdown.rendering": "Rendering diagram…",
  "cards.subagent.pill": "subagent",
  "cards.subagent.pillTyped": "subagent · {type}",
  "cards.subagent.title": "Subagent",
  "cards.subagent.titleTyped": "Subagent ({type})",
  "cards.subagent.titleDescribed": "Subagent: {description}",
  "cards.subagent.titleTypedDescribed": "Subagent ({type}): {description}",
  "cards.fileView.viewedFile": "Viewed {file} (click to show)",
  "cards.fileView.viewedImages":
    "Viewed {count} attached images (click to show)",
  "office.newRoom.door": "New room",
  "office.newRoom.title": "Open new room?",
  "office.newRoom.confirm": "Open room",
  "office.newRoom.failed": "Could not open the room. Try again.",
  "office.tabs.scrollLeft": "Scroll rooms left",
  "office.tabs.scrollRight": "Scroll rooms right",
  "office.tabs.roomSettings": "Double-click for room settings",
  "office.tabs.closeEmptyRoom": "Close empty room",
  "office.tabs.newRoom": "Create new room",
  "office.tabs.onlineUsers.one": "{count} online member",
  "office.tabs.onlineUsers.other": "{count} online members",
  "office.zoom.in": "Zoom in",
  "office.zoom.inShortcut": "Zoom in (+)",
  "office.zoom.out": "Zoom out",
  "office.zoom.outShortcut": "Zoom out (-)",
  "office.zoom.reset": "Reset view (0)",
  "office.zoom.resetAria": "Reset view",
  "office.openWebsite": "Open isomux.com",
  "office.skin.label": "Room look",
  "office.skin.office": "Office",
  "office.skin.hospital": "Hospital",
  "office.pet.label": "Room pet",
  "office.pet.species.cat": "Cat",
  "office.pet.species.dog": "Dog",
  "office.pet.species.rabbit": "Rabbit",
  "office.pet.species.tortoise": "Tortoise",
  "office.pet.coat": "{species} {number}",
  "office.pet.coatAria": "{species} coat {number}",
  "office.desk.swapBadge": "SWAP",
  "office.status.working": "working",
  "office.status.waiting": "waiting",
  "office.status.error": "error",
  "office.status.idle": "idle",
  "office.status.errShort": "err",
  "office.hints.tap": "TAP → open",
  "office.hints.longPress": "LONG-PRESS → actions",
  "office.hints.pinch": "PINCH → zoom",
  "office.hints.dragZoomed": "DRAG (zoomed) → pan",
  "office.hints.click": "CLICK → open agent",
  "office.hints.dragSwap": "DRAG → swap desks or move to door",
  "office.hints.wheel": "WHEEL / +- → zoom",
  "office.hints.drag": "DRAG → pan",
  "office.hints.rightClick": "RIGHT-CLICK → actions",
  "office.hints.resetView": "0 → reset view",
  "office.pendingPrompt.permission": "permission",
  "office.pendingPrompt.resume": "session",
  "office.pendingPrompt.model": "model",
  "office.pendingPrompt.effort": "effort",
  "office.pendingPrompt.cronjob": "cronjob",
  "office.pet.default": "Default",
  "contextMenu.editAgent": "Edit Agent...",
  "contextMenu.newConversation": "New Conversation",
  "contextMenu.newEngineConversation": "New {engine} Conversation",
  "contextMenu.resume": "Resume",
  "common.current": "(current)",
  "contextMenu.branched": "(branched)",
  "contextMenu.killAgent": "Kill Agent",
  "app.reconnecting": "Reconnecting…",
  "themes.dark": "Dark",
  "themes.light": "Light",
  "themes.nord": "Nord",
  "themes.dracula": "Dracula",
  "themes.solarizedDark": "Solarized Dark",
  "themes.solarizedLight": "Solarized Light",
  "common.unknownSize": "unknown size",
  "common.edit": "Edit",
  "schedules.tab.runs": "runs",
  "schedules.tab.cronjobs": "schedules",
  "schedules.anyMoment": "in any moment",
  "schedules.createdByFor": "{creator} · for {user}",
  "schedules.running": "running…",
  "schedules.newButton": "+ New",
  "schedules.filterLabel": "Schedule:",
  "schedules.empty": 'No schedules yet. Click "+ New" to create one.',
  "schedules.runsEmpty": "No runs yet.",
  "schedules.enabledToggle": "Enabled (click to pause)",
  "schedules.pausedToggle": "Paused (click to enable)",
  "schedules.inFlight": "running",
  "schedules.runNow": "Run now",
  "schedules.run": "Run",
  "schedules.deleted": "(deleted)",
  "schedules.col.name": "NAME",
  "schedules.col.schedule": "SCHEDULE",
  "schedules.col.lastRun": "LAST RUN",
  "schedules.col.nextRun": "NEXT RUN",
  "schedules.col.runs": "RUNS",
  "schedules.col.by": "BY",
  "schedules.col.status": "S",
  "schedules.col.trigger": "T",
  "schedules.col.started": "STARTED",
  "schedules.col.preview": "PREVIEW",
  "schedules.col.duration": "DURATION",
  "schedules.prevPage": "← Prev",
  "schedules.nextPage": "Next →",
  "schedules.paused": "paused",
  "schedules.status.running": "Running",
  "schedules.status.completed": "Completed",
  "schedules.status.failed": "Failed",
  "schedules.status.timedOut": "Timed out",
  "schedules.status.skipped": "Skipped",
  "schedules.trigger.manual": "manual",
  "schedules.trigger.manualBy": "manual · {who}",
  "schedules.trigger.scheduled": "scheduled",
  "schedules.runNumber": "Run #{id}",
  "schedules.promptLabel": "PROMPT",
  "schedules.snapshot":
    "cwd: {cwd} · model: {model} · effort: {effort} · permission: {permission}",
  "schedules.errorLine": "Error: {reason}",
  "schedules.runSkipped": "This run was skipped.",
  "schedules.noEntries": "No log entries.",
  "schedules.runningDots": "Running...",
  "schedules.editingAbove": "Editing message above...",
  "schedules.followUp": "Send a follow-up",
  "schedules.waitToFollowUp":
    "Run in progress - wait for it to finish before sending a follow-up.",
  "schedules.skippedNoSession": "Skipped runs have no session to resume.",
  "schedules.noSession":
    "This run can't be resumed (no session was established).",
  "common.back": "Back",
  "apps.openApp": "Open app",
  "apps.openOnNetwork": "Open on this network",
  "apps.preview.notRunning": "Preview unavailable: app is not running.",
  "apps.preview.noBrowser": "Preview unavailable: Chrome is not installed.",
  "apps.preview.unreachable": "Preview unavailable: the app is not responding.",
  "apps.preview.busy": "Preview is busy. Try again.",
  "apps.preview.failed": "Preview could not be captured.",
  "apps.preview.queued": "Preview queued…",
  "apps.preview.capturing": "Capturing preview…",
  "apps.preview.retrying": "Preview is busy. Retrying…",
  "apps.preview.tryAgain": "Try again",
  "apps.preview.label": "Screenshot preview",
  "apps.hidePreviews": "Hide app previews",
  "apps.showPreviews": "Show app previews",
  "apps.previewsOn": "previews on",
  "apps.previewsOff": "previews off",
  "apps.empty": "No apps yet.",
  "apps.loadFailed": "Could not load apps.",
  "apps.deleteFailed": "Could not delete.",
  "apps.logReadFailed": "Could not read the log.",
  "apps.state.running": "running",
  "apps.state.starting": "starting",
  "apps.state.stopped": "stopped",
  "apps.state.failed": "failed",
  "apps.state.unknown": "unknown",
  "apps.meta.port": "port",
  "apps.meta.createdBy": "created by",
  "apps.meta.owner": "owner",
  "apps.openAgent": "Open the agent",
  "apps.commandIn": "in {cwd}",
  "apps.verb.start": "start",
  "apps.verb.stop": "stop",
  "apps.verb.restart": "restart",
  "apps.verbTitle.start": "Run the app",
  "apps.verbTitle.stop": "Shut the app down (its data is kept)",
  "apps.verbTitle.restart": "Stop the app and start it again",
  "apps.showLog": "Show the app's recent output",
  "apps.hideLog": "hide log",
  "apps.log": "log",
  "apps.removeTitle": "Remove the app",
  "apps.delete": "delete",
  "apps.cancel": "cancel",
  "apps.logEmpty": "Nothing in the log yet.",
  "apps.confirmDelete":
    "Delete {name}? Its data is not erased: it moves to {path} on the office's disk.",
  "tasks.status.open": "Open",
  "tasks.status.inProgress": "In Progress",
  "tasks.status.backlog": "Backlog",
  "tasks.status.done": "Done",
  "tasks.unknownRoom": "Unknown room",
  "tasks.newTask": "New Task",
  "tasks.idCopied": "Copied!",
  "tasks.copyId": "Copy task ID",
  "tasks.field.title": "Title",
  "tasks.field.createIn": "Create in",
  "tasks.field.room": "Room",
  "tasks.field.description": "Description",
  "tasks.field.priority": "Priority",
  "tasks.field.status": "Status",
  "tasks.field.assignee": "Assignee",
  "tasks.global": "Global (office-wide)",
  "tasks.moveToRoom": "Move this task to another room",
  "tasks.priorityNone": "None",
  "tasks.unassigned": "Unassigned",
  "tasks.showRecentAgents": "Show only recent agents",
  "tasks.showAllAgents": "Show all agents",
  "tasks.showLess": "show less",
  "tasks.moreAgents": "+{count} more",
  "tasks.discardPrompt": "Discard unsaved changes?",
  "tasks.discard": "Discard",
  "tasks.create": "Create",
  "tasks.confirmDelete": "Confirm?",
  "tasks.globalShort": "Global",
  "tasks.heading": "Tasks",
  "tasks.shownCount": "{count} shown",
  "tasks.quickAdd": "Quick add a task…",
  "tasks.fileIn": "file in",
  "tasks.fileInTitle": "New tasks are filed in this room",
  "tasks.hintMobile": "Enter to add details",
  "tasks.hintDesktop": "Enter to add details · n to focus",
  "tasks.scopeTitle": "Filter tasks and set where new tasks are filed",
  "tasks.allRooms": "All rooms",
  "tasks.filterActive": "Open + In Progress",
  "tasks.filterAll": "All",
  "tasks.filterAssignee": "Filter assignee...",
  "tasks.searchPlaceholder": "Search tasks...",
  "tasks.col.status": "S",
  "tasks.col.priority": "P",
  "tasks.col.title": "TITLE",
  "tasks.col.assignee": "ASSIGNEE",
  "tasks.col.by": "BY",
  "tasks.col.age": "AGE",
  "tasks.empty": "No tasks",
  "tasks.roomChipTitle": "Room: {room}",
  "tasks.globalChipTitle": "Office-global task",
  "tasks.createdFor": "{who} · for {target}",
  "office.newAgent": "New Agent",
  "apps.actionFailed.start": "Could not start.",
  "apps.actionFailed.stop": "Could not stop.",
  "apps.actionFailed.restart": "Could not restart.",
  "common.untitledConversation": "Untitled conversation",
  "schedules.human.daily": "Daily at {time}",
  "schedules.human.weekly": "Weekly {weekday} at {time}",
  "schedules.human.everyMinutes": "Every {minutes}m",
  "schedules.human.everyHours": "Every {hours}h",
  "schedules.human.everyHoursMinutes": "Every {hours}h{minutes}m",
  "schedules.nextRunIn": "in {duration}",

  // --- S7: text the server writes for a signed-in reader -------------------
  // Slash-command descriptions, keyed by command name through
  // shared/i18n/command-keys.ts. The registry in server/commands.ts holds the
  // structure (type, supported, autocomplete, handler); the words live here.
  "commands.clear.description": "Wipe conversation history",
  "commands.context.description": "Visualize context window usage",
  "commands.help.description": "List all available commands",
  "commands.resume.description": "Pick up a previous session",
  "commands.login.description": "Show how to (re-)authenticate this agent",
  "commands.logout.description": "Manage sign-in or sign out",
  "commands.isomuxAllHands.description":
    "Summary of all agents and their conversations",
  "commands.isomuxSystemPrompt.description":
    "Show the full system prompt this agent receives",
  "commands.isomuxCronjobSystemPrompt.description":
    "Show the system prompt a schedule receives (pass name or id)",
  "commands.isomuxDiff.description":
    "Peek uncommitted changes in the agent's cwd (or pass a directory)",
  "commands.isomuxEdit.description":
    "Open a file in the editor side panel (relative to cwd, absolute, or ~/...)",
  "commands.isomuxUsage.description":
    "Per-agent / per-room / per-schedule token spend",
  "commands.isomuxStorage.description":
    "Disk space the office is using, broken down by category",
  "commands.compact.description": "Compress context",
  "commands.compact.message":
    "`/compact` is not yet supported in Isomux. Context is auto-compacted by the SDK.",
  "commands.branch.description": "Branch conversation into new session",
  "commands.fork.description": "Branch conversation into new session",
  "commands.export.description": "Export conversation to file",
  "commands.plan.description": "Toggle plan mode",
  "commands.rename.description": "Rename current session",
  "commands.reset.description": "Reset conversation",
  "commands.new.description": "Start new conversation",
  "commands.model.description": "Switch model",
  "commands.fast.description": "Toggle speed-optimized mode",
  "commands.effort.description": "Set thinking effort level",
  "commands.advisor.description": "Toggle advisor mode",
  "commands.cost.description": "Token usage and cost estimate",
  "commands.cost.message":
    "`/cost` is a Claude Code command for API users. Isomux uses subscription-based billing.",
  "commands.usage.description": "Where to check subscription and office usage",
  "commands.stats.description": "Usage patterns over time",
  "commands.extraUsage.description": "Extra usage options",
  "commands.rateLimitOptions.description": "Rate limit configuration",
  "commands.diff.description":
    "Peek uncommitted changes in the agent's cwd (or pass a directory)",
  "commands.rewind.description": "Undo changes and revert conversation",
  "commands.checkpoint.description": "Undo changes and revert conversation",
  "commands.copy.description": "Copy last response to clipboard",
  "commands.files.description": "List files in context",
  "commands.addDir.description": "Add additional working directories",
  "commands.btw.description": "Ask without polluting main context",
  "commands.config.description": "Open settings interface",
  "commands.settings.description": "Open settings interface",
  "commands.hooks.description": "Manage lifecycle hooks",
  "commands.permissions.description": "Manage tool permissions",
  "commands.keybindings.description": "Edit key bindings",
  "commands.memory.description": "View/edit persistent memory",
  "commands.mcp.description": "Manage MCP server connections",
  "commands.ide.description": "Manage IDE integrations",
  "commands.agents.description": "Manage custom subagents",
  "commands.skills.description": "List all available skills",
  "commands.sandbox.description": "Manage sandbox settings",
  "commands.privacySettings.description": "Manage privacy settings",
  "commands.theme.description": "Change color theme",
  "commands.color.description": "Change color theme",
  "commands.vim.description": "Toggle vim keybindings",
  "commands.terminalSetup.description": "Configure terminal integration",
  "commands.reloadPlugins.description": "Reload installed plugins",
  "commands.reloadPlugins.message":
    "To reload plugins, open the built-in terminal (click the terminal icon on the agent's desk), run `claude`, and type `/reload-plugins`.",
  "commands.tasks.description": "List/manage background tasks",
  "commands.bashes.description": "List/manage background tasks",
  "commands.doctor.description": "Check installation health",
  "commands.feedback.description": "Report bugs to Anthropic",
  "commands.bug.description": "Report bugs to Anthropic",
  "commands.releaseNotes.description": "View release notes",
  "commands.heapdump.description": "Dump heap for debugging",
  "commands.status.description": "Show system status",
  "commands.tag.description": "Tag current conversation",
  "commands.init.description": "Initialize Claude Code in a project",
  "commands.installGithubApp.description": "Set up Claude GitHub PR review app",
  "commands.prComments.description": "View PR comments",
  "commands.desktop.description": "Open desktop app",
  "commands.mobile.description": "Open mobile app",
  "commands.chrome.description": "Open Chrome extension",
  "commands.session.description": "Manage sessions",
  "commands.teleport.description": "Transfer session to another device",
  "commands.remoteEnv.description": "Configure remote environment",
  "commands.exit.description": "Exit Claude Code",
  "commands.exit.message":
    "Use the Isomux UI to manage agents. `/exit` only works in the Claude Code CLI.",
  "commands.stickers.description": "Fun stickers",
  "commands.upgrade.description": "Upgrade Claude Code",
  "commands.plugin.description": "Manage plugins",
  "commands.plugin.message":
    "Plugin management requires the Claude Code CLI directly.\n\nTo manage plugins:\n1. Open the built-in terminal (click the terminal icon on the agent's desk)\n2. Run `claude`\n3. Type `/plugin` to browse, install, enable, or disable plugins\n\nUseful commands:\n- `/plugin` - interactive plugin manager (browse, install, enable/disable)\n- `{addCommand}` - install a plugin by name\n- `/plugin marketplace add owner/repo` - add a community marketplace\n\nAfter installing a plugin, run `/reload-plugins` inside the Claude session to activate it.",
  "commands.batch.description": "Decompose into parallel worktree agents",
  "commands.claudeApi.description":
    "Load API/SDK reference for detected language",
  "commands.claudeInChrome.description": "Automate Chrome browser interactions",
  "commands.debug.description": "Diagnose session/tool issues from debug log",
  "commands.keybindingsHelp.description": "Customize keyboard shortcuts",
  "commands.loop.description": "Run a prompt on a recurring schedule",
  "commands.loop.message":
    "not supported natively; see if the Schedules page or scheduled messages satisfy your use case",
  "commands.loremIpsum.description": "Generate placeholder text",
  "commands.review.description": "Code review for bugs, logic, and edge cases",
  "commands.schedule.description": "Create cron-scheduled remote agents",
  "commands.securityReview.description": "Security-focused code review",
  "commands.simplify.description": "Code cleanup and reuse analysis",
  "commands.skillify.description": "Capture processes as reusable skills",
  "commands.stuck.description": "Diagnose frozen/slow sessions",
  "commands.ultrareview.description": "Ultra-thorough PR review",
  "commands.updateConfig.description": "Configure settings.json",

  // The type-aware refusal for a command Isomux does not implement. Every
  // registry command carries a description, so the parenthetical is always
  // filled; `unknownCommand` is the branch for a name the registry never had.
  "commands.unsupported.hardcoded":
    "`/{name}` ({description}) is a Claude Code command, but it's not supported in Isomux.",
  "commands.unsupported.bundledSkill":
    "`/{name}` ({description}) is a Claude Code bundled skill, but it's not supported in Isomux. You can override it by creating your own skill file.",
  "commands.unsupported.notAvailable": "`/{name}` is not available in Isomux.",
  "commands.unsupported.unknownCommand":
    "Unknown command `/{name}`. Type `/help` to see available commands.",

  // /clear (also /reset, /new)
  "commands.clear.failed": "Failed to clear conversation: {error}",
  "commands.clear.done": "Conversation cleared.",

  // /context
  "commands.context.header": "**{model}** - {used} / {max} tokens ({percent}%)",
  "commands.context.noSession": "No active session.",
  "commands.context.unavailable":
    "Context usage not available for this session.",
  "commands.context.staleUnavailable":
    "Live measurement unavailable. Showing the last committed reading, sampled {age}.",
  "commands.context.staleFailed":
    "Live measurement failed. Showing the last committed reading, sampled {age}.",
  "commands.context.ageUnderMinute": "less than a minute ago",
  "commands.context.ageMinutes": "{minutes}m ago",
  "commands.context.ageHoursMinutes": "{hours}h {minutes}m ago",
  "commands.context.category": "{name}: {tokens} tokens ({percent}%)",
  "commands.context.memoryFiles": "**Memory files:**",
  "commands.context.memoryFile": "{path} ({tokens} tokens)",
  "commands.context.systemPrompt": "**System prompt:**",
  "commands.context.systemPromptSection": "{name}: {tokens} tokens",
  "commands.context.autoCompact":
    "Auto-compact at {percent}% ({tokens} tokens)",
  "commands.context.failed": "Failed to get context usage: {error}",

  // /help. The URLs are passed in from the call site rather than written here
  // (ruling 11), so a link change never edits three catalogs.
  "commands.help.docs": "**Docs:** {url}",
  "commands.help.tipPhoneVpn":
    "Isomux works on your phone. The easiest way is to connect it to the same VPN (e.g., Tailscale - free) as the machine running it.",
  "commands.help.tipPhoneOrigin": "Isomux works on your phone: open {origin}.",
  "commands.help.header": "**Help**",
  "commands.help.commands": "## Commands you can type",
  "commands.help.skills": "## Your skills",
  "commands.help.receptionist":
    "If you have questions about Isomux features like how to link other devices, how to invite other people to your office, how agents communicate with each other, how to connect your LLM providers, etc., ask the Receptionist agent.",
  "commands.help.aliasGroup": "{primary} (or {others})",
  "commands.help.skillsUser": "User skills",
  "commands.help.skillsProject": "Project skills",
  "commands.help.skillsPlugin": "Plugin skills",
  "commands.help.skillsIsomux": "Isomux skills",
  "commands.help.skillsClaude": "Claude skills",

  // /resume
  "commands.resume.none": "No previous sessions found.",
  "commands.resume.header": "Resume a past conversation:",
  "commands.resume.noOthers": "No other sessions to resume.",
  "commands.resume.branched": "(branched)",

  // /model
  "commands.model.openCodeUnsupported":
    "Open agent settings to select a connected OpenCode model.",
  "commands.model.header": "Switch model (current: **{current}**):",

  // /effort
  "commands.effort.openCodeSettings":
    "OpenCode effort choices are available in agent settings for models that expose them.",
  "commands.effort.header": "Switch thinking effort (current: **{current}**):",

  // /isomux-all-hands
  "commands.isomuxAllHands.room": "**=== Room {number} ===**",
  "commands.isomuxAllHands.me": "**(me)**",
  "commands.isomuxAllHands.desk": "desk {number}",
  "commands.isomuxAllHands.topic": "Topic: {topic}",
  "commands.isomuxAllHands.footer":
    "Ask your agent if you'd like to know more about any agent or conversation.",

  // /isomux-system-prompt. The prompt itself is agent-facing and stays English.
  "commands.isomuxSystemPrompt.header":
    "**Full system prompt** *(reflects current settings; takes effect on next conversation)*",

  // /isomux-cronjob-system-prompt
  "commands.isomuxCronjobSystemPrompt.noSchedules":
    "No schedules are configured.",
  "commands.isomuxCronjobSystemPrompt.pick": "Choose a schedule:",
  "commands.isomuxCronjobSystemPrompt.ambiguous":
    'Multiple schedules are named "{query}". Re-run with the id:',
  "commands.isomuxCronjobSystemPrompt.noMatch":
    "No schedule matches `{query}`. Try `/isomux-cronjob-system-prompt` with no argument to list schedules.",
  "commands.isomuxCronjobSystemPrompt.header":
    '**System prompt + first user message for schedule "{name}"** *(reflects current settings; takes effect on next run)*',
  "commands.isomuxCronjobSystemPrompt.firstUserMessage": "First user message:",

  // /isomux-edit
  "commands.isomuxEdit.usage":
    "Usage: {usage}. Path can be relative (resolves against {cwd}), absolute, or `~/...`.",
  "commands.isomuxEdit.emptyPath": "Empty path.",
  "commands.isomuxEdit.notFound": "`{path}` does not exist.",
  "commands.isomuxEdit.notFile": "`{path}` is not a file.",
  "commands.isomuxEdit.binary":
    "`{path}` is a binary file - the editor panel only supports text.",
  "commands.isomuxEdit.tooLarge":
    "`{path}` is {size} - too large for the editor panel (1 MB limit).",
  "commands.isomuxEdit.ioError": "Failed to open `{path}`: {message}",

  // /isomux-diff (also /diff)
  "commands.isomuxDiff.notDirectory": "`{path}` is not a directory.",
  "commands.isomuxDiff.notRepo": "`{path}` is not a git repository.",
  "commands.isomuxDiff.gitError": "Failed to run git diff in `{path}`:",
  "commands.isomuxDiff.clean":
    "Working tree clean in `{path}` - no uncommitted changes.",

  // /usage
  "commands.usage.heading": "**Subscription plan limits aren't shown here.**",
  "commands.usage.intro":
    "To check your Claude or ChatGPT subscription quota, open the embedded terminal and:",
  "commands.usage.claude": "launch `claude`, then type `/usage`",
  "commands.usage.codex": "launch `~/.isomux/bin/codex`, then type `/status`",
  "commands.usage.office":
    "For office-level token spend (per-agent / per-room / per-schedule), see `/isomux-usage`.",
  "commands.usage.codexCardOmitted": "Codex `/status` card omitted: {error}",

  // /isomux-storage
  "commands.isomuxStorage.forbidden":
    "Storage usage is only available to signed-in office members.",

  // Skill dispatch (a slash command that expands to a prompt and runs a turn).
  "commands.skill.queueFailed": "Could not queue {command}: {error}",
  "commands.skill.error": "Skill error: {error}",

  // Choice interactions, keyed by AgentChoiceInteractionKind. The choice
  // LABELS a backend supplies (a permission's persistent-allow wording, a live
  // model list) stay as delivered; only what Isomux writes is here.
  "choices.resume.title": "Resume a conversation",
  "choices.resume.instruction":
    "Reply with a number to resume, or anything else to cancel.",
  "choices.resume.branched": "Branched",
  "choices.model.title": "Switch model",
  "choices.model.instruction":
    "Reply with a number to switch, or anything else to cancel.",
  "choices.effort.title": "Switch thinking effort",
  "choices.cronjob.title": "Choose a schedule",
  "choices.cronjob.instruction":
    "Reply with a number to view its prompt, or anything else to cancel.",
  "choices.permission.title": "Wants to use {tool}",
  "choices.permission.instruction":
    "Choose an option, or type any other message to deny with that as the reason.",
  "choices.permission.reply": "Reply:",
  "choices.permission.allowOnce": "Allow - just this time",
  "choices.permission.deny": "Deny",
  "choices.permission.allowPrefix":
    "Allow - and don't ask again this session for any command starting with `{prefix}`",
  "choices.permission.prefixHint":
    "Reply `{replySpec}` to choose how much to allow, e.g. `{index} {example}`.",
  "choices.permission.denyByMessage":
    "Or type any other message to deny with that as the reason.",

  // Lifecycle entries the server writes into an agent's log. Most have no
  // actor - a backend event or a route call produced them - so they are worded
  // for the agent's owner (internal-docs/i18n-loop.md, S7).
  "systemEntries.conversationCleared": "Conversation cleared.",
  "systemEntries.newConversation": "New conversation started.",
  "systemEntries.agentStopped": "Agent stopped: {status}.",
  "systemEntries.backendFailure.stoppedDuringTurn":
    "The agent backend stopped during the turn. The conversation is saved and can be resumed.",
  "systemEntries.backendFailure.sigterm":
    "The agent backend was terminated by SIGTERM (exit code {code}). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
  "systemEntries.backendFailure.sigkill":
    "The agent backend was killed by SIGKILL (exit code {code}). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
  "systemEntries.backendFailure.signal":
    "The agent backend was stopped by signal {signal} (exit code {code}). The conversation is saved and can be resumed.",
  "systemEntries.backendFailure.providerCapacity":
    "The model provider is at capacity. That is on the provider's side, not this account's subscription or rate limits. Retry in a minute or pick another model. The conversation is saved and can be resumed.",
  "systemEntries.providerCapacityRetry":
    "The model provider is at capacity. Retrying in {seconds} seconds ({attempt}/{maxAttempts}).",
  "systemEntries.agentReady":
    'Agent "{name}" ready. Working in {cwd}. Permission mode: {mode}.',
  "systemEntries.streamError": "Stream error: {error}",
  "systemEntries.startFailed": "Failed to start: {error}",
  "systemEntries.interrupted": "Agent interrupted.",
  "systemEntries.wake.idle":
    "Resumed your session (it was released while idle to save memory).",
  "systemEntries.wake.afterRestart":
    "Resumed your session after the server restarted.",
  "systemEntries.wake.afterBackendEnded":
    "Resumed your session after the backend ended unexpectedly.",
  "systemEntries.wake.inFlightWarning":
    "Any command that was in flight may have partially run; verify its effects before retrying.",
  "systemEntries.wake.shutdownRejection":
    "The 'user rejected' result just above is from the shutdown, not a human.",
  "systemEntries.wake.resumedBeforeFlush":
    "Resumed prior session before flushing queued messages.",
  "systemEntries.wake.resumedAfterUnexpectedEnd":
    "Resumed prior session after the previous one ended unexpectedly.",
  "systemEntries.codexInterruptExited":
    "Codex exited during interrupt - installing a fresh session.",
  "systemEntries.codexInterruptExitedWithError":
    "Codex exited during interrupt: {error}",
  "systemEntries.previousInterrupted": "Previous response was interrupted.",
  "systemEntries.interruptedPermissionDenied":
    "Agent interrupted; the pending permission request was denied.",
  "systemEntries.interruptedPermissionRestarted":
    "Agent interrupted; the pending permission request could not be denied, so the agent's backend was restarted; the conversation is preserved.",
  "systemEntries.interruptHandlerFailed": "Interrupt handler failed: {error}",
  "systemEntries.codexInterruptFallback":
    "Codex didn't honor the interrupt in time; falling back to a fresh session.",
  "systemEntries.deliveryStalled": "Message delivery stalled; recovering.",
  "systemEntries.freshSessionAfterRestoreFailure":
    "Started a fresh session (previous one could not be restored).",
  "systemEntries.freshSessionBeforeFlush":
    "Started a fresh session before flushing queued messages.",
  "systemEntries.flushStartFailed":
    "Cannot start session to flush queue: {error}",
  "systemEntries.restartingForSettings":
    "Restarting session to apply settings; queued messages will send after the restart.",
  "systemEntries.flushError": "Error flushing queue: {error}",
  "systemEntries.genericError": "Error: {error}",
  "systemEntries.restoreOnStartupFailed":
    "Failed to restore on startup: {error}\nType /clear to start fresh, or /resume to pick another session.",
  "systemEntries.flushInterrupted":
    "Queue flush interrupted by session change; will retry.",
  "systemEntries.sessionStartFailed":
    "Cannot start session: {error}\nType /clear to start fresh, or /resume to pick another session.",
  "systemEntries.queueFailed": "Could not queue message: {error}",
  "systemEntries.queueCleared.notConfigured.one":
    "Cleared {count} queued message because the backend is not configured.",
  "systemEntries.queueCleared.notConfigured.other":
    "Cleared {count} queued messages because the backend is not configured.",
  "systemEntries.queueCleared.switching.one":
    "Cleared {count} queued message when switching to another session.",
  "systemEntries.queueCleared.switching.other":
    "Cleared {count} queued messages when switching to another session.",
  "systemEntries.contextCompacted": "Context compacted: {summary}",
  "systemEntries.contextCompactedNoSummary": "Context compacted.",
  "systemEntries.toolCallDenied": "Tool call denied: {tool}",
  "systemEntries.toolCallDeniedWithReason":
    "Tool call denied: {tool} ({reason})",
  "systemEntries.inputRequest":
    "The backend requested interactive input that Isomux cannot display safely.",
  "systemEntries.permissionRequested":
    "Permission requested for {tool}. Input: {input}.",
  "systemEntries.diffEmptyCommit":
    "`{commit}` introduced no file changes (empty commit?).",
  "systemEntries.permissionOutcome.allowPersistent":
    "Allow similar calls for this session",
  "systemEntries.permissionOutcome.allowPrefix":
    "Allow a command prefix for this session",
  "systemEntries.permissionOutcome.denyWithReason": "Deny with a reason",
  "systemEntries.permissionOutcome.denyWhenStopped": "Deny when stopped",
  "systemEntries.permissionOutcome.sessionChanged":
    "Canceled when the session changed",
  "systemEntries.permissionOutcome.priorSessionStopped":
    "Canceled while the prior session stopped",
  "systemEntries.permissionOutcome.sessionEnded":
    "Canceled because the session ended",
  "systemEntries.permissionOutcome.turnStopped":
    "Canceled when the turn stopped",
  "systemEntries.permissionOutcome.agentKilled":
    "Canceled when the agent was killed",
  "systemEntries.permissionOutcome.failed": "Failed to resolve",
  "systemEntries.permissionChoice": "Permission choice: {label}.",
  "systemEntries.permissionGrantedOnce": "Permission granted (once).",
  "systemEntries.permissionGrantedPersistent":
    "Permission granted (rule added for this session).",
  "systemEntries.permissionDenied": "Permission denied.",
  "systemEntries.permissionDeniedWithReason":
    "Permission denied with reason forwarded to agent.",
  "systemEntries.permissionSessionGone":
    "Permission could not be resolved - session is gone.",
  "systemEntries.permissionResolveFailed":
    "Failed to resolve permission: {error}",
  "systemEntries.resumedSession": "Resumed session: {label}",
  "systemEntries.resumeFailed": "Failed to resume: {error}",
  "systemEntries.resumeCancelled": "Resume cancelled.",
  "systemEntries.resumeCwdUnavailable":
    "Session's saved directory `{stored}` is unavailable ({error}); resuming in `{previous}`.",
  "systemEntries.alreadyUsing": "Already using {label}.",
  "systemEntries.modelSwitched":
    "Model switched to {label}. The agent's context may still say they are a different model - the correct model is shown in the top bar.",
  "systemEntries.modelCancelled": "Model selection cancelled.",
  "systemEntries.effortSwitched": "Thinking effort switched to {label}.",
  "systemEntries.effortCancelled": "Effort selection cancelled.",
  "systemEntries.cronjobPickCancelled": "Schedule selection cancelled.",
  "systemEntries.branchedFrom": "Branched from: {label}",
  "systemEntries.branchFailed": "Failed to branch conversation: {error}",
  "systemEntries.editBusy": "Cannot edit while agent is busy.",
  "systemEntries.editNotFound": "Cannot edit: message not found.",
  "systemEntries.editNoSession": "Cannot edit: no active session.",
  "systemEntries.editPendingInteraction":
    "Cannot edit this prompt while an interactive command is pending. Answer or cancel it first.",
  "systemEntries.editNotSent":
    "Cannot edit: this message wasn't sent to the agent and newer messages followed. Send a new message instead.",
  "systemEntries.editNotLocated":
    "Cannot edit: could not locate message in backend session.",
  "systemEntries.editOtherSession":
    'This message lives in a different session ("{label}"). Use /resume to switch to it first, then edit.',
  "systemEntries.cwdMoveBackFailed":
    "Warning: after the failed cwd change, session files could not be moved back to {previous} and now live in {target}; resume may fail until they are restored.",
  "systemEntries.fileOpenFailed": "Failed to open `{path}`: {message}",
  "systemEntries.fileReadFailed": "Failed to read `{path}`: {message}",
  "systemEntries.fileTooLargeToDisplay":
    "`{path}` is {size} - too large to display ({limit} MB limit).",
  "systemEntries.fileSaveFailed": "Failed to save `{path}` for display.",
  "systemEntries.diffFailed": "Failed to run git diff in `{path}`:",
  "systemEntries.diffBadDir": "Cannot diff `{path}`: {message}.",
  "systemEntries.diffClean":
    "Working tree clean in `{path}` - no uncommitted changes.",
  "systemEntries.claudeAuth.checking":
    "Claude rejected the credentials. Checking the connection…",
  "systemEntries.claudeAuth.officeLocation":
    "Settings → Office → Office-wide connections",
  "systemEntries.claudeAuth.personalLocation":
    "Settings → You → Individual connections",
  "systemEntries.claudeAuth.disconnected":
    "Claude rejected the credentials. Sign in to Claude in {location}.",
  "systemEntries.claudeAuth.pinned":
    "This conversation keeps the Claude account it started with. Start a new conversation (`/clear`) to use the new account.",
  "systemEntries.claudeSession.invalid":
    "Cannot access this Claude conversation.",
  "systemEntries.claudeSession.missing":
    "Cannot resume Claude session {session}…: its file was not found. Paths checked: {paths}. Use /resume to select another conversation, or start a new conversation.",
  "systemEntries.claudeAuth.connected":
    "This conversation may still use the credentials it started with. Start a new conversation (`/clear`) to use the current Claude sign-in.",
  "systemEntries.claudeAuth.incomplete":
    "The Claude connection check could not finish. Retry the request or sign in to Claude in Settings.",
  "systemEntries.signInRequired":
    "{provider} could not run this message because it is not signed in. Sign in below to continue.",
  "systemEntries.manageSignIn": "Manage your {provider} sign-in below.",
  "systemEntries.alreadySignedIn":
    "You are already signed in. Manage your {provider} sign-in below.",
  "systemEntries.signOutOpenCode":
    "Sign-out is not available for OpenCode agents.",
  "systemEntries.signOutNoScope":
    "Sign-out is not available because this {provider} account scope could not be resolved.",
  "systemEntries.runInTerminal": "Run `{command}` in the built-in terminal.",

  // The commit-mode update notice (shared/update-notice.ts). Worded by
  // whichever client renders it, not by the update checker.
  "updateNotice.pill.updateAvailable": "update available",
  "updateNotice.pill.newRelease": "new release",
  "updateNotice.pill.mainAhead": "main +{count}",
  "updateNotice.title.newRelease": "New Release Available",
  "updateNotice.title.mainAhead": "Newer Commits on main",
  "updateNotice.running": "commit {sha}",
  "updateNotice.identity.noLatest": "You're on {running}.",
  "updateNotice.identity.current": "You're on {running} (latest release).",
  "updateNotice.identity.behind": "You're on {running}; {latest} is out.",
  "updateNotice.identity.aheadTagged":
    "You're on {running} (newer than the latest release, {latest}).",
  "updateNotice.identity.aheadUntagged":
    "You're on {running}, past the latest release ({latest}).",
  "updateNotice.identity.unknown":
    "You're on {running}. The latest release is {latest};",
  "updateNotice.drift.beyond.one": "main has {count} commit beyond that.",
  "updateNotice.drift.beyond.other": "main has {count} commits beyond that.",
  "updateNotice.drift.newer.one": "main has {count} newer commit.",
  "updateNotice.drift.newer.other": "main has {count} newer commits.",
  "updateNotice.drift.bleedingEdge.one":
    "main has {count} newer commit if you want the bleeding edge.",
  "updateNotice.drift.bleedingEdge.other":
    "main has {count} newer commits if you want the bleeding edge.",

  // The /isomux-storage report (server/storage-report.ts). The category names
  // are the settings.storage.category.* keys the storage panel already reads.
  "storageReport.heading": "Isomux storage",
  "storageReport.totalWithOutside":
    "**{total} total:** {stateRoot} of office state, plus {outside} in {locations}.",
  "storageReport.totalOnly": "**{total} total**, all of it office state.",
  "storageReport.locationsJoin": " and ",
  "storageReport.measured": "_Measured {age}._",
  "storageReport.columnCategory": "Category",
  "storageReport.columnSize": "Size",
  "storageReport.columnFiles": "Files",
  "storageReport.none": "none",
  "storageReport.totalOfficeState": "Total office state",
  "storageReport.total": "Total",
  "storageReport.outsideNote":
    '_Backups and update snapshots sit outside the office state directory, so they are listed after its subtotal. "none" means that location isn\'t set up on this machine._',
  "storageReport.locations": "_Locations: {paths}._",
  "storageReport.locationOfficeState": "office state",
  "storageReport.locationNotSetUp": "{label} (not set up)",
  "storageReport.ownerOnly":
    "_The per-agent breakdown and the paths are office-owner-only._",
  "storageReport.biggestAgents": "Biggest agents",
  "storageReport.columnAgent": "Agent",
  "storageReport.columnTranscripts": "Transcripts",
  "storageReport.columnAttachments": "Attachments",
  "storageReport.columnSessions": "Sessions",
  "storageReport.columnLastActivity": "Last activity",
  "storageReport.killed": "_(killed)_",
  "storageReport.showing":
    "_Showing the {shown} largest of {total} agents with stored data._",
  "storageReport.nothingDeleted":
    "_Nothing here is deleted automatically. Transcripts and attachments are only removed when an office owner asks for it._",
  "storageReport.unknownSize": "unknown size",

  // --- S9: the pre-sign-in pages the server renders itself -----------------
  // The claim page, the invite-accept page, the login page and the three
  // error pages of the same flow. No picker (ruling 5): the language comes
  // from the visitor's Accept-Language header, or from their stored
  // preference on the pages that can know them. The common.* keys here are
  // common because two of those pages share the byte-identical string
  // (ruling 15), not because anything outside this flow uses them yet.
  "common.continue": "Continue",
  "common.displayName": "Display name",
  "common.returnToOffice": "Return to office",
  "common.welcomeNewOffice": "Welcome to your new Isomux office",
  "common.titleFirstTimeSetup": "first-time setup",
  "common.titleInvite": "invite",
  "common.ogTitleFirstTimeSetup": "Isomux - first-time setup",
  "preAuth.login.title": "sign in",
  "preAuth.login.openInvite": "Open an invite link to sign in on this device.",
  "preAuth.login.alreadySignedIn":
    "Already signed in elsewhere? Create invite links for your other devices in Settings.",
  "preAuth.login.askOwner": "Otherwise, ask the office owner for one.",
  "preAuth.login.noOwner": "No office owner has been set up yet.",
  "preAuth.login.claimHere": "Open {link} to claim ownership.",
  "preAuth.login.claimHereLink": "this office's home page",
  "preAuth.login.sshHint":
    "If you're trying to reach this office from another machine, you'll need to SSH-tunnel first (the claim form is only reachable from loopback). The server's startup log spells out the exact {command} command.",
  "preAuth.claim.intro":
    "You're the first person to claim this office. Pick a display name; it'll appear next to anything you say.",
  "preAuth.claim.ogDescription": "Claim ownership of a new Isomux office.",
  "preAuth.claim.errorOwnerExists":
    "An office owner already exists. Refresh and sign in with an invite link instead.",
  "preAuth.claim.errorName":
    "Please pick a display name (letters, numbers, spaces, periods, hyphens, apostrophes, or underscores).",
  "preAuth.invite.titleAccept": "accept invite",
  "preAuth.invite.bootstrapIntro":
    "You're the first person to claim this office. Pick a display name - it'll appear next to anything you say.",
  "preAuth.invite.heading": "Open your Isomux invite",
  "preAuth.invite.headingNamed":
    "Open your invite to the Isomux office: {office}",
  "preAuth.invite.clickHint":
    "Clicking the button below will sign you in on this device.",
  "preAuth.invite.accept": "Accept and continue",
  "preAuth.invite.errorName": "Please pick a display name.",
  "preAuth.invite.ogTitleAccept": "Isomux - accept invite",
  "preAuth.invite.ogDescriptionSetup":
    "Open this link to claim ownership of an Isomux office.",
  "preAuth.invite.ogDescriptionAccept":
    "Open this link to sign in to an Isomux office on this device.",
  "preAuth.inviteError.heading": "Invite unavailable",
  "preAuth.inviteError.consumed": "This invite has already been used.",
  "preAuth.inviteError.expired": "This invite has expired.",
  "preAuth.inviteError.roleMismatch":
    "This invite can't be accepted because the existing member has a different role. Ask an office owner to mint a new invite.",
  "preAuth.inviteError.ownerExists":
    "An office owner already exists. Bootstrap invites stop working once the office has been claimed.",
  "preAuth.inviteError.generic": "This invite is no longer valid.",
  "preAuth.conflict.heading": "This invite is for a different member",
  "preAuth.conflict.body":
    "You are signed in as {current}. This invite is for {invitee}: open it on their device or in a separate browser profile.",
  "preAuth.signOutBlocked.title": "sign out blocked",
  "preAuth.signOutBlocked.heading": "Sign out blocked",
  "preAuth.signOutBlocked.lastOwnerSession":
    "Sign out refused: this is the last active office-owner session. Mint an additional invite for yourself and accept it on another device first, then retry.",
  "demo.banner.short":
    "This is a demo. To connect real Claude, Codex, and OpenCode agents:",
  "demo.banner.long":
    "This is a demo office. To connect real Claude, Codex, and OpenCode agents:",
  "demo.reply":
    "This is a demo - your message was not actually sent to Claude. To use Isomux for real, follow the setup instructions at [isomux.com](https://isomux.com).",
  "demo.receptionistReply":
    "Welcome to the lobby. In a real office I answer questions about Isomux and about this office. This is a demo, so nothing was sent to a model.",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

/** A complete translation: every English key, each with a string. */
export type Catalog = Record<MessageKey, string>;
