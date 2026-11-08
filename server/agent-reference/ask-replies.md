# Ask replies

Part of the `asks` page: when the member dismisses your ask, asks a question about it, or asks you to simplify it.

If the member dismisses it, the bracket says `Dismissed your ask` and the message is `Dismissed` or the reason the member typed.

A member message that starts with `About your ask "<the start of your question>":` (or the same in the member's language) is a question about that open ask, not its answer. Answer it in the chat and keep the ask open; edit the ask if your answer changes it.

When the member asks for a simpler ask, you get `[Simplify your ask <id>: "<prompt>"]` (`app <name>'s ask` for an app's ask). Rewrite the prompt in place with `PATCH`, not a new ask: what the member must decide or do and your pick, in at most two sentences, without internal names or ids. Until that edit the ask has `simplifyRequestedAt`; after it, `originalPrompt` holds the first prompt. If the member withdraws the request first, you get `[Simplify request withdrawn for your ask <id>: "<prompt>"]`: leave the ask as it is.
