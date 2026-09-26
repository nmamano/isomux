## Connect a provider and send a message

In the office, open **Settings → You → Individual connections**.

- For Claude or Codex, select the provider's sign-in control and complete the
  instructions shown. If Isomux asks to install the Claude CLI, complete that
  step first. Codex is bundled with Isomux.
- For OpenCode, which needs Linux, open or create an OpenCode agent and choose
  a model. Its model picker offers Free, Pay-as-you-go, and Subscription options. A Free model
  provides a starting path without a paid provider connection.
- For a provider API key, add its environment variable in Individual connections:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENCODE_API_KEY`, as applicable.

Open an agent that uses the connected provider and send a short message. A reply
confirms that the office can use your provider account. Provider charges and
subscription limits are separate from hosting.

For Claude through Amazon Bedrock or another connection method, use the
[provider reference](access-and-invites.md#use-your-own-provider-account).
