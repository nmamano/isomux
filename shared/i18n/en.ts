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
  "apiCall.audit.list": "Read audit log",
  "apiCall.tasks.history": "Read task history",
  "apiCall.tasks.restore": "Restore task",

  "audit.title": "Audit log",
  "audit.restore": "Restore",
  "audit.restored": "Restored",
  "audit.actorKind": "Actor kind",
  "audit.actorId": "Actor",
  "audit.ownerId": "Owner",
  "audit.targetId": "Target id",
  "audit.operation": "Operation",
  "audit.from": "From (local time)",
  "audit.to": "To (local time)",
  "audit.filter": "Filter",
  "audit.any": "Any",
  "audit.clear": "Clear",
  "audit.invalidRange": "Enter a valid time range, with From before To.",
  "audit.kind.member": "Member",
  "audit.kind.agent": "Agent",
  "audit.kind.apiToken": "API token",
  "audit.kind.cronjob": "Schedule",
  "audit.kind.webhook": "Webhook",
  "audit.kind.adminCli": "Admin CLI",
  "audit.kind.setup": "Setup",
  "audit.kind.app": "App",
  "audit.kind.secretProxy": "Secret proxy",
  "audit.kind.autoHandoff": "Automatic handoff",
  "audit.memory.office": "Office memory",
  "audit.memory.room": "Room memory",
  "audit.memory.agent": "Agent memory",
  "audit.memory.member": "Member memory",
  "audit.older": "Older",
  "audit.history": "History",
  "audit.taskCreated": "created",
  "audit.taskDeleted": "deleted",
  "audit.taskRestored": "restored",
  "audit.edited": "edited",

  "browser.offerHelp":
    "Open the tab to offer, choose All or an agent in the extension popup, and turn on Agent control.",
  "browser.allAgents": "All",
  "browser.agent": "Agent",
  "browser.expiry": "Control expires",
  "browser.expiryNever": "Never",
  "browser.expiry15": "15 minutes",
  "browser.expiry60": "1 hour",
  "browser.expiry240": "4 hours",
  "browser.expiryNeverActive": "Expires: Never",
  "browser.expiresAt": "Expires: {time}",
  "browser.officeSection": "Office",
  "browser.allow": "Agent control:",
  "browser.assigned": "ON · {name}",
  "browser.offering": "Offering tab to {name}…",
  "browser.revoking": "Turning off control for {name}…",
  "browser.tabIneligible": "Open an HTTP(S) tab to allow agent control.",
  "browser.tabConflict":
    "This agent already has a tab. Turn that tab off first.",
  "browser.control": "Agent control",
  "browser.title": "Browser Use",
  "browser.intro":
    "Let agents browse, read pages, and fill forms in your desktop Chrome using your existing logins. Offer a tab to All or one agent.",
  "browser.chromeHelp":
    "Agents use Chrome on the computers you pair. Install and pair the extension on each one.",
  "browser.setup": "Set up Chrome",
  "browser.extract": "Extract the ZIP.",
  "browser.extensions": "Open {address} in Chrome and enable Developer mode.",
  "browser.load": "Select Load unpacked and choose the extracted folder.",
  "browser.pin": "Pin Isomux Browser in the toolbar.",
  "browser.finish":
    "Create a pairing code below, then open Isomux Browser and enter the office address and code.",
  "browser.connection": "Connection",
  "browser.show": "Show",
  "browser.hide": "Hide",
  "browser.owner": "Browser owner: {name}",
  "browser.ownership":
    "Agents use their manager’s browser and only the tabs offered to them.",
  "browser.paired": "Paired",
  "browser.unpaired": "Not paired",
  "browser.offline": "Offline",
  "browser.connecting": "Connecting…",
  "browser.connected": "Connected",
  "browser.disabled": "Disconnected by member",
  "browser.blocked": "Pair again in office Integrations.",
  "browser.unknown": "Unpair result unknown. Check office Integrations.",
  "browser.download": "Download extension {version}",
  "browser.install":
    "Extract the ZIP. In desktop Chrome, open chrome://extensions, enable Developer mode, select Load unpacked and choose the extracted folder. Pin Isomux Browser in the toolbar.",
  "browser.permission":
    "Chrome warns “Read your browsing history”. The extension uses this permission to bind site-opened popups to their agent’s tab; it does not collect browsing history.",
  "browser.generate": "Create pairing code",
  "browser.replace": "Replace pairing",
  "browser.name": "Browser name",
  "browser.nameHint":
    "Optional, for example Work laptop. Agents see this name.",
  "browser.pairedOn": "Paired {date}",
  "browser.code": "Pairing code",
  "browser.expires": "Expires at {time}",
  "browser.expired": "Pairing code expired. Create a new code.",
  "browser.copy": "Copy code",
  "browser.pairHelp":
    "Open Isomux Browser and enter this office address and the pairing code.",
  "browser.office": "Office address",
  "browser.pair": "Pair Chrome",
  "browser.reconnect": "Reconnect",
  "browser.disconnect": "Disconnect",
  "browser.unpair": "Unpair",
  "browser.focus": "Show tab",
  "browser.stop": "Stop control",
  "browser.retained": "Stopping control leaves pages open.",
  "browser.offlineHelp":
    "To revoke access while offline, use the Browser Use tab in office Integrations.",
  "browser.failed":
    "Browser request failed. Check the connection and try again.",

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

