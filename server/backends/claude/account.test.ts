import { describe, expect, it } from "bun:test";
import { ClaudeAccountClient } from "./account.ts";

describe("ClaudeAccountClient", () => {
  it("recognizes current first-party account info without tokenSource", async () => {
    const client = new ClaudeAccountClient({}, () => ({
      claudeAuthenticate: async () => ({ manualUrl: "https://claude.ai/" }),
      claudeOAuthCallback: async () => {},
      claudeOAuthWaitForCompletion: async () => {},
      accountInfo: async () => ({
        email: "member@example.com",
        subscriptionType: "Claude Max",
        apiProvider: "firstParty",
      }),
    }));

    await client.start();
    expect(await client.read()).toEqual({
      connected: true,
      label: "member@example.com",
    });
    await client.close();
  });

  it("does not treat retained account metadata as a live credential", async () => {
    const client = new ClaudeAccountClient({}, () => ({
      claudeAuthenticate: async () => ({ manualUrl: "https://claude.ai/" }),
      claudeOAuthCallback: async () => {},
      claudeOAuthWaitForCompletion: async () => {},
      accountInfo: async () => ({
        email: "member@example.com",
        tokenSource: "none",
        apiProvider: "firstParty",
      }),
    }));

    await client.start();
    expect(await client.read()).toEqual({
      connected: false,
      label: undefined,
    });
    await client.close();
  });

  it("keeps the undeclared OAuth controls behind its adapter", async () => {
    const calls: string[] = [];
    const raw = {
      claudeAuthenticate: async () => {
        calls.push("authenticate");
        return { manualUrl: "https://claude.com/oauth/?state=state" };
      },
      claudeOAuthCallback: async (code: string, state: string) => {
        calls.push(`callback:${code}:${state}`);
      },
      claudeOAuthWaitForCompletion: async () => {
        calls.push("wait");
        return {};
      },
      accountInfo: async () => ({
        tokenSource: calls.includes("callback:code:state") ? "oauth" : "none",
        email: "person@example.com",
      }),
    };
    const client = new ClaudeAccountClient({}, () => raw);
    await client.start();
    expect(await client.read()).toEqual({ connected: false, label: undefined });
    expect(await client.login()).toEqual({
      authUrl: "https://claude.com/oauth/?state=state",
    });
    await client.submitCode("code");
    await client.waitForCompletion();
    expect(await client.read()).toEqual({
      connected: true,
      label: "person@example.com",
    });
    expect(calls).toEqual(["authenticate", "callback:code:state", "wait"]);
  });

  it("accepts a full callback URL without exposing its fields to callers", async () => {
    const callbacks: string[] = [];
    const client = new ClaudeAccountClient({}, () => ({
      claudeAuthenticate: async () => ({
        manualUrl: "https://claude.com/oauth/?state=original",
      }),
      claudeOAuthCallback: async (code: string, state: string) => {
        callbacks.push(`${code}:${state}`);
      },
      claudeOAuthWaitForCompletion: async () => ({}),
      accountInfo: async () => ({ tokenSource: "none" }),
    }));
    await client.start();
    await client.login();
    await client.submitCode(
      "https://platform.claude.com/oauth/code/callback?code=returned&state=original",
    );
    expect(callbacks).toEqual(["returned:original"]);
  });

  it("falls back before auth when any private method is absent", async () => {
    let authenticated = false;
    const client = new ClaudeAccountClient({}, () => ({
      claudeAuthenticate: async () => {
        authenticated = true;
        return { manualUrl: "https://claude.com/oauth/" };
      },
      claudeOAuthCallback: async () => {},
      accountInfo: async () => ({ tokenSource: "none" }),
    }));
    let error: unknown;
    try {
      await client.start();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Browser sign-in is not available with this provider version. Use the terminal instead.",
    );
    expect(authenticated).toBe(false);
  });

  it("rejects a non-HTTPS provider URL", async () => {
    const client = new ClaudeAccountClient({}, () => ({
      claudeAuthenticate: async () => ({ manualUrl: "http://claude.test/" }),
      claudeOAuthCallback: async () => {},
      claudeOAuthWaitForCompletion: async () => ({}),
      accountInfo: async () => ({ tokenSource: "none" }),
    }));
    await client.start();
    let error: unknown;
    try {
      await client.login();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Browser sign-in is not available with this provider version. Use the terminal instead.",
    );
  });
});
