// Manual SDK-upgrade gate. This contacts the providers but uses clean temporary
// profiles and never completes a sign-in or reads the office's credentials.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CodexAccountClient } from "../server/backends/codex/account.ts";
import { CLAUDE_NATIVE_BIN } from "../server/cwd-utils.ts";

function assertHttps(value: unknown): void {
  if (typeof value !== "string" || new URL(value).protocol !== "https:")
    throw new Error("provider returned a non-HTTPS URL");
}

async function codex(home: string): Promise<void> {
  for (const method of ["browser", "device"] as const) {
    const client = new CodexAccountClient({ ...process.env, CODEX_HOME: home });
    await client.start();
    const before = await client.read();
    if (before.connected)
      throw new Error("clean Codex profile unexpectedly connected");
    const started = await client.login(method);
    assertHttps(started.authUrl);
    if (method === "device" && !started.userCode)
      throw new Error("device flow returned no code");
    await client.cancel(started.loginId);
    const after = await client.read();
    if (after.connected)
      throw new Error("canceled clean Codex profile unexpectedly connected");
    await client.close();
  }
  console.log(
    "Codex: browser and device start/shape/cancel/account-read passed.",
  );
}

async function claude(configDir: string): Promise<void> {
  const abortController = new AbortController();
  async function* input(): AsyncGenerator<never> {
    if (abortController.signal.aborted) yield undefined as never;
    await new Promise<void>(() => {});
  }
  const q = query({
    prompt: input(),
    options: {
      cwd: tmpdir(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      settingSources: [],
      pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
      abortController,
    },
  });
  const seam = q as unknown as {
    claudeAuthenticate?: (
      claudeAi: boolean,
    ) => Promise<{ manualUrl?: unknown; automaticUrl?: unknown }>;
    claudeOAuthCallback?: (code: string, state: string) => Promise<unknown>;
    claudeOAuthWaitForCompletion?: () => Promise<unknown>;
  };
  if (
    typeof seam.claudeAuthenticate !== "function" ||
    typeof seam.claudeOAuthCallback !== "function" ||
    typeof seam.claudeOAuthWaitForCompletion !== "function"
  )
    throw new Error("Claude OAuth controls are unavailable");
  const urls = await seam.claudeAuthenticate(true);
  assertHttps(urls.manualUrl);
  assertHttps(urls.automaticUrl);
  abortController.abort();
  console.log(
    "Claude: capability and URL-shape probe passed. This does not test the code exchange or provider acceptance of the private subtype.",
  );
}

const root = await mkdtemp(join(tmpdir(), "isomux-provider-login-probe-"));
try {
  await codex(join(root, "codex"));
  await claude(join(root, "claude"));
} finally {
  await rm(root, { recursive: true, force: true });
}
