// File mentions, live tier (ISOMUX_TEST_LIVE=1), task 300166c2: what the real
// Claude Code process reads into a turn by itself. Isomux defuses each file
// mention in prompt text a member did not type (defuseFileMentions); that
// rests on the CLI's own mention scan, which an SDK upgrade can change. The
// unit tests run claudeFileMentions (server/test-support/claude-file-mentions.ts)
// over what Isomux sends; this checks that rule against the CLI.
//
// No model is called: the API base URL is a local server that records each
// request and refuses it, so the request body shows every file the CLI read
// into the turn. The session runs in a temporary home with a fake key.
//
// The control: each raw shape puts its canary file in the request. Then the
// same prompt, defused, puts none there; nor does a mention in the system
// prompt, which carries the office's memory lines.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClaudeBackend, realV1SdkClient } from "./claude.ts";
import { defuseFileMentions } from "../../shared/identity.ts";
import { LIVE } from "../test-support/live-gate.ts";
import {
  MENTION_SHAPES,
  claudeFileMentions,
} from "../test-support/claude-file-mentions.ts";

// Shapes that name a file. An MCP resource and a subagent read no file, and
// the doubled at-sign names a path that starts with "@".
const FILE_SHAPES = Object.entries(MENTION_SHAPES).filter(
  ([shape]) =>
    !["an MCP resource", "a subagent", "a doubled at-sign"].includes(shape),
);

let root: string;
let home: string;
let cwd: string;
let server: ReturnType<typeof Bun.serve> | undefined;
const requests: string[] = [];

// One canary per shape: the shape's text with its path moved under `root`,
// and the file's content.
const canaries: { shape: string; text: string; secret: string }[] = [];
let systemCanary: { path: string; secret: string };

beforeAll(() => {
  if (!LIVE) return;
  root = mkdtempSync(join(tmpdir(), "claude-mentions-live-"));
  home = join(root, "home");
  cwd = join(root, "folder");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(root, "canary"), { recursive: true });
  for (const [i, [shape, raw]] of FILE_SHAPES.entries()) {
    const secret = `CANARY${i}x${Math.random().toString(36).slice(2, 10)}`;
    const text = raw.replaceAll("/srv/canary/", `${root}/canary/`);
    const [mention] = claudeFileMentions(text);
    const named = mention.slice(1).replace(/^"|"$/g, "");
    const path = named.startsWith("/") ? named : join(cwd, named);
    writeFileSync(path, `${secret}\n`);
    canaries.push({ shape, text, secret });
  }
  systemCanary = {
    path: join(root, "canary", "system.txt"),
    secret: `SYSCANARY${Math.random().toString(36).slice(2, 10)}`,
  };
  writeFileSync(systemCanary.path, `${systemCanary.secret}\n`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push(await req.text());
      return Response.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "recorded" },
        },
        { status: 400 },
      );
    },
  });
});

afterAll(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

// Runs one turn with `prompt` and returns every request body the CLI sent.
async function requestsFor(prompt: string): Promise<string> {
  const from = requests.length;
  const session = createClaudeBackend(realV1SdkClient).createSession({
    agentId: "mentions-live",
    cwd,
    systemPrompt: `Office memory: see @${systemCanary.path} for notes.`,
    modelFamily: "haiku",
    effort: "low",
    permissionMode: "default",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_API_KEY: "sk-ant-api03-FAKEFAKEFAKEFAKEFAKE-mentions-live",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server!.port}`,
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  });
  const done = (async () => {
    try {
      for await (const ev of session.stream())
        if (ev.kind === "turn_completed" || ev.kind === "error") return;
    } catch {}
  })();
  try {
    await session.send(prompt);
    await Promise.race([
      done,
      Bun.sleep(60_000).then(() => {
        throw new Error("the turn did not end");
      }),
    ]);
  } finally {
    session.close();
    await done;
  }
  const bodies = requests.slice(from).join("\n");
  // The enabling condition: the CLI sent the prompt to the recorder.
  expect(bodies).toContain("CANARY-PROMPT-SENT");
  return bodies;
}

const promptOf = (texts: string[]) =>
  `CANARY-PROMPT-SENT. Reply OK.\n${texts.join("\n")}`;

describe.skipIf(!LIVE)("Claude Code file mentions, live", () => {
  test("each raw shape reads its file into the turn", async () => {
    const bodies = await requestsFor(promptOf(canaries.map((c) => c.text)));
    const missing = canaries
      .filter((c) => !bodies.includes(c.secret))
      .map((c) => c.shape);
    expect(missing).toEqual([]);
    // A mention in the system prompt reads nothing.
    expect(bodies.includes(systemCanary.secret)).toBe(false);
  }, 90_000);

  test("the same prompt, defused, reads no file", async () => {
    const bodies = await requestsFor(
      defuseFileMentions(promptOf(canaries.map((c) => c.text))),
    );
    const read = canaries
      .filter((c) => bodies.includes(c.secret))
      .map((c) => c.shape);
    expect(read).toEqual([]);
    expect(bodies.includes(systemCanary.secret)).toBe(false);
  }, 90_000);
});