Never ask for or repeat secrets (API keys, tokens, passwords). Point people to the Secrets tab of the Integrations page.`,
  "templates.receptionist.label": "Isomux Receptionist",
  "templates.receptionist.description": "Help with Isomux and this office.",
  "lobby.receptionistName": "Receptionist",
  "lobby.welcome": "WELCOME",
  "lobby.poster": "THE OFFICE",
  "common.lobby": "Lobby",
  "lobby.officeFallback": "the office",
  "lobby.directory": "DIRECTORY",
  "lobby.employeeLine1": "EMPLOYEE OF",
  "lobby.employeeLine2": "THE MINUTE",
  "lobby.openChat": "{name} - click to open the chat",
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
  "common.loadingMemory": "Loading memory…",
  "common.memory": "Memory",
  "common.memorySize": "{size} / {cap} characters",
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
  "nav.integrationsShortcut": "Integrations (i)",
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
  "common.automations": "Automations",
  "common.apps": "Apps",
  "common.changeTheme": "Change theme",

  "preferences.intro":
    "These follow you to every device you sign in from. Settings that are about this browser in particular live under Device.",
  "preferences.language": "Language",
  "preferences.languageHint":
    "The language of the interface, of what your agents write, and of voice input and playback. Agents pick it up on their next conversation.",
  "preferences.saved": "Saved.",
  "preferences.saveFailed": "Could not save",

  // The settings page shell: header, sidebar, roster, footer.
  "settings.selectHint": "Select a setting from the list",
  "settings.profilesNote":
    "Member profiles are stored on the server. Your notifications and credentials follow you across devices.",
  "settings.signOutHint": "End this device's session",
  "settings.you": "(you)",
  "settings.sidebar.office": "Office",
  "settings.sidebar.access": "Access",
  "settings.sidebar.invites": "Invites",
  "settings.sidebar.sessions": "Sessions",
  "settings.sidebar.usage": "Usage",
  "settings.sidebar.storage": "Storage",
  "settings.sidebar.updates": "Updates",
  "settings.sidebar.profile": "Profile",
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
  "settings.members.newMember": "New member",
  "settings.members.create": "Create member",
  "settings.members.neverSignedIn": "never signed in",
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
    "Displayed: which of your accessible rooms appear in your own view. Notifications: sound when an agent in that room finishes. Push: a notification on your devices when an agent in that room finishes. A room must be displayed to notify.",
  "settings.profile.roomColumn": "Room",
  "settings.profile.accessColumn": "Access",
  "settings.profile.displayedColumn": "Displayed",
  "settings.profile.notificationsColumn": "Notifications",
  "settings.profile.devicesColumn": "Push",
  "settings.profile.accessTo": "Access to {room}",
  "settings.profile.display": "Display {room}",
  "settings.profile.tuckedColumn": "Tucked",
  "settings.profile.tuck": "Tuck {room}",
  "settings.profile.notificationsFor": "Notifications for {room}",
  "settings.profile.devicesFor": "Push notifications for {room}",
  "settings.profile.promptConflict":
    "Special instructions changed elsewhere. Your draft is kept. Review the current text before you save again.",
  "settings.profile.currentPrompt": "Current special instructions",
  "settings.profile.profilePrompt": "Special instructions",
  "settings.profile.profilePromptHint":
    "(auto-injected into the system prompt of agents you own; other members' agents can look it up if they need context on you)",
  "settings.profile.profilePromptTitle": "{user} · Special instructions",
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
  "settings.office.memberUsageCap": "Pace member usage",
  "settings.office.memberUsageCapHint":
    "Members' turns on the office sign-in stop at a line that rises each day of the week, up to the member share.",
  "settings.office.memberUsageShare": "Member share of the weekly limit",
  "settings.office.memberUsageShareOption": "{share}%",
  "settings.office.memberUsageWeekly":
    "{provider}: {used}% used; members stop at {line}% today.",
  "settings.office.memberUsageNoLimit":
    "{provider}: no weekly limit on the office sign-in. Members are not capped.",
  "settings.office.memberUsageFailed":
    "{provider}: weekly usage could not be read. Members are not capped.",

  "settings.room.title": "{room} · Settings",
  "settings.room.intro":
    "The vent on the wall, the s key and a double-click on the room tab open this page.",
  "settings.room.namePlaceholder": "Room name",
  "settings.room.backRoom": "Back room",
  "settings.room.backRoomHint": "More than {count} agents, behind a trap door.",
  "settings.room.backRoomInUse.one":
    "{count} agent sits in the back room. Move it out first.",
  "settings.room.backRoomInUse.other":
    "{count} agents sit in the back room. Move them out first.",
  "settings.room.prompt": "Room Prompt",
  "settings.room.promptHint": "(optional, appended after office prompt)",
  "settings.room.promptTitle": "{room} · Room Prompt",
  "settings.room.promptPlaceholder":
    "e.g. You're in the Marketing room. Match our brand voice.",
  "settings.room.promptNote":
    "Changes take effect on next conversation. Set environment variables on the Integrations page.",
  "settings.room.memoryHint":
    "(durable facts for this room; raw lines; {size} / {cap})",
  "settings.room.memoryTitle": "{room} · Memory",
  "settings.room.memoryPlaceholder": "Some memory relevant to this room",
  "settings.room.reloadFailed":
    "Saved, but this page could not reload the room. Select another row and come back to keep editing.",
  "settings.room.conflict":
    "Room settings changed somewhere else since this page loaded. Select another row and come back to load the latest.",
  "settings.room.deleteEmpty": "Delete empty room",
  "settings.room.yourView": "Your view",

  "settings.theme.intro":
    "Stored in this browser. You can also click the office window to walk through the themes without opening this page.",

  "settings.device.intro":
    'Stored in this browser. Tells agents which device you are on (for example "Phone" against "Laptop") so they can adjust their replies.',
  "settings.device.label": "Device Label",
  "settings.device.optional": "(optional)",
  "settings.device.placeholder": "Phone, Laptop, …",
  "settings.roomTurn.title": "Room switch animation",
  "settings.roomTurn.hint": "Plays when you click a door between two rooms.",
  "settings.roomTurn.off": "Off",
  "settings.roomTurn.turn": "Turn, {ms} ms",
  "settings.roomTurn.cube": "Cube flip, {ms} ms",

  "settings.devices.title": "Sign-in links",
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
  "settings.update.imageRender":
    "To update, use the web service's manual deployment control in Render.",
  "settings.update.imageRelease": "To update, deploy the {tag} release image.",
  "settings.update.updateGuide": "Update guide",
  "settings.update.ownerOnly": "An office owner can apply it from this dialog.",
  "settings.update.updateNow": "Update now",
  "settings.update.updateNowBusy": "Update now ({count} busy)",
  "settings.update.updating": "Updating…",
  "settings.update.gotIt": "Got it",
  "settings.update.lastUpdate": "Last update, {date}",

  "update.screen.title": "Updating isomux",
  "update.screen.prepare": "Preparing",
  "update.screen.install": "Installing",
  "update.screen.restart": "Restarting",
  "update.screen.requested": "Waiting for the updater.",
  "update.screen.done": "This office now runs {version}.",
  "update.screen.failed":
    "The update did not finish. This office runs {version}.",
  "update.screen.reload": "Reload",
  "update.screen.hide": "Hide",
  "update.outcome.title": "Notes from the update",

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
  "settings.storage.category.webhooks": "Webhooks",
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
  "settings.storage.leave": "Leave",
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
    "newest conversations of each live agent, however old they are. 0 spares none on that basis.",
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
    "A sign-in link signs one device in as an existing member. To invite a new member, create them first in <i>Members</i>.",
  "settings.invites.linkHint":
    "Send the link privately. It expires in 24h, and a new link replaces the member's previous one.",
  "settings.invites.createLink": "Create sign-in link",
  "settings.invites.creatingLink": "Creating…",
  "settings.invites.createLinkFailed": "Failed to create sign-in link",
  "preAuth.invite.changeLater":
    "You can change your name and language later in Settings.",
  "preAuth.invite.nameTaken": "That name is in use. Choose another name.",
  "preAuth.invite.errorLanguage": "Choose a language.",
  "preAuth.invite.newMember": "New member",
  "settings.invites.selectUser": "Select a member…",
  "settings.invites.outstanding": "Outstanding invites",
  "settings.invites.columnFor": "For",
  "settings.invites.columnExpires": "Expires",
  "settings.invites.bootstrap": "(bootstrap)",

  "settings.sessions.intro":
    "Devices signed into this office, across all members. Revoking a session signs that device out. New people get an invite from the Invites section; existing members add devices themselves from <i>Sign-in links</i>.",
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

  "settings.connections.refresh": "Refresh",
  "settings.connections.refreshing": "Refreshing…",
  "settings.connections.checkFailed": "Could not check provider accounts.",
  "settings.secrets.loadFailed": "Could not load secrets.",
  "settings.secrets.saveFailed": "Could not save the secret.",
  "settings.secrets.formAuthorization": "Authorization header",
  "settings.secrets.formHeaderNamed": "{header} header",
  "settings.secrets.rotate": "Replace value",
  "settings.secrets.saveValue": "Save value",
  "settings.secrets.reissue": "New stand-in",
  "settings.secrets.reissueConfirm":
    "The current stand-in for {name} stops working now. Agents get the new one at their next start.",
  "settings.secrets.preset": "Service",
  "settings.secrets.presetCustom": "Other",
  "settings.secrets.name": "Name",
  "settings.secrets.value": "Value",
  "settings.secrets.valuePlaceholder": "Paste the value",
  "settings.secrets.hosts": "Hosts that may receive it, one per line",
  "settings.connections.note": "Note for agents",
  "settings.connections.notePlaceholder": "What agents should use it for",
  "settings.connections.error.note":
    "Keep the note to 1,000 characters of plain text.",
  "settings.secrets.vouch":
    "List only hosts you trust: by saving, you vouch that they never send the credential back.",
  "settings.secrets.headerName": "Header name",
  "settings.secrets.error.name":
    "Use letters, digits and underscores for the name, and do not start with a digit.",
  "settings.secrets.error.reservedName":
    "The office sets this name itself. Choose another name.",
  "settings.secrets.error.value":
    "The value must be 8 characters to 16 KiB of printable ASCII, with no space at either end.",
  "settings.secrets.error.hosts":
    "List 1 to 20 host names such as api.github.com, with no https://, port or path.",
  "settings.secrets.error.header": "Enter a header name such as x-api-key.",
  "settings.secrets.error.neverListed":
    "{host} never receives a secret: model and package registry hosts are on the never-list.",
  "settings.secrets.error.exists": "A secret with this name exists.",
  "settings.connections.bedrockHint":
    "Want to connect Bedrock? Read <link>here</link>.",
  "settings.mcpServers.loadFailed": "Could not load MCP servers.",
  "settings.mcpServers.saveFailed": "Could not save the MCP server.",
  "settings.mcpServers.add": "Add an MCP server",
  "settings.mcpServers.name": "Name",
  "settings.mcpServers.clientId": "Client ID (optional)",
  "settings.mcpServers.clientSecret": "Client secret (optional)",
  "settings.mcpServers.signIn": "Sign in",
  "settings.mcpServers.signInAgain": "Sign in again",
  "settings.mcpServers.signInDone": "Signed in to the MCP server.",
  "settings.mcpServers.signInFailed": "The sign-in failed. Try again.",
  "settings.mcpServers.signInError.clientNeeded":
    "This server does not register clients. Enter a client ID.",
  "settings.mcpServers.signInError.redirectRefused":
    "The authorization server refused this office's address. Some servers accept only https or localhost addresses.",
  "settings.mcpServers.signInError.metadata":
    "The server's sign-in details are missing or do not match the server.",
  "settings.mcpServers.signInError.secretExists":
    "A secret named {name} exists in this scope. Rename or delete it, then sign in.",
  "settings.mcpServers.signInError.expired":
    "The sign-in took too long. Try again.",
  "settings.mcpServers.signInError.wrongMember":
    "Another member started this sign-in.",
  "settings.mcpServers.signInError.denied": "The sign-in was cancelled.",
  "settings.connections.list.mcpSignIn": "Left out: not signed in",
  "settings.connections.list.mcpSignInAgain": "Left out: sign in again",
  "settings.mcpServers.tokenPlaceholder": 'The token alone, without "Bearer"',
  "settings.mcpServers.error.name":
    "Use up to 24 lowercase letters, digits and hyphens, with a letter or digit at each end.",
  "settings.mcpServers.error.url":
    "Enter an https:// URL with no user, password or #fragment. With a credential, use the default port. http:// works only for localhost, with no credential.",
  "settings.mcpServers.error.exists": "An MCP server with this name exists.",
  "settings.mcpServers.error.secretNotFound": "That secret does not exist.",
  "settings.mcpServers.error.secretHost":
    "The secret does not list {host}. Add the host to the secret, or pick another one.",
  "settings.connections.list.engineMcpUser":
    "Every Claude agent on the same Claude sign-in",
  "settings.connections.list.mcpCredentialNamed": "Credential: {name}",
  "settings.connections.list.mcpSecretMissing":
    "Left out: its secret is missing",
  "settings.connections.list.mcpSecretHost":
    "Left out: its secret does not list {host}",
  "settings.connections.list.mcpOverridden":
    "Your own MCP server with this name replaces it for your agents.",
  "settings.connections.list.setInClaudeUser": "Set in Claude user settings",
  "settings.connections.list.setInClaudeLocal":
    "Set in Claude local settings for {folder}",
  "settings.connections.list.setInProject": "Set in {file}",
  "settings.connections.test.button": "Test",
  "settings.connections.test.running": "Testing…",
  "settings.connections.test.noHostTest": "No test for its hosts",
  "settings.connections.test.works": "Works",
  "settings.connections.test.help.github":
    "Isomux called GitHub's /user API with this secret, and GitHub accepted it as the account shown.",
  "settings.connections.test.help.stripe":
    "Isomux called Stripe's /v1/account API with this secret, and Stripe accepted it as the account shown.",
  "settings.connections.test.help.fly":
    "Isomux sent this secret with a viewer query to the Fly.io GraphQL API, and Fly.io accepted it as the account shown.",
  "settings.connections.test.help.mcp":
    "Isomux connected to this server as an agent does and listed its tools.",
  "settings.connections.test.help.claude":
    "Isomux started Claude Code with this sign-in, and Claude Code reported it signed in.",
  "settings.connections.test.help.codex":
    "Isomux started Codex with this sign-in, and Codex reported it signed in.",
  "settings.connections.test.tools.one": "{count} tool",
  "settings.connections.test.tools.other": "{count} tools",
  "settings.connections.test.refused":
    "{host} refused the credential. Check or rotate it.",
  "settings.connections.test.forbidden":
    "{host} accepts the credential, but it cannot read the account.",
  "settings.connections.test.noCredential":
    "{host} asks for a credential. Add one to the MCP server.",
  "settings.connections.test.status": "{host} answered {status}.",
  "settings.connections.test.redirect":
    "{host} answered with a redirect. The test does not follow it.",
  "settings.connections.test.timeout": "{host} did not answer in time.",
  "settings.connections.test.unreachable": "Could not reach {host}.",
  "settings.connections.test.unexpected":
    "{host} gave an answer the test cannot read.",
  "settings.connections.test.needsOauth":
    "{host} asks for an OAuth sign-in, which Isomux does not support yet.",
  "settings.connections.test.requestFailed": "Could not run the test.",

  "common.integrations": "Integrations",
  "integrations.ownerIntro":
    "Set up what agents can use, for the office and for each member.",
  "integrations.memberIntro":
    "Owners set up what agents use. You can add your own for the agents you start.",
  "integrations.tabs.providers": "Model providers",
  "integrations.tabs.mcp": "MCP servers",
  "integrations.tabs.secrets": "Secrets",
  "integrations.tabs.variables": "Variables",
  "integrations.tabs.browser": "Browser Use",
  "integrations.tabIntro.providers":
    "The accounts and keys that Claude, Codex and OpenCode agents run on.",
  "integrations.tabIntro.mcp":
    "Tools that agents can call, such as Linear or Sentry.",
  "integrations.tabIntro.secrets":
    "API keys and tokens for services such as GitHub.",
  "integrations.tabIntro.variables":
    "Plain settings that agents can read, such as a time zone.",
  "integrations.secretsHonesty":
    "Isomux blocks agents from reading saved secrets, but this office has no hard wall between agents and its files.",
  "integrations.secrets.modelKeys":
    "Model API keys such as <code>ANTHROPIC_API_KEY</code> go in <link>Variables</link>, not here: Isomux never sends a secret to a model provider.",
  "integrations.office": "Office-wide",
  "integrations.officeWho": "Every agent in the office",
  "integrations.officeWhoMember":
    "Every agent in the office. Only owners can change these integrations.",
  "integrations.personal": "Personal",
  "integrations.personalWhoSelf":
    "Agents you start. One set here replaces the office-wide one with the same name.",
  "integrations.personalWhoMember":
    "Agents {member} starts. One set here replaces the office-wide one with the same name.",
  "integrations.memberTitle": "{member}'s integrations",
  "integrations.backToYours": "Back to yours",
  "integrations.picker": "Whose integrations",
  "integrations.applies":
    "Claude and Codex agents get a change when they start a new conversation. OpenCode agents get it once none of them is working.",
  "integrations.helpTip": "What does this mean?",
  "integrations.show": "Show",
  "integrations.hide": "Hide",
  "integrations.remove": "Remove",
  "integrations.moreOptions": "More options",
  "integrations.actionFailed": "Could not do that. Try again.",
  "integrations.dialog.edit.self": "Edit {name}",
  "integrations.dialog.edit.member": "Edit {member}'s {name}",
  "integrations.dialog.edit.office": "Edit the office-wide {name}",
  "integrations.dialog.remove.self": "Remove {name}?",
  "integrations.dialog.remove.member": "Remove {member}'s {name}?",
  "integrations.dialog.remove.office": "Remove the office-wide {name}?",
  "integrations.providers.apiKeys":
    "Using an API key instead? Add <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> or <code>OPENCODE_API_KEY</code> in <link>Variables</link>.",
  "integrations.providers.memberSignsIn":
    "Members sign in to their own accounts.",
  "integrations.status.connected": "Connected",
  "integrations.status.pending": "Pending",
  "integrations.status.needsAuth": "Needs sign-in",
  "integrations.status.failed": "Failed",
  "integrations.status.off": "Off",
  "integrations.connectors.title":
    "From claude.ai, for Claude agents on {account}",
  "integrations.connectors.titleNoAccount":
    "From claude.ai, for Claude agents on this sign-in",
  "integrations.connectors.hint":
    "Claude agents on this account also get these. <link>Manage them in claude.ai</link>.",
  "integrations.connectors.unknown":
    "Isomux shows them after a Claude agent on this account takes a turn.",
  "integrations.connectors.pendingHelp":
    "Claude reports its connectors when a turn starts, while some are still connecting. Isomux checks again 10 seconds later.",
  "integrations.engineMcp.title": "Set in Claude's own files",
  "integrations.engineMcp.source":
    "What your Claude agents reported, only in folders where one has run.",
  "integrations.mcp.empty": "No MCP servers.",
  "integrations.mcp.nameHint": "Agents see this name, such as linear.",
  "integrations.mcp.url": "Server address (URL)",
  "integrations.mcp.urlHint":
    "The service's docs give this address. Put a token under Sign-in, not in the address.",
  "integrations.mcp.auth": "Sign-in",
  "integrations.mcp.authOauth": "Sign in to the server (OAuth)",
  "integrations.mcp.authToken": "Paste a token",
  "integrations.mcp.authSaved": "Use a saved secret",
  "integrations.mcp.authNone": "None",
  "integrations.mcp.token": "Token",
  "integrations.mcp.tokenGoesTo": "Isomux sends the token only to {host}.",
  "integrations.mcp.tokenNoHost":
    "Enter the address first: Isomux sends the token only to its host.",
  "integrations.mcp.tokenName": "Saved as",
  "integrations.mcp.tokenNameHint":
    "The token is saved on the Secrets tab under this name.",
  "integrations.mcp.savedSecret": "Secret",
  "integrations.mcp.pickSecret": "Pick a secret",
  "integrations.mcp.oauthHint":
    "After you save, a sign-in page for the service opens. Claude, Codex and OpenCode agents all get the access.",
  "integrations.mcp.clientHint":
    "Leave these empty unless the server needs a client you registered with it.",
  "integrations.mcp.saveAndSignIn": "Save and sign in",
  "integrations.mcp.status.signedIn": "Signed in",
  "integrations.mcp.status.needsSignIn": "Needs sign-in",
  "integrations.mcp.status.token": "Token saved",
  "integrations.mcp.status.none": "No sign-in",
  "integrations.mcp.addHeading.self": "Add an MCP server",
  "integrations.mcp.addHeading.member": "Add an MCP server for {member}",
  "integrations.mcp.addHeading.office": "Add an office-wide MCP server",
  "integrations.mcp.signedIn": "Signed in.",
  "integrations.providers.noPersonal": "No personal sign-in",
  "integrations.signIn.office": "Sign in for every agent in this office",
  "integrations.signIn.personal": "Sign in for agents I spawn",
  "integrations.providers.opencode.bundled":
    "Ships with Isomux. Free models need no account or key.",
  "integrations.providers.opencode.keySet":
    "<code>OPENCODE_API_KEY</code> is set, for paid models.",
  "integrations.providers.opencode.noKeyOffice":
    "No <code>OPENCODE_API_KEY</code>. Paid models need one in <link>Variables</link>.",
  "integrations.providers.opencode.noKeyPersonal":
    "No <code>OPENCODE_API_KEY</code>. To add one, go to <link>Variables</link>.",
  "integrations.providers.testSignedOut": "Not signed in.",
  "integrations.connectionsFailed":
    "Could not load the claude.ai connectors and the servers set in Claude's files.",
  "integrations.memberGone": "{member} is no longer in this office.",
  "integrations.secrets.empty": "No secrets.",
  "integrations.secrets.add": "Add a secret",
  "integrations.secrets.value": "Key or token",
  "integrations.secrets.valuePlaceholder": "Paste it here",
  "integrations.secrets.newValuePlaceholder": "Paste the new value",
  "integrations.secrets.nameHint":
    "Agents see this name, for example MY_API_KEY.",
  "integrations.secrets.addresses": "Addresses that may receive it",
  "integrations.secrets.addressesHint":
    "The web addresses of the service, one per line, such as api.example.com. Isomux sends the key to no other address. Add only addresses that belong to the service.",
  "integrations.secrets.presetGoesTo": "Isomux sends it only to {service}.",
  "integrations.secrets.showAddresses": "Show addresses",
  "integrations.secrets.hideAddresses": "Hide addresses",
  "integrations.secrets.howSent": "How the service expects it",
  "integrations.secrets.bearer": "As a bearer token (most services)",
  "integrations.secrets.customHeader": "In a header with another name",
  "integrations.secrets.headerPlaceholder": "Header name, such as x-api-key",
  "integrations.secrets.presetSet": "{service} · set {date}",
  "integrations.secrets.goesToSet": "Goes to {hosts} · set {date}",
  "integrations.secrets.goesTo": "Goes to {hosts}",
  "integrations.secrets.showFailed": "Could not show the value.",
  "integrations.secrets.reissueHint":
    "Agents get a new stand-in, and the old one stops working.",
  "integrations.secrets.addHeading.self": "Add a secret",
  "integrations.secrets.addHeading.member": "Add a secret for {member}",
  "integrations.secrets.addHeading.office": "Add an office-wide secret",
  "integrations.secrets.replaceHeading.self": "Replace the value of {name}",
  "integrations.secrets.replaceHeading.member":
    "Replace the value of {member}'s {name}",
  "integrations.secrets.replaceHeading.office":
    "Replace the value of the office-wide {name}",
  "integrations.secrets.reissueHeading.self": "New stand-in for {name}",
  "integrations.secrets.reissueHeading.member":
    "New stand-in for {member}'s {name}",
  "integrations.secrets.reissueHeading.office":
    "New stand-in for the office-wide {name}",
  "integrations.variables.empty": "No variables.",
  "integrations.variables.modelKeys":
    "Model API keys such as <code>ANTHROPIC_API_KEY</code> go here, not in Secrets: Isomux never sends a secret to a model provider.",
  "integrations.variables.looksLikeKey":
    "Agents can read a variable's value. If no agent needs the raw value, save this as a secret instead.",
  "integrations.variables.exists": "A variable with this name exists.",
  "integrations.variables.addHeading.self": "Add a variable",
  "integrations.variables.addHeading.member": "Add a variable for {member}",
  "integrations.variables.addHeading.office": "Add an office-wide variable",
  "integrations.variables.replaceHeading.self": "Replace the value of {name}",
  "integrations.variables.replaceHeading.member":
    "Replace the value of {member}'s {name}",
  "integrations.variables.replaceHeading.office":
    "Replace the value of the office-wide {name}",

  "settings.signIn.apiKeyNote":
    "Do you want to use an API token? See Integrations → Variables.",
  "settings.signIn.scopeOffice":
    "Office-wide: sign in for every agent in this office",
  "settings.signIn.scopePersonal": "Personal: sign in for agents I spawn",
  "settings.signIn.officeHint":
    "This subscription is used for every agent in the office except for agents spawned by an office member who has their own <link>personal sign-in</link>.",
  "settings.signIn.personalHint": "Use a separate account for your agents.",
  "settings.signIn.askOfficeOwner": "Ask an office owner to sign in.",
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
  "settings.signIn.queueHeldUnderMinute":
    "{name} is signing in to this shared {provider} account, started less than a minute ago.",
  "settings.signIn.queueHeldMinutes.one":
    "{name} is signing in to this shared {provider} account, started {count} minute ago.",
  "settings.signIn.queueHeldMinutes.other":
    "{name} is signing in to this shared {provider} account, started {count} minutes ago.",
  "settings.signIn.cancelShared": "Cancel this sign-in",
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

  "settings.memberConnections.loadFailed": "Could not load connections.",
  "settings.memberConnections.unknown": "Could not check status.",
  "settings.memberApiTokens.title": "API Tokens",
  "settings.memberApiTokens.hint":
    "Revoke a token to stop it on its next request.",
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
  "dialogs.schedule.none": "On demand",
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
  "dialogs.agent.backRoom": "Back room",
  "dialogs.agent.moveToBackOf": "Back room of {room}",
  "dialogs.agent.engineBlurb.claude": "Works with your Claude Code login.",
  "dialogs.agent.engineBlurb.codex": "Works with your ChatGPT login.",
  "dialogs.agent.engineBlurb.opencode":
    "Works with models configured through OpenCode.",
  "dialogs.agent.engineNeedsLinux": "Needs a Linux host.",
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
    "The agent uses this member’s provider connections and personal variables. See the Integrations page.",
  "dialogs.agent.privileged": "Privileged operator access",
  "dialogs.agent.privilegedHint":
    "Lets this agent act for you across the office: set up and remove agents and drive their conversations, manage rooms, schedules and integrations, and post in members chat. If you are an office owner, it can also add members and change office settings. It acts as itself, with your access.",
  "dialogs.agent.privilegedRestart": "Saving restarts the agent's session.",
  "dialogs.agent.autoHandoff": "Automatic handoff",
  "dialogs.agent.autoHandoffHint":
    "When the context gets full, the agent writes a brief and continues in a fresh session. The chat clears.",
  "dialogs.agent.limitResume": "Resume after usage limit",
  "dialogs.agent.limitResumeHint":
    "When a usage limit stops the agent, it continues after the limit resets.",
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
  "dialogs.agent.cronjobPromptTitle": "Schedule prompt",
  "dialogs.agent.showCronjobPrompt": "Show schedule prompt",
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
  "apiCall.pager.list": "List pages",
  "apiCall.pager.get": "Read page",
  "apiCall.pager.raise": "Raise page",
  "apiCall.pager.ack": "Ack page",
  "apiCall.pager.resolve": "Resolve page",
  "apiCall.asks.create": "Create ask",
  "apiCall.asks.list": "List asks",
  "apiCall.asks.get": "Check ask",
  "apiCall.asks.edit": "Edit ask",
  "apiCall.asks.delete": "Delete ask",
  "asks.title": "Asks",
  "asks.reply": "Reply",
  "asks.dismiss": "Dismiss",
  "asks.replyDefault": "done",
  "asks.link": "Ask",
  "asks.openLink": "Open {page}",
  "asks.dismissed": "Dismissed",
  "asks.dismissedReason": "Dismissed: {reason}",
  "asks.badge.one": "{count} ask",
  "asks.badge.other": "{count} asks",
  "asks.answerFailed": "Not sent: {error}",
  "asks.empty": "No open asks.",
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
  "apiCall.agents.listWithBackRooms": "List office agents, back rooms included",
  "apiCall.agents.listInvalidBack": "List agents (invalid back filter)",
  "apiCall.agents.listInvalidFilter": "List agents (invalid killed filter)",
  "apiCall.agents.sendMessage": "Send agent message",
  "apiCall.agents.sendMessageTo": "Send a message to {who}",
  "apiCall.agents.steerMessage": "Message {who} mid-turn",
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
  "apiCall.browser.unpairOne": "Unpair a browser",
  "apiCall.agents.browser": "Use the browser",
  "apiCall.agents.browserDetail": "Use the browser",
  "apiCall.agents.showDiff": "Show diff in chat",
  "apiCall.agents.showDiffDetail": "Show a diff in chat",
  "apiCall.agents.offerFile": "Offer file in editor",
  "apiCall.agents.offerFileDetail": "Offer a file in the editor",
  "apiCall.agents.suggestCommand": "Suggest terminal command",
  "apiCall.agents.suggestCommandDetail": "Suggest a terminal command",
  "apiCall.agents.requestSecret": "Ask for a secret",
  "apiCall.agents.context": "Check context usage",
  "apiCall.agents.subscription": "Check subscription usage",
  "apiCall.agents.logsSearch": "Search conversation logs",
  "apiCall.agents.logsSearchFor": 'Search {who}\'s logs for "{query}"',
  "apiCall.agents.logsAround": "Read around an entry in {who}'s logs",
  "apiCall.agents.logsSession": "Read a session from {who}'s logs",
  "apiCall.agents.logsList": "List {who}'s log sessions",
  "apiCall.agents.instructions": "Read agent instructions",
  "apiCall.agentReference.read": "Read office API reference",
  "apiCall.agentReference.readPage": "Read office API reference: {page}",
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
  "apiCall.users.readMemberPrompt": "Read member special instructions",
  "apiCall.users.updatePrompt": "Edit member special instructions",
  "apiCall.office.readSettings": "Read office settings",
  "apiCall.office.saveSettings": "Change office settings",
  "apiCall.users.create": "Create a member",
  "apiCall.users.createNamed": "Create member {name}",
  "apiCall.env.readUser": "Read managed environment",
  "apiCall.env.saveUser": "Save managed environment",
  "apiCall.env.readOffice": "Read office environment",
  "apiCall.env.saveOffice": "Save office environment",
  "apiCall.env.namesUser": "List a member's variable names",
  "apiCall.env.setUser": "Set a variable",
  "apiCall.env.removeUser": "Remove a variable",
  "apiCall.env.namesOffice": "List office variable names",
  "apiCall.env.setOffice": "Set an office variable",
  "apiCall.env.removeOffice": "Remove an office variable",
  "apiCall.secrets.reissue": "New stand-in for a secret",
  "apiCall.secrets.test": "Test a secret",
  "apiCall.officeSecrets.reissue": "New stand-in for an office secret",
  "apiCall.officeSecrets.test": "Test an office secret",
  "apiCall.mcpServers.test": "Test an MCP server",
  "apiCall.officeMcpServers.test": "Test an office MCP server",
  "apiCall.secrets.list": "List my secrets",
  "apiCall.secrets.create": "Save a secret",
  "apiCall.secrets.rotate": "Replace a secret value",
  "apiCall.secrets.update": "Edit a secret",
  "apiCall.secrets.delete": "Delete a secret",
  "apiCall.officeSecrets.list": "List office secrets",
  "apiCall.officeSecrets.create": "Save an office secret",
  "apiCall.officeSecrets.rotate": "Replace an office secret value",
  "apiCall.officeSecrets.update": "Edit an office secret",
  "apiCall.officeSecrets.delete": "Delete an office secret",
  "apiCall.mcpServers.list": "List my MCP servers",
  "apiCall.mcpServers.create": "Add an MCP server",
  "apiCall.mcpServers.update": "Edit an MCP server",
  "apiCall.mcpServers.delete": "Delete an MCP server",
  "apiCall.officeMcpServers.list": "List office MCP servers",
  "apiCall.officeMcpServers.create": "Add an office MCP server",
  "apiCall.officeMcpServers.update": "Edit an office MCP server",
  "apiCall.officeMcpServers.delete": "Delete an office MCP server",
  "apiCall.inbox.messageBoss": "Sent message to external token",
  "apiCall.inbox.drain": "Drain API token inbox",
  "apiCall.memory.read": "Read memory",
  "apiCall.connections.agentList": "Read connection notes",
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
  "apiCall.cronjobs.list": "List schedules",
  "apiCall.cronjobs.create": "Create a schedule",
  "apiCall.cronjobs.read": "Read a schedule",
  "apiCall.cronjobs.systemPrompt": "Read a schedule prompt",
  "apiCall.cronjobs.update": "Update a schedule",
  "apiCall.cronjobs.delete": "Delete a schedule",
  "apiCall.cronjobs.listRuns": "List schedule runs",
  "apiCall.cronjobs.triggerRun": "Trigger a schedule run",
  "apiCall.cronjobs.readRun": "Read a schedule run",
  "apiCall.cronjobs.listRecentRuns": "List recent schedule runs",
  "apiCall.apps.list": "List apps",
  "apiCall.apps.register": "Register app",
  "apiCall.apps.read": "Read app",
  "apiCall.apps.setThumbnail": "Upload app thumbnail",
  "apiCall.apps.getThumbnail": "Read app thumbnail",
  "apiCall.apps.update": "Update app",
  "apiCall.apps.delete": "Delete app",
  "apiCall.apps.logs": "Read app logs",
  "apiCall.apps.start": "Start app",
  "apiCall.apps.stop": "Stop app",
  "apiCall.apps.restart": "Restart app",
  "apiCall.apps.archive": "Archive app",
  "apiCall.apps.unarchive": "Unarchive app",
  "apiCall.webhooks.list": "List webhooks",
  "apiCall.webhooks.create": "Create webhook",
  "apiCall.webhooks.read": "Read webhook",
  "apiCall.webhooks.update": "Update webhook",
  "apiCall.webhooks.delete": "Delete webhook",
  "apiCall.webhooks.deliveries": "Read webhook deliveries",
  "apiCall.webhooks.dryRun": "Test webhook rules",
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
  "common.days.other": "{count} days",
  "common.days.one": "{count} day",
  "common.sender.agent": "{name} · agent",
  "common.sender.agentInRoom": '{name} · agent · Room "{room}"',
  "common.sender.app": "{name} · app",
  "common.sender.cronjob": "{name} · schedule",
  "common.sender.webhook": "{name} · webhook",
  "cards.userMessage.expand": "Expand message",
  "cards.userMessage.collapse": "Collapse message",
  "cards.userMessage.toRemoteBoss": "To remote member",
  "cards.userMessage.toRemoteBossNamed": 'To remote member "{name}"',
  "cards.userMessage.editAndBranch": "Edit & branch",
  "cards.failedEdit.restore": "Restore text",
  "cards.thinking.label": "Thinking...",
  "cards.toolCall.input": "Input",
  "cards.toolCall.output": "Output",
  "cards.toolCall.denied": "Denied",
  "cards.toolCall.groupCount": "{count} tool calls",
  "cards.toolResult.showMore": "Show more",
  "cards.toolResult.showLess": "Show less",
  "cards.reviewFindings.none": "No findings.",
  "cards.fileView.fullSize": "Full size",
  "cards.fileView.earlierAttachment":
    "The agent viewed a file attached earlier in this chat. Click to show it.",
  "cards.editRequest.open": "Open in editor",
  "cards.editRequest.openHint": "Open {path} in the editor side panel",
  "cards.secretRequest.title": "Secret request: {name}",
  "cards.secretRequest.personal":
    "Saved in the secrets of this agent's manager.",
  "cards.secretRequest.office": "Office secret: an office owner saves it.",
  "cards.secretRequest.hint":
    "The value stays out of the chat. The agent gets a stand-in.",
  "cards.secretRequest.save": "Save secret",
  "cards.secretRequest.decline": "Decline",
  "cards.secretRequest.saved":
    "Saved. The agent gets a stand-in at its next start.",
  "cards.secretRequest.declined": "Declined.",
  "cards.secretRequest.declineFailed": "Could not decline the request.",
  "cards.secretRequest.closed":
    "This request is closed. The agent can ask again.",
  "cards.secretRequest.forbidden":
    "Only the agent's manager answers this request, or an office owner for an office secret.",
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
  "logView.pendingPrompt.cronjob": "Waiting for a schedule pick",
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
  "logView.nav.terminalTitle": "Open terminal (Ctrl+`)",
  "logView.nav.endConversation": "End",
  "logView.nav.endConversationTitle":
    "End conversation. You can resume it later with /resume.",
  "logView.backToOffice": "← Back to Office",
  "logView.backToOfficeTitle": "Back to office (Esc)",
  "logView.backToBackRoom": "← Back room",
  "logView.backToBackRoomTitle": "Back to the back room (Esc)",
  "logView.backRoomStrip":
    "In the back room of {room}. People talk to the front:",
  "logView.editTopic": "Click to edit topic",
  "logView.regenerateTopic": "Regenerate topic from conversation",
  "logView.noHistoryToSummarize": "No conversation history to summarize",
  "logView.lastMessagePrefix": "↑ You:",
  "logView.emptyStart": "Send a message to start a conversation or",
  "logView.emptyResume": "resume a past one",
  "logView.outbox.sending": "Sending",
  "logView.outbox.notSent": "Not sent",
  "logView.outbox.resend": "Resend",
  "logView.outbox.networkError": "The server could not be reached.",
  "logView.outbox.interrupted":
    "The page reloaded before the server confirmed it.",
  "logView.outbox.saveFailed":
    "Not sent: this browser could not save a copy first. Your message is still in the box.",
  "logView.sendFailedBanner":
    "Couldn't send - reconnecting. Your message is still in the box; try again once the banner clears.",
  "logView.editFailedBanner":
    "Couldn't send the edit: {error}. Your text is back in the message box.",
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
  "panels.terminal.envStale":
    "Secrets or variables changed. Restart this terminal to use them.",
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
  "office.tabs.tuckedRooms": "Tucked rooms",
  "office.tabs.tuck": "Tuck",
  "office.tabs.onlineUsers.one": "{count} online member",
  "office.tabs.onlineUsers.other": "{count} online members",
  "office.zoom.in": "Zoom in",
  "office.zoom.inShortcut": "Zoom in (+)",
  "office.zoom.out": "Zoom out",
  "office.zoom.outShortcut": "Zoom out (-)",
  "office.zoom.reset": "Reset view (0)",
  "office.zoom.resetAria": "Reset view",
  "office.openWebsite": "Open isomux.com",
  "office.skin.office": "Office",
  "office.skin.hospital": "Hospital",
  "office.decor.preset": "Preset",
  "office.decor.walls": "Palette",
  "office.decor.walls.office": "Office",
  "office.decor.walls.clinic": "Clinic",
  "office.decor.curtains": "Window curtains",
  "office.decor.curtains.tied": "Curtains",
  "office.decor.sill": "Window sill",
  "office.decor.sill.trailing": "Trailing plant",
  "office.decor.sill.blossom": "Blossom jar",
  "office.decor.wallArt": "Right wall",
  "office.decor.wallArt.neon": "Neon sign",
  "office.decor.wallArt.landscape": "Landscape",
  "office.decor.wallArt.chart": "Medical chart",
  "office.decor.trim": "Wall trim",
  "office.decor.trim.rail": "Rail",
  "office.decor.cabinet": "Wall cabinet",
  "office.decor.cabinet.firstAid": "First aid",
  "office.decor.floorPlant": "Floor plant",
  "office.decor.floorPlant.plant": "Potted plant",
  "office.decor.ward": "Ward furniture",
  "office.decor.ward.beds": "Bed",
  "office.decor.none": "None",
  "office.decor.coat": "Coat",
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
  "office.backRoom.tooltip.one": "Back room · {count} agent",
  "office.backRoom.tooltip.other": "Back room · {count} agents",
  "office.backRoom.dropBadge": "Move to back room",
  "office.backRoom.fullBadge": "Back room is full",
  "office.backRoom.title": "Back room",
  "office.backRoom.backTo": "← {room}",
  "office.backRoom.backToTitle": "Back to {room} (Esc)",
  "office.backRoom.newAgent": "+ New agent",
  "office.backRoom.sign": "BACK ROOM",
  "office.backRoom.boardTitle": "TODAY",
  "office.backRoom.boardCount": "{count} ON SHIFT",
  "office.status.errShort": "err",
  "office.hints.tap": "TAP → open",
  "office.hints.longPress": "LONG-PRESS → actions",
  "office.hints.pinch": "PINCH → zoom",
  "office.hints.dragZoomed": "DRAG (zoomed) → pan",
  "office.hints.click": "CLICK → open agent",
  "office.hints.dragDeskTrapDoor":
    "DRAG DESK → swap, or move to a door or the trap door",
  "office.hints.dragDesk": "DRAG DESK → swap, or move to a door",
  "office.hints.dragAgent": "DRAG AGENT → move to the front (ladder)",
  "office.hints.wheel": "WHEEL / +- → zoom",
  "office.hints.dragFloor": "DRAG FLOOR → pan",
  "office.hints.rightClick": "RIGHT-CLICK → actions",
  "office.hints.resetView": "0 → reset view",
  "office.pendingPrompt.permission": "permission",
  "office.pendingPrompt.resume": "session",
  "office.pendingPrompt.model": "model",
  "office.pendingPrompt.effort": "effort",
  "office.pendingPrompt.cronjob": "schedule",
  "office.pet.default": "Default",
  "contextMenu.editAgent": "Edit Agent...",
  "contextMenu.newConversation": "New Conversation",
  "contextMenu.newEngineConversation": "New {engine} Conversation",
  "contextMenu.resume": "Resume",
  "common.current": "(current)",
  "contextMenu.branched": "(branched)",
  "contextMenu.killAgent": "Kill Agent",
  "contextMenu.moveToBackRoom": "Move to back room",
  "contextMenu.moveToBackRoomFull": "Move to back room (full)",
  "contextMenu.moveToFront": "Move to front",
  "contextMenu.moveToFrontFull": "Move to front (full)",
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
  "schedules.trigger.webhook": "webhook",
  "schedules.trigger.webhookBy": "webhook · {name}",
  "schedules.tab.webhooks": "webhooks",
  "webhooks.newButton": "+ New webhook",
  "webhooks.empty":
    "No webhooks yet. A webhook lets a service such as GitHub message an agent or run a schedule.",
  "webhooks.loadFailed": "Could not load webhooks.",
  "webhooks.refresh": "Refresh",
  "webhooks.back": "Webhooks",
  "webhooks.notFound": "This webhook is gone.",
  "webhooks.enabled": "Enabled",
  "webhooks.noDeliveries": "no deliveries",
  "webhooks.col.name": "NAME",
  "webhooks.col.target": "TARGET",
  "webhooks.col.lastDelivery": "LAST DELIVERY",
  "webhooks.secretMissingShort": "Needs a new secret",
  "webhooks.rejectedShort": "Some deliveries were rejected",
  "webhooks.secretFailed": "Could not read the secret.",
  "webhooks.openDelivery": "Open the delivery",
  "webhooks.target.title": "Target",
  "webhooks.target.agent": "Agent: {name}",
  "webhooks.target.cronjob": "Schedule: {name}",
  "webhooks.target.unavailable": "{id} (unavailable)",
  "webhooks.target.noteLine": "Note: {note}",
  "webhooks.outcome.pending": "in flight",
  "webhooks.outcome.ping": "ping",
  "webhooks.outcome.badPayload": "bad payload",
  "webhooks.outcome.noMatch": "no match",
  "webhooks.outcome.dispatchLimited": "rate limited",
  "webhooks.outcome.targetUnavailable": "target unavailable",
  "webhooks.outcome.dispatched": "delivered",
  "webhooks.setup.github": "Set up in GitHub",
  "webhooks.setup.generic": "Set up the sender",
  "webhooks.setup.url": "Payload URL",
  "webhooks.setup.reach": "GitHub must reach this address from the internet.",
  "webhooks.setup.reachGeneric":
    "The sender must reach this address from the internet.",
  "webhooks.setup.noPublicAddress":
    "This office has no public address, so no outside service can reach it.",
  "webhooks.setup.contentType": "Content type",
  "webhooks.setup.signatureHeader": "Signature header",
  "webhooks.setup.secret": "Secret",
  "webhooks.setup.copyFailed": "Could not copy. Use Show.",
  "webhooks.setup.show": "Show",
  "webhooks.setup.hide": "Hide",
  "webhooks.setup.rotate": "Rotate secret",
  "webhooks.setup.rotateWarning": "The old secret stops working at once.",
  "webhooks.setup.rotateYes": "Rotate",
  "webhooks.setup.secretMissing":
    "Needs a new secret: backups do not keep secrets. Rotate it, and then paste the new secret into the sender.",
  "webhooks.setup.secretMembersOnly":
    "Only the owner of the webhook and office owners can see the secret.",
  "webhooks.setup.events": "Events",
  "webhooks.setup.eventsHint":
    'Choose "Let me select individual events" and select these:',
  "webhooks.setup.everything":
    'A rule takes every event. In GitHub, choose "Send me everything".',
  "webhooks.setup.unsigned":
    "The event name is not signed. A rule that starts real work should also match a payload field that only that event has.",
  "webhooks.rules.title": "Rules",
  "webhooks.rules.none": "No rules: no delivery reaches the target.",
  "webhooks.rules.ruleN": "Rule {n}",
  "webhooks.rules.event": "Event",
  "webhooks.rules.match": "Match (payload path = exact value)",
  "webhooks.rules.args": "Arguments (name = template)",
  "webhooks.counters.title": "Rejected before the signature check",
  "webhooks.counters.since": "Since {time}.",
  "webhooks.counters.none": "None since {time}.",
  "webhooks.counters.last": "last {time}",
  "webhooks.counter.disabled": "while paused",
  "webhooks.counter.method": "not a POST",
  "webhooks.counter.secretMissing": "no secret",
  "webhooks.counter.rateLimited": "rate limited",
  "webhooks.counter.bodyTooLarge": "body too large",
  "webhooks.counter.badSignature": "bad signature",
  "webhooks.dryRun.title": "Test the rules",
  "webhooks.dryRun.hint":
    "Paste a payload, for example from Recent Deliveries in GitHub. Nothing is sent and nothing is logged.",
  "webhooks.dryRun.event": "Event",
  "webhooks.dryRun.payload": "Payload (JSON)",
  "webhooks.dryRun.run": "Test",
  "webhooks.dryRun.notObject": "The payload must be a JSON object.",
  "webhooks.dryRun.failed": "The test failed.",
  "webhooks.dryRun.ping": "A ping. It is logged and never reaches a rule.",
  "webhooks.dryRun.noMatch": "No rule matches.",
  "webhooks.dryRun.match": "Rule {n} matches.",
  "webhooks.dryRun.block": "What the target gets",
  "webhooks.deliveries.title": "Deliveries",
  "webhooks.deliveries.empty": "No deliveries yet.",
  "webhooks.deliveries.failed": "Could not load deliveries.",
  "webhooks.deliveries.missingRow":
    "The delivery of this run is no longer in the log.",
  "webhooks.deliveries.more": "Show all",
  "webhooks.deliveries.col.time": "TIME",
  "webhooks.deliveries.col.event": "EVENT",
  "webhooks.deliveries.col.outcome": "OUTCOME",
  "webhooks.deliveries.col.rule": "RULE",
  "webhooks.deliveries.col.args": "ARGS",
  "webhooks.deliveries.attempts.one": "{count} attempt",
  "webhooks.deliveries.attempts.other": "{count} attempts",
  "webhooks.deliveries.duplicates.one": "{count} copy ignored",
  "webhooks.deliveries.duplicates.other": "{count} copies ignored",
  "webhooks.deliveries.openRun": "Open run",
  "webhooks.deliveries.openChat": "Open chat",
  "webhooks.dialog.newTitle": "New webhook",
  "webhooks.dialog.editTitle": "Edit webhook",
  "webhooks.dialog.name": "Name",
  "webhooks.dialog.nameHint": "Lowercase letters, digits and dashes.",
  "webhooks.dialog.scheme": "Sender",
  "webhooks.dialog.schemeGithub": "GitHub",
  "webhooks.dialog.schemeGeneric": "Other (HMAC-SHA256 signature)",
  "webhooks.dialog.schemeFixed":
    "The sender cannot change after the webhook is created.",
  "webhooks.dialog.eventHeader": "Event header (optional)",
  "webhooks.dialog.deliveryHeader": "Delivery id header (optional)",
  "webhooks.dialog.targetAgent": "Agent",
  "webhooks.dialog.targetCronjob": "Schedule",
  "webhooks.dialog.pickAgent": "Choose an agent",
  "webhooks.dialog.pickCronjob": "Choose a schedule",
  "webhooks.dialog.noCronjobs": "You manage no schedules.",
  "webhooks.dialog.cronjobHint":
    "Each delivery starts a run, also when the schedule is paused.",
  "webhooks.dialog.note": "Note for the agent (optional)",
  "webhooks.dialog.noteHint": "The agent reads it before the delivery data.",
  "webhooks.dialog.noteBrackets": "The note cannot contain angle brackets.",
  "webhooks.dialog.rulesHint":
    'The first rule that matches wins. The event "*" matches every event. Each delivery that reaches the target costs a turn, so match narrowly.',
  "webhooks.dialog.addRule": "+ Add rule",
  "webhooks.dialog.addMatch": "+ Add condition",
  "webhooks.dialog.addArg": "+ Add argument",
  "webhooks.dialog.moveUp": "Move up",
  "webhooks.dialog.moveDown": "Move down",
  "webhooks.dialog.removeRule": "Remove rule",
  "webhooks.dialog.removeRow": "Remove",
  "webhooks.dialog.create": "Create",
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
  "apps.empty": "No apps yet.",
  "apps.filter.onlyMine": "Only mine",
  "apps.filter.noMatch": "No apps match these filters.",
  "roomFilter.title": "Filter by room",
  "roomFilter.all": "All rooms",
  "roomFilter.none": "No room",
  "schedules.noMatch": "No schedules match this filter.",
  "webhooks.noMatch": "No webhooks match this filter.",
  "dialogs.schedule.room": "Room",
  "dialogs.schedule.roomHint": "Room members see this schedule and its runs.",
  "apps.unavailable.needsLinux":
    "App hosting needs Linux with systemd, so it is not available on this computer.",
  "apps.loadFailed": "Could not load apps.",
  "apps.deleteFailed": "Could not delete.",
  "apps.logReadFailed": "Could not read the log.",
  "apps.state.running": "running",
  "apps.state.starting": "starting",
  "apps.state.stopped": "stopped",
  "apps.state.failed": "failed",
  "apps.state.unknown": "unknown",
  "apps.meta.createdBy": "created by",
  "apps.meta.owner": "owner",
  "apps.openAgent": "Open the agent",
  "apps.commandIn": "in {cwd}",
  "apps.verbTitle.start": "Run the app",
  "apps.verbTitle.stop": "Shut the app down (its data is kept)",
  "apps.verbTitle.restart": "Stop the app and start it again",
  "apps.delete": "delete",
  "apps.cancel": "cancel",
  "apps.logEmpty": "Nothing in the log yet.",
  "apps.confirmDelete":
    "Delete {name}? Its data is not erased: it moves to {path} on the office's disk.",
  "tasks.status.open": "Open",
  "tasks.status.inProgress": "In Progress",
  "tasks.status.done": "Done",
  "tasks.status.obsolete": "Obsolete",
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
  "tasks.saveConflict":
    "This task changed while you were editing, so your changes were not saved.",
  "tasks.create": "Create",
  "tasks.globalShort": "Global",
  "tasks.shownCount": "{count} shown",
  "tasks.quickAdd": "Quick add a task…",
  "tasks.fileIn": "file in",
  "tasks.fileInTitle": "New tasks are filed in this room",
  "tasks.hintMobile": "Enter to add details",
  "tasks.hintDesktop": "Enter to add details · n to focus",
  "tasks.scopeTitle": "Filter tasks and set where new tasks are filed",
  "tasks.allRooms": "All rooms",
  "tasks.filterAssignee": "Filter assignee...",
  "tasks.filterPriorityNone": "No priority",
  "tasks.filterAllStatuses": "All statuses",
  "tasks.filterAllPriorities": "All priorities",
  "tasks.filterNone": "None",
  "tasks.filterPriorityNoneShort": "none",
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
  "apps.section.running": "Running",
  "apps.section.stopped": "Stopped",
  "apps.section.archived": "Archived",
  "apps.menu.start": "Start",
  "apps.menu.stop": "Stop",
  "apps.menu.restart": "Restart",
  "apps.menu.log": "View Log",
  "apps.menu.archive": "Archive",
  "apps.menu.unarchive": "Unarchive",
  "apps.menu.delete": "Delete...",
  "apps.actionFailed.archive": "Could not archive.",
  "apps.actionFailed.unarchive": "Could not unarchive.",
  "common.untitledConversation": "Untitled conversation",
  "schedules.human.daily": "Daily at {time}",
  "schedules.human.weekly": "Weekly {weekday} at {time}",
  "schedules.human.everyMinutes": "Every {minutes}m",
  "schedules.human.everyHours": "Every {hours}h",
  "schedules.human.everyHoursMinutes": "Every {hours}h{minutes}m",
  "schedules.human.none": "On demand",
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
  "commands.rewind.description": "Undo changes and revert conversation",
  "commands.copy.description": "Copy last response to clipboard",
  "commands.files.description": "List files in context",
  "commands.addDir.description": "Add additional working directories",
  "commands.btw.description": "Ask without polluting main context",
  "commands.config.description": "Open settings interface",
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
  "commands.vim.description": "Toggle vim keybindings",
  "commands.terminalSetup.description": "Configure terminal integration",
  "commands.reloadPlugins.description": "Reload plugins and config",
  "commands.reloadPlugins.message":
    "To reload plugins, open the built-in terminal (click the terminal icon on the agent's desk), run `claude`, and type `/reload-plugins`.",
  "commands.reloadPlugins.done": "Plugins and config reload at the next turn.",
  "commands.reloadPlugins.pending":
    "Plugins and config reload once no OpenCode turn is running.",
  "commands.reloadPlugins.failed": "Plugins and config did not reload: {error}",
  "commands.tasks.description": "List/manage background tasks",
  "commands.doctor.description": "Check installation health",
  "commands.feedback.description": "Report bugs to Anthropic",
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
    "not supported natively; see if the Automations page or scheduled messages satisfy your use case",
  "commands.loremIpsum.description": "Generate placeholder text",
  "commands.codeReview.description":
    "Review the current changes, a PR, a branch or a path for bugs (effort level, --fix, --comment, --max-findings)",
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
  "commands.native.attachments":
    "`/{name}` takes no attachments. Send the files in their own message.",
  "commands.unsupported.engine": "`/{name}` runs only on {engines} agents.",
  "commands.unsupported.notAvailable": "`/{name}` is not available in Isomux.",
  "commands.unsupported.unknownCommand":
    "Unknown command `/{name}`. Type `/help` to see available commands.",

  // /clear (also /reset, /new)
  "commands.clear.failed": "Failed to clear conversation: {error}",

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
  "commands.help.skills": "**Skills:** [Skills page]({url})",
  "commands.help.header": "**Help**",
  "commands.help.commands": "## Commands you can type",
  "commands.help.receptionist":
    "If you have questions about Isomux features like how to link other devices, how to invite other people to your office, how agents communicate with each other, how to connect your LLM providers, etc., ask the Receptionist agent.",
  "commands.help.aliasGroup": "{primary} (or {others})",

  // /resume
  "commands.resume.none": "No previous sessions found.",
  "commands.resume.header": "Resume a past conversation:",
  "commands.resume.noOthers": "No other sessions to resume.",
  "commands.resume.branched": "(branched)",

  // /model
  "commands.model.openCodeUnsupported":
    "Open agent settings to select a connected OpenCode model.",
  "commands.model.header": "Switch model (current: **{current}**):",

  // /plan
  "commands.plan.on": "Plan mode is on. Send /plan again to turn it off.",
  "commands.plan.off": "Plan mode is off.",
  "commands.plan.unavailable":
    "Plan mode is not available for {engine} agents.",

  // /effort
  "commands.effort.openCodeSettings":
    "OpenCode effort choices are available in agent settings for models that expose them.",
  "commands.effort.unsupported": "{model} does not support effort levels.",
  "commands.effort.header": "Switch thinking effort (current: **{current}**):",

  // /isomux-all-hands
  "commands.isomuxAllHands.room": "**=== Room {number} ===**",
  "commands.isomuxAllHands.me": "**(me)**",
  "commands.isomuxAllHands.desk": "desk {number}",
  "commands.isomuxAllHands.topic": "Topic: {topic}",
  "commands.isomuxAllHands.backRoom": "{count} in the back room",
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
  "systemEntries.pathRefusal.notFound": "`{path}` does not exist.",
  "systemEntries.pathRefusal.notFile": "`{path}` is not a file.",
  "systemEntries.pathRefusal.binary":
    "`{path}` is a binary file - the editor panel only supports text.",
  "systemEntries.pathRefusal.tooLarge":
    "`{path}` is {size} - too large for the editor panel (1 MB limit).",
  "systemEntries.pathRefusal.credential":
    "`{path}` holds credentials, so it does not open in the editor panel.",

  // /isomux-diff (also /diff)
  "commands.isomuxDiff.notDirectory": "`{path}` is not a directory.",
  "systemEntries.diffNotRepo": "`{path}` is not a git repository.",

  // /usage
  "commands.usage.meter":
    "Check the usage meter in the chat header for subscription limits and reset times.",
  "commands.usage.unavailable":
    "This agent does not report subscription usage.",
  "commands.usage.office":
    "For office-level token spend (per-agent / per-room / per-schedule), see `/isomux-usage`.",

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
  "systemEntries.newConversation": "New conversation started.",
  "systemEntries.autoHandoff.writingTokens":
    "Context is at {thousands}k tokens. Writing a handoff brief for a fresh session.",
  "systemEntries.autoHandoff.writingPercent":
    "Context is {percent}% full. Writing a handoff brief for a fresh session.",
  "systemEntries.autoHandoff.writingCompaction":
    "Context is {percent}% full, close to auto-compaction. Writing a handoff brief for a fresh session.",
  "systemEntries.autoHandoff.doneTokens":
    "Handed off automatically at {thousands}k tokens.",
  "systemEntries.autoHandoff.donePercent":
    "Handed off automatically at {percent}% context.",
  "systemEntries.autoHandoff.doneCompaction":
    "Handed off automatically at {percent}% context, before auto-compaction.",
  "systemEntries.autoHandoff.failed":
    "Automatic handoff did not complete. This conversation continues.",
  "systemEntries.autoHandoff.paused":
    "Automatic handoff is paused for this conversation: it started above the handoff threshold.",
  "systemEntries.limitResume.resumed":
    "Usage limit reset. Isomux resumed the agent.",
  "systemEntries.usageCap.pace":
    "Member turns are paused: office usage has reached today's member limit. They resume {when}.",
  "systemEntries.usageCap.headsUp":
    "Office usage is close to today's member limit. Member turns pause when it is reached.",
  "systemEntries.agentStopped": "Agent stopped: {status}.",
  "systemEntries.backendFailure.stoppedDuringTurn":
    "The agent backend stopped during the turn. The conversation is saved and can be resumed.",
  "systemEntries.backendFailure.sigterm":
    "The agent backend was terminated by SIGTERM (exit code {code}). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
  "systemEntries.backendFailure.sigkill":
    "The agent backend was killed by SIGKILL (exit code {code}). The likely cause is the out-of-memory protection on this machine. The conversation is saved and can be resumed.",
  "systemEntries.backendFailure.serverStopped":
    "The agent backend stopped because the Isomux server was shutting down or restarting (exit code {code}). The conversation is saved and can be resumed.",
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
  "systemEntries.wake.env":
    "Resumed your session with the current secrets and variables.",
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
  "systemEntries.codexSandboxUnavailable":
    "This container cannot run Codex's sandbox, so commands run with full access inside the container.",
  "systemEntries.providerRefused":
    'The provider `{provider}` refused the request: "{message}"',
  "systemEntries.openCodeFreeTierHint":
    "OpenCode may also send this when a server uses too much of its free tier. A paid model or OpenCode Go avoids it.",
  "systemEntries.openCodeProviderRetry":
    'The provider `{provider}` reported: "{message}"; retrying {attempt} of {maxAttempts}.',
  "systemEntries.openCodePreviousSettings":
    "This turn uses your previous Integrations settings.",
  "systemEntries.codexInterruptFallback":
    "Codex didn't honor the interrupt in time; falling back to a fresh session.",
  "systemEntries.deliveryStalled": "Message delivery stalled; recovering.",
  "systemEntries.freshSessionAfterRestoreFailure":
    "Started a fresh session (previous one could not be restored).",
  "systemEntries.freshSessionBeforeFlush":
    "Started a fresh session before flushing queued messages.",
  "systemEntries.flushStartFailed":
    "Cannot start session to flush queue: {error}\nType /clear to start fresh, or /resume to pick another session.",
  "systemEntries.restartingForSettings":
    "Restarting session to apply settings; queued messages will send after the restart.",
  "systemEntries.settingsNotice.changed":
    "{names} changed your settings and your session restarted.",
  "systemEntries.settingsNotice.change": "{setting}: {from} → {to}",
  "systemEntries.settingsNotice.interrupted":
    "The restart stopped your previous turn.",
  "systemEntries.flushError": "Error flushing queue: {error}",
  "systemEntries.genericError": "Error: {error}",
  "systemEntries.restoreOnStartupFailed":
    "Failed to restore on startup: {error}\nType /clear to start fresh, or /resume to pick another session.",
  "systemEntries.flushInterrupted":
    "Queue flush interrupted by session change; will retry.",
  "systemEntries.sessionStartFailed":
    "Cannot start session: {error}\nType /clear to start fresh, or /resume to pick another session.",
  "systemEntries.queueFailed": "Could not queue message: {error}",
  "systemEntries.queueKept.notConfigured.one":
    "Kept {count} queued message. It goes out with the next message.",
  "systemEntries.queueKept.notConfigured.other":
    "Kept {count} queued messages. They go out with the next message.",
  "systemEntries.queueCarried.one":
    "Moved {count} queued message to this conversation.",
  "systemEntries.queueCarried.other":
    "Moved {count} queued messages to this conversation.",
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
  "systemEntries.resumeFailed":
    "Failed to resume: {error}\nType /clear to start fresh, or /resume to pick another session.",
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
    "Integrations → Model providers (Office-wide)",
  "systemEntries.claudeAuth.personalLocation":
    "Integrations → Model providers (Personal)",
  "systemEntries.claudeAuth.disconnected":
    "Claude rejected the credentials. Sign in to Claude in {location}.",
  "systemEntries.claudeAuth.disconnectedAskOwner":
    "Claude rejected the credentials. Ask an office owner to sign in.",
  "systemEntries.claudeAuth.signingIn":
    "Claude rejected the credentials. A Claude sign-in is in progress. Retry the request when it finishes.",
  "systemEntries.claudeAuth.accessUnavailable":
    "Claude Code access is not available for this account. Check its subscription, or sign in with another account.",
  "systemEntries.claudeAuth.pinned":
    "This conversation keeps the Claude account it started with. Start a new conversation (`/clear`) to use the new account.",
  "systemEntries.claudeSession.invalid":
    "Cannot access this Claude conversation.",
  "systemEntries.claudeSession.missing":
    "Cannot resume Claude session {session}…: its file was not found. Paths checked: {paths}.",
  "systemEntries.loginInstructions.generic":
    "To authenticate:\n1. Open the built-in terminal\n2. Run `claude`\n3. Type `/login`\n4. Follow the auth flow\n\nOnce complete, it takes effect immediately for all Isomux agents.",
  "systemEntries.loginInstructions.claude":
    "To authenticate Claude Code:\n1. Open the built-in terminal\n2. Run `{command}`\n3. Type `/login`\n4. Follow the auth flow\n\nOnce complete, it takes effect immediately for all Isomux agents.\n\nAlternative: add `ANTHROPIC_API_KEY` on the Integrations page (Variables tab), then `/clear`.",
  "systemEntries.loginInstructions.claudeSignedIn":
    "Claude Code is signed in. Type `/clear` to refresh this agent's session and pick up the new auth.",
  "systemEntries.loginInstructions.codex":
    "To sign in to Codex, click [Copy to terminal] on the card below:\n\n- `{command} login --device-auth`\n\nPress Enter to run, follow the prompts, then `/clear` this conversation to apply the new auth. Other codex agents apply on their next `/clear`.\n\nAlternative: add `OPENAI_API_KEY` on the Integrations page (Variables tab), then `/clear`.",
  "systemEntries.loginInstructions.codexSignedIn":
    "Codex is signed in. Type `/clear` to refresh this agent's session and pick up the new auth.",
  "systemEntries.loginInstructions.codexKeyRejected":
    "Codex rejected `OPENAI_API_KEY`. Fix or remove it on the Integrations page, then `/clear`.",
  "systemEntries.loginInstructions.openCode":
    "Add `OPENCODE_API_KEY` on the Integrations page (Variables tab), then `/clear`, or use an agent with the Claude or Codex backend.",
  "systemEntries.codexTokenRefresh":
    "Codex asked to refresh its ChatGPT sign-in, which Isomux cannot do.",
  "systemEntries.codexSession.missing":
    "Cannot resume Codex thread {thread}…: no rollout file found under {dir}. This usually means the thread was started but never received a user turn before its process exited.",
  "systemEntries.openCodeSession.empty":
    "Cannot resume OpenCode session {session}: it has no stored messages.",
  "systemEntries.openCodeSession.missing":
    "Cannot resume OpenCode session {session}: it is missing from the selected OpenCode profile.",
  "systemEntries.claudeExit.cwdMissing":
    "Likely cause: cwd `{cwd}` no longer exists. Click the agent name in the log view header to point it at a valid directory.",
  "systemEntries.cwdInvalid.missing":
    "cwd is invalid: Directory does not exist: {path}. Click the agent name in the log view header to fix it.",
  "systemEntries.cwdInvalid.notDirectory":
    "cwd is invalid: Not a directory: {path}. Click the agent name in the log view header to fix it.",
  "systemEntries.cwdInvalid.inaccessible":
    "cwd is invalid: Cannot access {path}: {message}. Click the agent name in the log view header to fix it.",
  "systemEntries.scheduleRun.resumeSkipped":
    "Cannot resume a skipped run - it never opened a session.",
  "systemEntries.scheduleRun.resumeNoInit":
    "Cannot resume: the original run never reached backend init.",
  "systemEntries.scheduleRun.resumeCwd.missing":
    "Cannot resume: cwd is invalid: Directory does not exist: {path}",
  "systemEntries.scheduleRun.resumeCwd.notDirectory":
    "Cannot resume: cwd is invalid: Not a directory: {path}",
  "systemEntries.scheduleRun.resumeCwd.inaccessible":
    "Cannot resume: cwd is invalid: Cannot access {path}: {message}",
  "systemEntries.scheduleRun.envFailed": "Cannot build env: {error}",
  "systemEntries.scheduleRun.openCodeJobDeleted":
    "Cannot resume this OpenCode run because its schedule was deleted and its shared environment profile can no longer be resolved.",
  "systemEntries.scheduleRun.jobDeleted":
    "Run stopped: the schedule was deleted.",
  "systemEntries.scheduleRun.sendFailed": "Failed to send: {error}",
  "systemEntries.scheduleRun.editBusy": "Cannot edit while the run is busy.",
  "systemEntries.scheduleRun.editSkipped":
    "Cannot edit a skipped run - it never opened a session.",
  "systemEntries.scheduleRun.editNoInit":
    "Cannot edit: the original run never reached backend init.",
  "systemEntries.scheduleRun.editCwd.missing":
    "Cannot edit: cwd is invalid: Directory does not exist: {path}",
  "systemEntries.scheduleRun.editCwd.notDirectory":
    "Cannot edit: cwd is invalid: Not a directory: {path}",
  "systemEntries.scheduleRun.editCwd.inaccessible":
    "Cannot edit: cwd is invalid: Cannot access {path}: {message}",
  "systemEntries.scheduleRun.editFailed": "Cannot edit: {error}",
  "systemEntries.scheduleRun.editMessageNotFound":
    "Cannot edit: message not found.",
  "systemEntries.scheduleRun.loadMessagesFailed":
    "Failed to load session messages: {error}",
  "systemEntries.scheduleRun.editMessageNotInSession":
    "Cannot edit: could not locate message in backend session.",
  "systemEntries.scheduleRun.editNoFork":
    "Cannot edit: backend returned a fresh session (no linked fork).",
  "systemEntries.scheduleRun.forkFailed": "Fork failed: {error}",
  "systemEntries.scheduleRun.forkStartFailed": "Failed to start fork: {error}",
  "systemEntries.claudeSession.missingAfterExit":
    "Cannot resume Claude session {session}…: its file was not found. Paths checked: {paths}. Use /resume to select another conversation, or start a new conversation.",
  "systemEntries.scheduleRun.resumeFailed": "Failed to resume: {error}",
  "systemEntries.claudeAuth.connected":
    "This conversation may still use the credentials it started with. Start a new conversation (`/clear`) to use the current Claude sign-in.",
  "systemEntries.claudeAuth.incomplete":
    "The Claude connection check could not finish. Retry the request or sign in to Claude in Settings.",
  "systemEntries.signInRequired":
    "{provider} could not run this message because it is not signed in. Sign in below to continue.",
  "systemEntries.signInPrompt": "Sign in to {provider} below.",
  "systemEntries.notSignedIn": "{provider} is not signed in.",
  "systemEntries.signInRequiredOffice":
    "{provider} could not run this message because it is not signed in.",
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
  "preAuth.claim.keyLabel": "Setup key",
  "preAuth.claim.keyFromFile":
    "The server printed a link with this key when it started. The key is also in {path} on the server.",
  "preAuth.claim.keyFromEnv":
    "Use the value of {name} from this office's deployment settings.",
  "preAuth.claim.keyFromRender":
    "Render made it at deploy time. Find {name} in the service's Environment settings.",
  "preAuth.claim.keyFromContainer":
    "Use the value of {name} set for this container. With the AWS Compose setup, it is in {file}.",
  "preAuth.claim.errorKey": "The setup key is missing or wrong.",
  "preAuth.claim.errorTooManyTries":
    "Too many wrong setup keys. Try again in a minute.",
  "preAuth.invite.titleAccept": "accept invite",
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
  // Settings → You → Pager (server/pager-settings.ts) and the delivery
  // failure classes (server/pager-delivery.ts).
  "settings.sidebar.pager": "Pager",
  "pager.settings.intro":
    "Agents page you when they need you. Pages show in your Inbox and reach the places below.",
  "pager.settings.thisDevice": "This device",
  "pager.settings.discord": "Discord",
  "pager.settings.webhook": "Webhook URL",
  "pager.settings.webhookHint":
    "In Discord: the channel's settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.",
  "pager.settings.webhookNone": "Not set.",
  "pager.settings.webhookRemove": "Remove webhook",
  "pager.settings.userId": "User ID",
  "pager.settings.userIdHint":
    "Pages mention you, so Discord notifies you. In Discord: User Settings → Advanced → Developer Mode, then right-click your name (long-press on a phone) → Copy User ID.",
  "pager.settings.repeat": "Repeat an open page",
  "pager.settings.repeatNever": "Never",
  "pager.settings.repeatEvery": "Every {count} min",
  "pager.settings.phoneHint":
    "On your phone, keep Discord notifications on for this server, at least for @mentions.",
  "pager.settings.repeatEveryHours.other": "Every {count} hours",
  "pager.settings.repeatEveryHours.one": "Every {count} hour",
  "pager.settings.webhookSaved": "Saved",
  "pager.settings.saved": "Saved.",
  "pager.settings.loadFailed": "Could not load the pager settings.",
  "pager.settings.test": "Send test page",
  "pager.settings.testSent": "Test page sent.",
  "pager.settings.testFailed": "Test page not sent: {reason}.",
  "pager.failure.noWebhook": "Discord not set up",
  "pager.failure.http4xx": "Discord rejected the page",
  "pager.failure.http5xx": "Discord error",
  "pager.failure.rateLimited": "Discord rate limit",
  "pager.failure.network": "Discord unreachable",
  // The Discord message around the page's own title (server/pager-delivery.ts).
  "pager.discord.stillOpen": "Still open: {title}",
  "pager.discord.resolved": "Resolved: {title}",
  "pager.discord.test": "Test page from Isomux.",
  // The Inbox, its nav entry and its Pages tab (ui/components/InboxView.tsx).
  "nav.inbox": "Inbox",
  "nav.inboxOpenCount.one": "Inbox: {count} open item",
  "nav.inboxOpenCount.other": "Inbox: {count} open items",
  "inbox.tab.pages": "Pages",
  // The Pages tab (ui/components/PagerView.tsx).
  "pager.view.shown": "{count} shown",
  "pager.view.filterActive": "Open and acked",
  "pager.view.stateFilter": "State",
  "pager.view.roomFilter": "Room",
  "pager.view.filterAll": "All",
  "pager.view.allRooms": "All rooms",
  "pager.view.noRoom": "No room",
  "pager.view.empty": "No pages",
  "pager.view.discordUnset":
    "Neither Discord nor device notifications are set up, so your pages stay in the office.",
  "pager.view.settingsLink": "Pager settings",
  "pager.view.loadFailed": "Could not load pages.",
  "pager.view.retry": "Try again",
  "pager.view.loadMore": "Load more",
  "pager.view.unavailable":
    "That page is not available. It does not exist, or it is in a room you cannot access.",
  "pager.view.appSource": "{name} (app)",
  "pager.view.openChat": "Open the chat with {name}",
  "pager.view.openApp": "Open the app {name}",
  "pager.view.raised.one": "raised {count} time",
  "pager.view.raised.other": "raised {count} times",
  "pager.view.ackedBy": "Acked by {name}, {age}",
  "pager.view.resolvedBy": "Resolved by {name}, {age}",
  "pager.state.open": "Open",
  "pager.state.acked": "Acked",
  "pager.state.resolved": "Resolved",
  "pager.delivery.sent": "Sent to Discord",
  "pager.delivery.pending": "Not sent yet",
  "pager.delivery.notSent": "Not sent: {reason}",
  "pager.delivery.failed": "Last send failed: {reason}",
  "pager.action.ack": "Ack",
  "pager.action.resolve": "Resolve",
  "pager.action.failed": "Could not change the page.",
  "apiCall.pagerSettings.read": "Read pager settings",
  "apiCall.pagerSettings.save": "Save pager settings",
  "apiCall.pagerSettings.test": "Send test page",
  "push.test": "Test notification from Isomux.",
  "push.turnEnd.title": "{agent} finished",
  "push.settings.switch": "Notifications",
  "push.settings.test": "Send test notification",
  "push.settings.testSent": "Test notification sent.",
  "push.settings.testFailed": "Test notification not sent: {reason}.",
  "push.settings.iosInstall":
    "On iPhone and iPad, add Isomux to the Home Screen and open it from there.",
  "push.settings.unsupported": "This browser cannot show push notifications.",
  "push.settings.blocked":
    "Notifications for Isomux are blocked in this browser's settings.",
  "push.settings.failed": "Could not change notifications on this device.",
  "push.settings.otherDevices": "Other devices ({count})",
  "push.settings.remove": "Remove",
  "push.settings.unnamed": "Unnamed device",
  "push.failure.gone": "subscription expired",
  "push.failure.rejected": "the push service rejected it",
  "push.failure.unreachable": "push service unreachable",
  "apiCall.pushDevices.list": "List notification devices",
  "apiCall.pushDevices.add": "Turn on device notifications",
  "apiCall.pushDevices.remove": "Remove notification device",
  "apiCall.pushDevices.test": "Send test notification",
  "common.skills": "Skills",
  "skills.engine": "Engine",
  "skills.search": "Search skills",
  "skills.new": "New skill",
  "skills.group.user": "User skills",
  "skills.group.project": "Project skills",
  "skills.group.plugin": "Plugin skills",
  "skills.group.isomux": "Built into Isomux",
  "skills.source.user": "User",
  "skills.source.project": "Project",
  "skills.source.plugin": "Plugin",
  "skills.source.isomux": "Built-in",
  "skills.readOnly": "Read-only",
  "skills.readOnly.isomux": "Built into Isomux. Read-only.",
  "skills.readOnly.plugin": "Installed by the {plugin} plugin. Read-only.",
  "skills.uses.one": "{count} use",
  "skills.uses.other": "{count} uses",
  "skills.noDescription": "No description.",
  "skills.notUsed": "Does not run",
  "skills.shadowed":
    "Does not run on {engine}. A skill with the same name comes first:",
  "skills.field.project": "Project",
  "skills.field.alias": "Also runs as",
  "skills.field.engines": "Runs on",
  "skills.delete.title": "Delete /{name}?",
  "skills.delete.folder":
    "This deletes the skill folder, including scripts and resources. Links are removed; their targets remain.",
  "skills.delete.command":
    "This deletes the command file. If it is a link, its target remains.",
  "skills.delete.stale": "The file changed. Reopen it before deleting.",
  "skills.delete.failed": "Could not delete the skill.",
  "apiCall.skills.delete": "Delete a skill",
  "skills.commands": "Commands",
  "skills.commands.note": "These commands are built in, not skills.",
  "skills.commands.search": "Search commands",
  "skills.allAgents": "All agents",
  "skills.invalid.frontmatter":
    "Start the file with YAML front matter between --- lines.",
  "skills.invalid.unclosed": "Close the YAML front matter with a --- line.",
  "skills.invalid.yaml": "The front matter contains invalid YAML.",
  "skills.invalid.mapping": "The front matter must contain YAML fields.",
  "skills.invalid.name": "Add a nonempty name field with a text value.",
  "skills.invalid.description":
    "Add a nonempty description field with a text value.",
  "skills.view.source": "SKILL.md",
  "skills.view.preview": "Preview",
  "skills.select": "Select a skill to read its SKILL.md.",
  "skills.empty": "No skills match.",
  "skills.backToList": "All skills",
  "skills.loadFailed": "Could not load the skills.",
  "skills.readFailed": "Could not read this skill.",
  "skills.saveStale":
    "Not saved: the file changed on disk after you opened it. Copy your edit, then reload.",
  "skills.saveDeleted": "Not saved: the file was deleted on disk.",
  "skills.reload": "Reload",
  "skills.create.title": "New skill",
  "skills.create.nameHint": "Lowercase letters, digits and hyphens.",
  "skills.create.invalidName":
    "Use lowercase letters, digits and single hyphens, up to 64 characters.",
  "skills.create.description": "Description",
  "skills.create.descriptionHint":
    "One line. Agents read it to decide when to use the skill.",
  "skills.create.invalidDescription":
    "Write the description on one line, up to 1024 characters.",
  "skills.create.instructions": "Instructions",
  "skills.create.instructionsPlaceholder":
    "What the agent does when someone runs this skill.",
  "skills.create.agentHint":
    "You can ask your agents to create skills for you.",
  "skills.create.allAgents": "All agents can use this skill.",
  "skills.create.where": "Saved as {path}",
  "skills.create.exists": "A skill with this name exists.",
  "skills.create.failed": "Could not create the skill.",
  "skills.create.submit": "Create",
  "apiCall.skills.list": "List skills",
  "apiCall.skills.read": "Read a skill",
  "apiCall.skills.save": "Save a skill",
  "apiCall.skills.create": "Create a skill",
  "appWidget.launcher": "Chat",
  "appWidget.title": "Chat with {agentName}",
  "appWidget.notice": "Shared with members of the agent's room.",
  "appWidget.windowsHint":
    "To share a screenshot: press Win+Shift+S, then paste it here.",
  "appWidget.macHint":
    "To share a screenshot: press Shift+Command+4, then drag it here.",
  "appWidget.genericHint":
    "To share a screenshot: take one, then paste or attach it here.",
  "appWidget.attach": "Attach image",
  "appWidget.direct": "Open app directly",
  "appWidget.unavailable": "Chat is unavailable.",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

/** A complete translation: every English key, each with a string. */
export type Catalog = Record<MessageKey, string>;
