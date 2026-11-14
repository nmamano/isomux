# Context and subscription readings

`GET /api/agents/:id/context` returns `{available:true,model,totalTokens,maxTokens,percentage,sampledAtMs}` or `{available:false,reason}`. A reading can lag the active turn; describe it as roughly the last completed turn. `no_session` and `not_yet_measured` mean unknown, not empty. Check your own reading before a large task late in a long conversation; when nearly full, wrap up cleanly and tell the member a `/clear` is advisable.

`GET /api/agents/:id/subscription` refreshes provider allowance when a live session exists. Available data includes provider windows, reset times, plan, sample and observation times, age, and fresh/cached state. Agents on one provider account share the latest reading. Cached data can survive a released session and starts empty after server restart. Unavailable reasons include `no_session`, `not_yet_measured`, and `provider_unavailable`; OpenCode reports provider unavailable.

Every reply also carries `signIn`: `individual` when the agent runs on its member's own sign-in or key, `office` when it runs on the office's. With no live session, it is the sign-in the next turn starts on. When your conversation moves to or from the office sign-in, your next turn tells you.

When a usage limit stops your turn, Isomux sends you a message after the limit resets, unless `limitResume` is off in your settings.

Room access controls which agent ids the caller may inspect.

Safe example: `GET /api/agents/:id/context`.

## Route contract

`GET /api/agents/:id/context` returns the context union above. `GET /api/agents/:id/subscription` returns the provider-window union above, each branch with `signIn`, except for an agent with no record. User and API identities need target-room access; agent identities inherit their manager's room reach. An app with a live owner agent inherits that agent's room reach; other apps and cron runs are refused. Inaccessible targets return 403; provider refresh failure is represented as cached/unavailable data rather than a fabricated zero.
