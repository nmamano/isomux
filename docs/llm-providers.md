---
navTitle: LLM providers
---

# LLM provider connections

The office owner can set up office-wide connections for each LLM provider; invited members can override them with their own.

## Use your own provider account

Sign in to a provider in `Settings` → `Office` → `Office-wide connections` for every agent in the office, or in `Settings` → `You` → `Individual connections` for the agents you spawn. Claude and Codex support browser sign-in in either scope. Isomux creates a separate personal provider home when needed.

For CLI sign-in, the personal provider directory takes precedence. Provider selection variables still apply; a personal login does not disable office-wide Bedrock or Vertex settings.

Add provider API keys under `Settings` → `You` → `Individual connections`:

```text
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENCODE_API_KEY=sk-...
```

Isomux stores personal and office-wide variables in managed files under `~/.isomux/`. Personal variables override office-wide variables when an agent starts or resumes a conversation. Other per-user variables work the same way: for example, each member can set `GH_TOKEN` so their agents use their own GitHub credentials.

## Claude on Amazon Bedrock

In `Settings` → `Office` → `Office-wide connections` → `Environment variables`, add:

```text
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-west-2 (or your region)
AWS_BEARER_TOKEN_BEDROCK=ABSK...
```

The bearer token is a Bedrock API key from the AWS console (Bedrock → API keys). If you use an IAM access key instead, replace that line with `AWS_ACCESS_KEY_ID=AKIA...` and `AWS_SECRET_ACCESS_KEY=...`, plus `AWS_SESSION_TOKEN=...` if the credentials are temporary.

Then `/clear` Claude agents to pick up the variables.

Agents use the same models as the model picker. To use a different one, set `ANTHROPIC_DEFAULT_SONNET_MODEL` (or `_HAIKU_`, `_OPUS_`, `_FABLE_`) to its ID.

Bedrock offices outside the US, EU, Australia and Japan, and Vertex offices in a region that does not serve the current models, must set these to a model their region serves.

Connections shows Bedrock as connected when the variables are set; it does not check AWS model access. A member who wants their own Claude login in a Bedrock office sets `CLAUDE_CODE_USE_BEDROCK=0` in `Individual connections`. Vertex works the same way with `CLAUDE_CODE_USE_VERTEX`.

## Connection variables and directories

An office owner opens a member in `Settings` → `Members` and sees which variables that member has set. The values stay with the member.

An explicit absolute provider directory in the managed variables still overrides the Isomux-managed personal directory. Isomux does not expand `~` or `$VAR` there.

```text
CLAUDE_CONFIG_DIR=/home/<linux-user>/.isomux-users/<user>/.claude
CODEX_HOME=/home/<linux-user>/.isomux-users/<user>/.codex
```
