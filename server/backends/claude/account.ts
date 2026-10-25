import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { CLAUDE_NATIVE_BIN } from "../../cwd-utils.ts";
import { CLAUDE_LAUNCH_SETTINGS } from "../claude.ts";
import { withAgentSpawn } from "./agent-spawn.ts";

type ClaudeOAuthSeam = {
  claudeAuthenticate?: (
    loginWithClaudeAi: boolean,
  ) => Promise<{ manualUrl?: unknown; automaticUrl?: unknown }>;
  claudeOAuthCallback?: (code: string, state: string) => Promise<unknown>;
  claudeOAuthWaitForCompletion?: () => Promise<unknown>;
  accountInfo?: () => Promise<unknown>;
  close?: () => void;
};

export interface ClaudeAccountInfo {
  connected: boolean;
  label?: string;
}

export interface ClaudeLoginStart {
  authUrl: string;
}

const CAPABILITY_ERROR =
  "Browser sign-in is not available with this provider version. Use the terminal instead.";

// The SDK surfaces the provider's raw HTTP error (e.g. "Request failed with
// status code 400") - useless to the person pasting.
const CODE_REFUSED =
  "Claude rejected this sign-in code. Click Sign in again and paste the code from the tab that opens.";

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error(CAPABILITY_ERROR);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(CAPABILITY_ERROR);
  return url.toString();
}

export class ClaudeAccountClient {
  private readonly abortController = new AbortController();
  private oauthState: string | null = null;
  // The CLI answers the callback and the wait from one sign-in flow, the wait
  // first. Its caller then closes this client, which cuts off the callback's
  // reply: after a finished flow, that lost reply is not a rejection.
  private completed = false;
  // A flow that fails after a code was sent failed on that code.
  private codeSent = false;
  private closeQuery: (() => void) | null = null;
  private seam: Required<
    Pick<
      ClaudeOAuthSeam,
      | "claudeAuthenticate"
      | "claudeOAuthCallback"
      | "claudeOAuthWaitForCompletion"
      | "accountInfo"
    >
  > | null = null;

  constructor(
    private readonly env?: Record<string, string | undefined>,
    private readonly createQuery: (options: unknown) => unknown = (options) =>
      query(options as Parameters<typeof query>[0]),
  ) {}

  async start(): Promise<void> {
    const abortController = this.abortController;
    abortController.signal.throwIfAborted();
    async function* input(): AsyncGenerator<never> {
      if (abortController.signal.aborted) yield undefined as never;
      await new Promise<void>(() => {});
    }
    const raw = this.createQuery({
      prompt: input(),
      options: withAgentSpawn({
        cwd: tmpdir(),
        env: this.env,
        settingSources: [],
        strictMcpConfig: true,
        settings: CLAUDE_LAUNCH_SETTINGS,
        pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
        abortController,
      }),
    }) as ClaudeOAuthSeam;
    this.closeQuery = () => raw.close?.();
    if (abortController.signal.aborted) {
      await this.close();
      abortController.signal.throwIfAborted();
    }
    if (
      typeof raw.claudeAuthenticate !== "function" ||
      typeof raw.claudeOAuthCallback !== "function" ||
      typeof raw.claudeOAuthWaitForCompletion !== "function" ||
      typeof raw.accountInfo !== "function"
    )
      throw new Error(CAPABILITY_ERROR);
    this.seam = raw as NonNullable<typeof this.seam>;
    await this.seam.accountInfo();
  }

  async read(): Promise<ClaudeAccountInfo> {
    const account = await this.required().accountInfo();
    if (!account || typeof account !== "object") return { connected: false };
    const value = account as Record<string, unknown>;
    // AccountInfo defines non-first-party providers as externally authenticated.
    // OAuth metadata (including a retained tokenSource) does not apply to them.
    if (
      typeof value.apiProvider === "string" &&
      value.apiProvider !== "firstParty" &&
      value.apiProvider.length > 0
    )
      return { connected: true, label: undefined };
    const connected =
      typeof value.tokenSource === "string"
        ? value.tokenSource !== "none"
        : value.apiProvider === "firstParty" &&
          typeof value.email === "string" &&
          value.email.length > 0;
    return {
      connected,
      label:
        connected && typeof value.email === "string" ? value.email : undefined,
    };
  }

  async login(): Promise<ClaudeLoginStart> {
    const result = await this.required().claudeAuthenticate(true);
    const authUrl = httpsUrl(result.manualUrl);
    this.oauthState = new URL(authUrl).searchParams.get("state");
    return { authUrl };
  }

  async submitCode(value: string): Promise<void> {
    const trimmed = value.trim();
    let code = trimmed;
    let state = this.oauthState;
    if (/^https:\/\//i.test(trimmed)) {
      const callback = new URL(trimmed);
      code = callback.searchParams.get("code") ?? "";
      const returnedState = callback.searchParams.get("state");
      if (this.oauthState && returnedState && returnedState !== this.oauthState)
        throw new Error("Claude returned an invalid sign-in code.");
      state = returnedState ?? state;
    } else {
      const separator = trimmed.lastIndexOf("#");
      if (separator > 0 && separator < trimmed.length - 1) {
        code = trimmed.slice(0, separator);
        const returnedState = trimmed.slice(separator + 1);
        if (this.oauthState && returnedState !== this.oauthState)
          throw new Error("Claude returned an invalid sign-in code.");
        state = returnedState;
      }
    }
    if (!code || !state)
      throw new Error("Claude returned an invalid sign-in code.");
    const seam = this.required();
    this.codeSent = true;
    try {
      await seam.claudeOAuthCallback(code, state);
    } catch {
      if (this.completed) return;
      throw new Error(CODE_REFUSED);
    }
  }

  async waitForCompletion(): Promise<unknown> {
    let result: unknown;
    try {
      result = await this.required().claudeOAuthWaitForCompletion();
    } catch (err) {
      if (this.codeSent) throw new Error(CODE_REFUSED, { cause: err });
      throw err;
    }
    this.completed = true;
    return result;
  }

  async close(): Promise<void> {
    this.abortController.abort();
    const close = this.closeQuery;
    this.closeQuery = null;
    close?.();
  }

  private required(): NonNullable<typeof this.seam> {
    if (!this.seam) throw new Error(CAPABILITY_ERROR);
    return this.seam;
  }
}
