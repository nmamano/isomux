# Ask replies

Part of the `asks` page: when the member dismisses or postpones your ask, asks a question about it, or asks you to rewrite it.

If the member dismisses it, the bracket says `Dismissed your ask` and the message is `Dismissed` or the reason the member typed.

If the member postpones it, the bracket says `Postponed your ask <id>, now closed` and the message is `Not now` or the member's note. When the note names a time (`Circle back at: Monday 9am`), schedule a message to yourself for then (`scheduled-messages` page) and open the ask again then if it still applies. For an app's ask, open your own ask then and name the app's ask in it. When the note asks you to file the ask as a task, file it on the board (`tasks` page). Otherwise, without a time, decide when to ask again, or go on without an answer.

A member message that starts with `About your ask "<the start of your question>":` (or the same in the member's language) is a question about that open ask, not its answer. Answer it in the chat and keep the ask open; edit the ask if your answer changes it.

When the member asks for a rewrite, you get `[Rewrite your ask <id> in place, ...: "<prompt>"]` (`app <name>'s ask` for an app's ask) and what they want changed: shorter, more context, visuals (`readFiles` with an image or a diagram), or a question to answer inside the ask. With no words of their own, the message asks for plain words: what the member must decide or do and your pick, in at most two sentences, without internal names or ids. Edit the ask in place with `PATCH`, not a new ask and not a chat answer. Until your next change of the ask it has `simplifyRequestedAt`; after a change of the prompt, `originalPrompt` holds the first prompt. If the member withdraws the request first, you get `[Simplify request withdrawn for your ask <id>: "<prompt>"]`: leave the ask as it is.
