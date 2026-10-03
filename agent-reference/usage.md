# Context and subscription readings

`GET /api/agents/:id/context` returns `{available:true,model,totalTokens,maxTokens,percentage,sampledAtMs}` or `{available:false,reason}`. A reading can lag the active turn; describe it as roughly the last completed turn. `no_session` and `not_yet_measured` mean unknown, not empty. Check your own reading before a large task late in a long conversation; when nearly full, wrap up cleanly and tell the member a `/clear` is advisable.

`GET /api/agents/:id/subscription` refreshes provider allowance when a live session exists. Available data includes provider windows, reset times, plan, sample and observation times, age, and fresh/cached state. Cached data can survive a released session and starts empty after server restart. Unavailable reasons include `no_session`, `not_yet_measured`, and `provider_unavailable`; OpenCode reports provider unavailable.

Room access controls which agent ids the caller may inspect.

Safe example: `GET /api/agents/:id/context`.

## Route contract

`GET /api/agents/:id/context` returns the context union above. `GET /api/agents/:id/subscription` returns the provider-window union above. User and API identities need target-room access; agent identities inherit their manager's room reach. Cron-run and app identities are refused. Inaccessible targets return 403; provider refresh failure is represented as cached/unavailable data rather than a fabricated zero.
