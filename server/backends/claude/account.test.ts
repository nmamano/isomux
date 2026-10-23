import { describe, expect, it } from "bun:test";
import { expectRejection } from "../../test-support/expect-rejection.ts";
import { ClaudeAccountClient } from "./account.ts";

describe("ClaudeAccountClient", () => {
  it("launches the CLI with vendor telemetry, error reporting and MCP servers off", async () => {
    const env = { DISABLE_TELEMETRY: "", KEEP_ME: "yes" };
    let received: unknown;
    const client = new ClaudeAccountClient(env, (options) => {
      received = options;
      return {
        claudeAuthenticate: async () => ({}),
        claudeOAuthCallback: async () => {},
        claudeOAuthWaitForCompletion: async () => {},
        accountInfo: async () => ({}),
      };
    });
    await client.start();
    // Task c52bd005: a probe sends no prompt, so a claude.ai connector it
    // starts is network and OAuth work for nothing.
    expect(received).toMatchObject({
      options: {
        strictMcpConfig: true,
        settings: {
          autoMemoryEnabled: false,
          env: { DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
        },
        env,
      },
    });
    await client.close();
  });

  // A provider other than first party owns its auth: connected, with no
  // stale email label, even when tokenSource says "none".
  it("recognizes external provider auth whatever its tokenSource", async () => {
    const client = new ClaudeAccountClient({}, () => ({
      claudeAuthenticate: async () => ({}),
      claudeOAuthCallback: async () => {},
      claudeOAuthWaitForCompletion: async () => {},
      accountInfo: async () => ({
        apiProvider: "bedrock",
        tokenSource: "none",
        email: "stale@example.com",
      }),
    }));
    await client.start();
    expect(await client.read()).toEqual({ connected: true, label: undefined });
    await client.close();
  });

  it("closes the SDK query even while initialization is pending", async () => {
    let closed = 0;
    let controller: AbortController | undefined;
    const client = new ClaudeAccountClient({}, (options) => {
      controller = (
        options as { options: { abortController: AbortController } }
      ).options.abortController;
      return {
        claudeAuthenticate: async () => ({}),
        claudeOAuthCallback: async () => {},
        claudeOAuthWaitForCompletion: async () => {},
        accountInfo: () => new Promise(() => {}),
        close: () => {
          closed++;
        },
      };
    });
    void client.start();
    await client.close();
    await client.close();
    expect(controller?.signal.aborted).toBe(true);
    expect(closed).toBe(1);
  });

  it("closes a query returned after cancellation inside its factory", async () => {
    let closed = 0;
    const client = new ClaudeAccountClient({}, (options) => {
      (
        options as { options: { abortController: AbortController } }
      ).options.abortController.abort();
      return {
        close: () => {
          closed++;
        },
      };
    });
    expect(
      await client.start().then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect(closed).toBe(1);
  });

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

  // The state guards against a code from another sign-in (OAuth CSRF).
  it("accepts a callback URL or code#state, and rejects a state from another sign-in", async () => {
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
    await client.submitCode("pasted#original");
    for (const forged of [
      "https://platform.claude.com/oauth/code/callback?code=x&state=forged",
      "x#forged",
    ])
      await expectRejection(client.submitCode(forged), /./);
    expect(callbacks).toEqual(["returned:original", "pasted:original"]);
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
    // No auth URL reaches the member.
    expect(error).toBeInstanceOf(Error);
  });
});
