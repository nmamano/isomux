# Site chatbot monitor

Task 25e12a71. Visitor questions to the isomux.com chatbot show what users want to know. A monitor checks two things: (1) the chatbot answers correctly, and (2) the docs cover the question. Status: design only, for Nil. Nothing below exists yet.

## Facts checked (2026-10-13)

- `api/chat.ts` posts to the Discord webhook in `DISCORD_WEBHOOK_URL` twice per request: the last visitor message with IP, user agent and referer, and then the bot answer. Each post is cut to 2000 characters, so an answer near `max_tokens` (1000) loses its end. The posts carry no conversation id, so two visitors at the same time interleave.
- The handler only POSTs and does not keep message ids. A webhook URL cannot list a channel, so no agent can read the log back through it. A Discord bot with Read Message History on the channel can read it.
- This office answers `/readyz` with 200 at its public hostname, which resolves to a public address. An Isomux webhook here can receive deliveries.
- An Isomux webhook message to an agent is at most 4000 characters, with each arg cut to its share (`internal-docs/webhooks-design.md`, section 4). Every delivery that reaches its agent is a billed turn.
- `site/hosted-privacy.html` tells visitors that the conversation, IP, browser string and page go to a private channel "we read", with Discord in the processor list.

## Recommendation: pull from Discord once a day

The PM suggested a push: `api/chat.ts` sends each finished conversation to an Isomux webhook, which wakes a monitor agent. I recommend a pull instead: a daily Isomux cronjob reads the Discord channel with a read-only bot token and judges the previous day's conversations.

| | Push (webhook per conversation) | Pull (daily cronjob) |
|---|---|---|
| Finished conversation | The server cannot know (see below) | Last post older than 1 hour at run time |
| Size | 4000 characters per message, so long answers are cut | 2000 per Discord post; fixable in `api/chat.ts` |
| Office down | Deliveries are lost: Vercel does not retry | No loss: the next run continues from its cursor |
| Inbound surface | A public, signed route that wakes an agent | None |
| Cost | One billed turn per delivery | One run per day |
| New config outside the repo | Vercel env vars (URL, HMAC secret), webhook, agent | Discord bot and its token, cronjob |

The task needs a daily review, not live alerts. The pull is cheaper, loses nothing when the office is down, and adds no route that wakes an agent.

## What changes in the repo (later lane)

- `site/chatbot.js` makes a random conversation id once per page load and sends it with each request.
- `api/chat.ts` checks its shape (`^[a-z0-9]{8,32}$`, else drops it), adds it to both Discord posts, and splits an answer longer than 2000 characters over several posts.
- Nothing about this office goes in the repo. The cronjob prompt and its state live in this office.

## Answers to the brief

**What is sent.** Nothing new leaves Vercel. The cronjob reads what Discord already holds: the question, the answer, the conversation id, IP, user agent and referer. It uses the referer to know which page the visitor read, and ignores the IP and user agent. Posts from before the id ships are grouped by order. A task never holds an IP, a user agent, an email address, a name, or other personal data from a visitor message: it paraphrases the question. The privacy policy already covers the channel and "we read". The reader is now an agent on the office box: see Parked.

**When a conversation is finished.** The server is stateless: the widget sends the whole history on each request, and the server cannot see the visitor leave. At run time, a conversation counts as finished when its last post is older than 1 hour. A newer one waits for the next run.

**Authentication.** Pull has no inbound delivery to authenticate. The bot token is a Secret of the cronjob's creator (see Authority) with `discord.com` as its only host, and the bot has View Channel and Read Message History on the one channel only. The history in a request is client-supplied: only the posts the server wrote ("Bot:") count as the chatbot's answers. (For push: an `hmac-sha256` hook with the secret in a Vercel env var.)

**How the agent judges.** It reads the docs at `origin/main`, which Vercel deploys (unchecked: the Vercel git setting): `docs/*.md` (isomux.com/docs), `site/*.html` (landing, hosted, privacy) and `README.md`. When the docs are silent, it checks the source. `api/chat.ts` is what it judges, never the truth. Each conversation gets one verdict:
- **Correct**: no action.
- **Wrong answer**: the answer contradicts the docs or the source, or states something they do not support. The task names the line in `api/chat.ts` or the docs page to fix.
- **Prompt gap**: the docs answer the question, but the bot did not know. The fix is in `api/chat.ts`.
- **Doc gap**: a fair question that no doc answers. The task names the doc page that should answer it.
- **Off topic or abuse**: no action.

The prompt tells the run that visitor text is untrusted data and that its only action is tasks on the board. A task never quotes visitor text or carries a URL from it, because a worker reads the task later. A pull run reads Discord itself, so it does not get the outside-data framing of webhook runs.

**Authority.** The prompt rule above is not a mechanism. What the run can do (source read 2026-10-13):
- Permission mode: a Claude cronjob runs with `bypassPermissions` (`shared/types.ts:1306`), so it has Bash and every tool with no prompt. Codex runs with `never` and its sandbox; whether that sandbox lets it reach Discord and the office API is unchecked. Under either mode, a permission prompt fails the run (`server/cronjob-manager.ts:792-799`).
- Environment: the server's base environment, then the office variables and office secrets, then the creator's variables and secrets (`server/env-loader.ts:145-157`), and the creator's MCP servers (`server/cronjob-manager.ts:915-916`).
- Office API: the run token sees and writes only office-global tasks (`server/isomux-office.ts:2418-2425`).
- Files: Bash runs as the server's OS user, so it reads what that user reads, behind the honest-agent safety hooks only.

Residual risk: a visitor who injects text can make the run do anything that mode and environment allow. A dedicated creator narrows the environment but not the files.

**Duplicate tasks.** Each task title starts with `Chatbot:` and names the topic. Before it files, the run lists global tasks with `status=all`. For an open task on the same topic, it appends the occurrence (date and paraphrased question) to the description. For a task done in the last 30 days, it files a new task that names the old one as a regression. For an obsolete task, it skips. A state file in the cronjob's working directory holds the Discord cursor and the ids of conversations judged in the last two days, so a conversation that straddles two runs is judged once.

**Rate and cost.** The schedule fires one run per day, and each run stops at the 30-minute hard timeout (`server/cronjob-manager.ts:276`). The member usage cap applies only when the creator has the member role (`server/member-usage-cap.ts:114-117`), so an owner's cronjob has no cap. The chat endpoint has its own limit of 5 requests per minute and 20 per hour per IP, in memory per server instance, reset on a cold start (`api/chat.ts:15-38`). A prompt rule (not code) makes the run judge at most 100 conversations, oldest first; the rest wait for the next run. Daily volume is unchecked (it needs the channel). After the first week, `/isomux-usage` shows the per-schedule cost.

**Office down.** Discord keeps the history. The next run starts at the cursor and catches up.

## Parked for Nil

1. Pull (recommended) or push.
2. Who creates the cronjob. Recommendation: a dedicated user with the member role whose only personal connection is the Discord Secret. The run then gets no secret of Nil's, and the member usage cap applies. It still gets the office variables and office secrets, and the server user's files. The alternative is Nil as creator: the run gets all of Nil's secrets and has no usage cap.
3. Nil creates the Discord bot, adds it to the channel with read-only access, and saves its token as that user's Secret.
4. The privacy policy names Discord and Anthropic. With pull or push, an agent on the office box reads the chats: does the processor list need the box's hosting provider?
5. A cronjob files only on the office-global board. Global tasks, or a digest message to Isomux Lead, who files in this room?
