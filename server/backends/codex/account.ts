import { JsonRpcLiteClient, type JsonRpcNotification } from "./client.ts";
import type { LoginAccountResponse } from "./_generated/v2/LoginAccountResponse.ts";
import type { GetAccountResponse } from "./_generated/v2/GetAccountResponse.ts";
import type { AccountLoginCompletedNotification } from "./_generated/v2/AccountLoginCompletedNotification.ts";

const INIT = {
  clientInfo: { name: "isomux", version: "1", title: null },
  capabilities: {
    experimentalApi: true,
    requestAttestation: false,
    optOutNotificationMethods: null,
  },
} as const;

export interface CodexAccountInfo {
  connected: boolean;
  label?: string;
}
export interface CodexLoginStart {
  loginId: string;
  authUrl: string;
  userCode?: string;
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Codex returned an invalid sign-in URL.");
  const url = new URL(value);
  if (url.protocol !== "https:")
    throw new Error("Codex returned an invalid sign-in URL.");
  return url.toString();
}

export class CodexAccountClient {
  private readonly client: JsonRpcLiteClient;
  private completion:
    | ((value: AccountLoginCompletedNotification) => void)
    | null = null;
  private completed: AccountLoginCompletedNotification | null = null;

  constructor(env?: Record<string, string | undefined>) {
    this.client = new JsonRpcLiteClient({ env });
    this.client.onNotification((n: JsonRpcNotification) => {
      if (n.method === "account/login/completed") {
        const completed = n.params as AccountLoginCompletedNotification;
        if (this.completion) this.completion(completed);
        else this.completed = completed;
      }
    });
  }

  async start(): Promise<void> {
    await this.client.start();
    await this.client.initialize(INIT);
  }

  async read(): Promise<CodexAccountInfo> {
    const r = await this.client.request<GetAccountResponse>("account/read", {
      refreshToken: false,
    });
    if (!r.account) return { connected: false };
    return {
      connected: true,
      label:
        r.account.type === "chatgpt"
          ? (r.account.email ?? "ChatGPT")
          : "API key",
    };
  }

  async login(method: "browser" | "device"): Promise<CodexLoginStart> {
    const r = await this.client.request<LoginAccountResponse>(
      "account/login/start",
      method === "device" ? { type: "chatgptDeviceCode" } : { type: "chatgpt" },
    );
    if (r.type === "chatgpt")
      return { loginId: r.loginId, authUrl: httpsUrl(r.authUrl) };
    if (r.type === "chatgptDeviceCode")
      return {
        loginId: r.loginId,
        authUrl: httpsUrl(r.verificationUrl),
        userCode: r.userCode,
      };
    throw new Error("Codex returned an unsupported sign-in response.");
  }

  waitForCompletion(): Promise<AccountLoginCompletedNotification> {
    if (this.completed) return Promise.resolve(this.completed);
    return new Promise((resolve) => {
      this.completion = resolve;
    });
  }

  async cancel(loginId: string): Promise<void> {
    await this.client.request("account/login/cancel", { loginId });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
