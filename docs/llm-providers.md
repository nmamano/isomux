---
navTitle: LLM providers
---

# LLM provider connections

The office owner can set up office-wide connections for each LLM provider; invited members can override them with their own.

## Use your own provider account

Sign in to a provider on the `Integrations` page, `Model providers` tab: on the Office-wide card for every agent in the office (owners only), or on the Personal card for the agents you spawn. Claude and Codex support browser sign-in in either scope. Isomux creates a separate personal provider home when needed.

For CLI sign-in, the personal provider directory takes precedence. Provider selection variables still apply; a personal login does not disable office-wide Bedrock or Vertex settings.

Add provider API keys on the `Integrations` page, `Variables` tab, Personal card:

```text
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENCODE_API_KEY=sk-...
```

Isomux stores personal and office-wide variables in managed files under `~/.isomux/`. Personal variables override office-wide variables. A change reaches idle agents at once and busy ones at the end of their turn; an open terminal keeps its old environment until it restarts. An agent whose conversation cannot resume picks up the change at `/clear`. Other per-user variables work the same way: for example, each member can set `GH_TOKEN` so their agents use their own GitHub credentials.

## Claude on Amazon Bedrock

On the `Integrations` page, `Variables` tab, add to the Office-wide card:

```text
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-west-2 (or your region)
AWS_BEARER_TOKEN_BEDROCK=ABSK...
```

The bearer token is a Bedrock API key from the AWS console (Bedrock → API keys). If you use an IAM access key instead, replace that line with `AWS_ACCESS_KEY_ID=AKIA...` and `AWS_SECRET_ACCESS_KEY=...`, plus `AWS_SESSION_TOKEN=...` if the credentials are temporary.

Agents run the same Claude models as with a Claude login. To use a different model, add `ANTHROPIC_DEFAULT_SONNET_MODEL` (or `_HAIKU_`, `_OPUS_`, `_FABLE_`) with its ID to the same environment variables.

Bedrock offices outside the US, EU, Australia and Japan, and Vertex offices in a region that does not serve the current models, must set these to a model their region serves.

The `Model providers` tab shows Bedrock as connected when the variables are set; it does not check AWS model access. A member who wants their own Claude login in a Bedrock office sets `CLAUDE_CODE_USE_BEDROCK=0` on their Personal card of the `Variables` tab. Vertex works the same way with `CLAUDE_CODE_USE_VERTEX`.

## Connection variables and directories

An office owner picks a member on the `Integrations` page and sees the names of that member's variables. The owner can replace or remove one; the values stay with the member.

An explicit absolute provider directory in the managed variables still overrides the Isomux-managed personal directory. Isomux does not expand `~` or `$VAR` there.

```text
CLAUDE_CONFIG_DIR=/home/<linux-user>/.isomux-users/<user>/.claude
CODEX_HOME=/home/<linux-user>/.isomux-users/<user>/.codex
OPENCODE_CONFIG_DIR=/home/<linux-user>/.isomux-users/<user>/opencode
```

OpenCode agents load user-level plugins and config from `OPENCODE_CONFIG_DIR`, else from `~/.config/opencode` of the OS user that runs the agents. Isomux's own OpenCode settings take precedence. Changes load after Isomux restarts or your variables change on the Integrations page.
