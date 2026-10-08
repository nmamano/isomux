import { afterEach, describe, expect, it } from "bun:test";
import {
  OfficeSocket,
  judgeAnswer,
  judgeSignedOut,
  sendMessage,
  stripAnsi,
  type Entry,
} from "./check.ts";
import { claimOwner, preClaimProbe, sessionCookie } from "./claim.ts";

const entry = (
  kind: string,
  content: string,
  providerLogin?: string,
): Entry => ({
  id: `${kind}-${content.length}`,
  agentId: "agent-1",
  kind,
  content,
  ...(providerLogin ? { metadata: { providerLogin } } : {}),
});

describe("judgeSignedOut", () => {
  const sent = entry("user_message", "Hello");
  const notice = (engine: string) => entry("system", "sign in", engine);

  it("passes the message followed by the engine's sign-in notice alone", () => {
    expect(judgeSignedOut("codex", [sent, notice("codex")])).toBeNull();
  });

  it("fails without a notice, and names what the chat showed", () => {
    const failure = judgeSignedOut("claude", [sent, entry("text", "hi")]);
    expect(failure).not.toBeNull();
    expect(failure).toContain("hi");
  });

  it("does not take another engine's notice", () => {
    expect(judgeSignedOut("codex", [sent, notice("claude")])).not.toBeNull();
  });

  // Task 737e8c0f: the notice, then the send still reached Codex.
  it("fails a notice that comes with retry lines and a raw provider error", () => {
    const failure = judgeSignedOut("codex", [
      sent,
      notice("codex"),
      entry("system", "Reconnecting... 1/5"),
      entry("error", "unexpected status 401 Unauthorized"),
    ]);
    expect(failure).toContain("Reconnecting... 1/5");
    expect(failure).toContain("401");
  });

  it("fails any other system line next to the notice", () => {
    expect(
      judgeSignedOut("claude", [sent, entry("system", "x"), notice("claude")]),
    ).not.toBeNull();
  });
});

describe("stripAnsi", () => {
  it("removes colour, mode and title sequences", () => {
    expect(
      stripAnsi("\x1b[?2004h\x1b]0;box: ~\x07\x1b[01;32mok\x1b[00m$ "),
    ).toBe("ok$ ");
  });
});

describe("sessionCookie", () => {
  it("prefers the __Host- session cookie and drops the attributes", () => {
    expect(
      sessionCookie([
        "isomux_session=legacy; Path=/",
        "__Host-isomux_session=new; Path=/; Secure",
      ]),
    ).toBe("__Host-isomux_session=new");
  });

  it("returns null when no session cookie has a value", () => {
    expect(sessionCookie(["other=1", "isomux_session=; Max-Age=0"])).toBeNull();
  });
});

describe("claimOwner", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => server?.stop(true));

  // A stand-in office that records each claim request and answers it the way
  // the real route does.
  function office(status: number) {
    const seen: {
      path: string;
      origin: string | null;
      form: Record<string, string>;
    }[] = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          origin: request.headers.get("origin"),
          form: Object.fromEntries(new URLSearchParams(await request.text())),
        });
        return new Response("", {
          status,
          headers: {
            "Set-Cookie": "__Host-isomux_session=abc; Path=/; Secure",
            Location: "/",
          },
        });
      },
    });
    return { base: `http://127.0.0.1:${server.port}`, seen };
  }

  it("claims with the key from the printed setup link's fragment", async () => {
    const { base, seen } = office(302);
    const cookie = await claimOwner(base, "http://localhost:4000", {
      kind: "setup-link",
      name: "A",
      url: "http://localhost:4000/setup#key=k123",
    });
    expect(cookie).toBe("__Host-isomux_session=abc");
    expect(seen).toEqual([
      {
        path: "/auth/claim",
        origin: "http://localhost:4000",
        form: { name: "A", key: "k123" },
      },
    ]);
  });

  it("refuses a setup link without a key before it posts", async () => {
    const { base, seen } = office(302);
    await expect(
      claimOwner(base, "http://localhost:4000", {
        kind: "setup-link",
        name: "A",
        url: "http://localhost:4000/setup",
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("posts the configured setup key with the public origin", async () => {
    const { base, seen } = office(200);
    await claimOwner(base, "https://office.example.com", {
      kind: "setup-key",
      name: "A",
      key: "k",
    });
    expect(seen).toEqual([
      {
        path: "/auth/claim",
        origin: "https://office.example.com",
        form: { name: "A", key: "k" },
      },
    ]);
  });

  it("redeems the invite link's token", async () => {
    const { base, seen } = office(302);
    await claimOwner(base, "https://office.example.com", {
      kind: "invite",
      url: "https://office.example.com/i/tok123",
    });
    expect(seen).toEqual([
      {
        path: "/auth/accept",
        origin: "https://office.example.com",
        form: { token: "tok123" },
      },
    ]);
  });

  it("rejects an answer other than the claim route's success status", async () => {
    const { base } = office(403);
    await expect(
      claimOwner(base, "http://localhost:4000", {
        kind: "setup-link",
        name: "A",
        url: "http://localhost:4000/setup#key=k",
      }),
    ).rejects.toThrow("403");
  });

  it("probes the setup listener before a setup-key claim and /readyz otherwise", () => {
    expect(preClaimProbe("setup-key")).toBe("/health");
    expect(preClaimProbe("setup-link")).toBe("/readyz");
    expect(preClaimProbe("invite")).toBe("/readyz");
  });
});

describe("judgeAnswer", () => {
  const sent = entry("user_message", "Reply with one word: ready");

  it("passes a text answer", () => {
    expect(judgeAnswer([sent, entry("text", "ready")])).toBeNull();
  });

  it("fails a turn with no answer, or with an error next to one", () => {
    expect(judgeAnswer([sent])).not.toBeNull();
    expect(judgeAnswer([sent, entry("system", "x")])).not.toBeNull();
    expect(
      judgeAnswer([sent, entry("text", "ready"), entry("error", "boom")]),
    ).toContain("boom");
  });
});

// An office that accepts the connection and never answers: every request and
// handshake must fail on its own deadline, naming what stalled.
describe("deadlines against a stalled office", () => {
  let http: ReturnType<typeof Bun.serve> | undefined;
  let tcp: { stop(closeActiveConnections?: boolean): void } | undefined;
  afterEach(() => {
    http?.stop(true);
    tcp?.stop(true);
  });

  // The test's own bound, well above the 300 ms deadline under test: without
  // that deadline the call would hang, and this fails it with its own line.
  const bounded = <T>(call: Promise<T>) =>
    Promise.race([
      call,
      Bun.sleep(3_000).then(() => {
        throw new Error("no deadline: still waiting after 3 s");
      }),
    ]);

  const stalledHttp = () => {
    http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    return `http://127.0.0.1:${http.port}`;
  };

  it("bounds the claim", async () => {
    await expect(
      bounded(
        claimOwner(
          stalledHttp(),
          "http://localhost:4000",
          { kind: "setup-key", name: "A", key: "k" },
          300,
        ),
      ),
    ).rejects.toThrow("POST /auth/claim did not answer");
  });

  it("bounds the send", async () => {
    await expect(
      bounded(sendMessage(stalledHttp(), "o", "c", "agent-1", "Hello", 300)),
    ).rejects.toThrow("the send did not answer");
  });

  it("bounds the WebSocket handshake", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    tcp = listener;
    await expect(
      bounded(
        OfficeSocket.open(`http://127.0.0.1:${listener.port}`, "o", "c", 300),
      ),
    ).rejects.toThrow("did not open");
  });
});
