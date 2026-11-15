// A resumed session that the OpenCode server does not have (task b94dfd25
// part 2b-i). OpenCode 2.2.5 answers every route of a missing session with
// HTTP 404 and {"_tag":"SessionNotFoundError","sessionID":<id>} (measured on
// the real `opencode serve`, 2026-11-15). The failed turn names that id in
// sessionNotFound, so the manager can start a new conversation for an
// isolated member (agent-manager recoverGoneMemberSession; the manager's part
// is in server/test-support/member-gone-session.di.test.ts). The member rig
// cannot run OpenCode, so this is the engine's proof.
//
// What each test pins, and the mutant it was seen red on, is named above it.
import { afterEach, describe, expect, it } from "bun:test";
import { OpenCodeTransport } from "./transport.ts";
import {
  FAKE_CWD,
  FAKE_SESSION,
  fakeOpenCode,
  fakeSupervisor,
  type FakeOptions,
} from "./fake-opencode-v2.ts";
import type { NormalizedEvent } from "../types.ts";

type Completion = Extract<NormalizedEvent, { kind: "turn_completed" }>;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(2);
}

// One turn of a transport that resumes FAKE_SESSION: its end.
async function resumedTurn(
  override: FakeOptions["override"],
): Promise<{ end: Completion | undefined; prompts: number }> {
  const fake = fakeOpenCode({ override });
  cleanups.push(fake.restore);
  const lease = fakeSupervisor();
  const transport = new OpenCodeTransport({
    cwd: FAKE_CWD,
    model: "provider/model",
    effort: "high",
    systemPrompt: "system",
    supervisor: lease.supervisor,
    sessionId: FAKE_SESSION,
  });
  cleanups.push(() => transport.close());
  const events: NormalizedEvent[] = [];
  await transport
    .send([{ type: "text", text: "go" }], (event) => events.push(event))
    .catch(() => undefined);
  await until(() => events.some((e) => e.kind === "turn_completed"));
  const end = events.find((e): e is Completion => e.kind === "turn_completed");
  return { end, prompts: fake.prompts() };
}

const ofSession = (url: URL) => url.pathname.includes(`/${FAKE_SESSION}`);

// OpenCode's answer for a session it does not have, as measured.
const notFound = (extra: Record<string, unknown> = {}, status = 404) =>
  Response.json(
    {
      _tag: "SessionNotFoundError",
      sessionID: FAKE_SESSION,
      message: `Session not found: ${FAKE_SESSION}`,
      ...extra,
    },
    { status },
  );

describe("a resumed OpenCode session the server does not have", () => {
  // MUTANTS: fail() does not copy the id to the event; request() does not
  // read the 404's body; the tag not checked (below).
  it("fails the turn before the prompt and names the session", async () => {
    const { end, prompts } = await resumedTurn((_route, { url }) =>
      ofSession(url) ? notFound() : undefined,
    );
    expect(end?.status).toBe("failed");
    expect(end?.sessionNotFound).toBe(FAKE_SESSION);
    expect(prompts).toBe(0);
  });

  // Whatever step meets the 404 first: here the prompt, after every setting
  // took.
  it("names the session when only the prompt meets the 404", async () => {
    const { end } = await resumedTurn((route, { url }) =>
      route === "prompt" && ofSession(url) ? notFound() : undefined,
    );
    expect(end?.status).toBe("failed");
    expect(end?.sessionNotFound).toBe(FAKE_SESSION);
  });

  // The failure the member reads is the one any 404 at that step gives.
  it("keeps the failure text of any other 404", async () => {
    const gone = await resumedTurn((_route, { url }) =>
      ofSession(url) ? notFound() : undefined,
    );
    const other = await resumedTurn((_route, { url }) =>
      ofSession(url)
        ? Response.json({ message: "not found" }, { status: 404 })
        : undefined,
    );
    expect(other.end?.status).toBe("failed");
    expect(other.end?.sessionNotFound).toBeUndefined();
    expect(gone.end?.error).toEqual(other.end?.error);
  });

  // MUTANTS: the tag not checked; the status not checked; no size bound.
  for (const [why, answer] of [
    [
      "another error's 404",
      () =>
        Response.json(
          { _tag: "PermissionNotFoundError", sessionID: FAKE_SESSION },
          { status: 404 },
        ),
    ],
    ["the same body on a 500", () => notFound({}, 500)],
    ["a body over 4 KiB", () => notFound({ padding: "x".repeat(5_000) })],
  ] as const)
    it(`names no session for ${why}`, async () => {
      const { end } = await resumedTurn((_route, { url }) =>
        ofSession(url) ? answer() : undefined,
      );
      // The enabling condition: the turn failed at that answer.
      expect(end?.status).toBe("failed");
      expect(end?.sessionNotFound).toBeUndefined();
    });
});
