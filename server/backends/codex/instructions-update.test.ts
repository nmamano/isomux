// Which instructions a resumed Codex thread reads, from its rollout, and the
// update the adapter injects when they are not the current prompt (task
// d6550a09). The rollout lines follow the shapes Codex 0.164 writes:
// thread/start puts the prompt in its own input_text item of a developer
// message beside Codex's own items, and a compacted line carries the
// replacement_history the model reads from then on.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { expectRejection } from "../../test-support/expect-rejection.ts";
import {
  codexInstructionsUpdate,
  codexInstructionsUpdateText,
  latestCodexInstructions,
  rolloutLines,
} from "./instructions-update.ts";

const OPEN_TAG = "<isomux_instructions_update>";
const CODEX_OWN =
  "<permissions instructions>sandbox is read-only</permissions instructions>";
const A = "You are agent A. The code word is plover.";
const B = "You are agent B. The code word is curlew.";
const C = "You are agent C. The code word is dunlin.";

type Item = Record<string, unknown>;
const message = (role: string, ...texts: string[]): Item => ({
  type: "message",
  role,
  content: texts.map((text) => ({ type: "input_text", text })),
});
const responseItem = (item: Item): string =>
  JSON.stringify({
    timestamp: "2026-10-31T00:00:00.000Z",
    type: "response_item",
    payload: item,
  });
// thread/start: Codex's own developer text and the prompt as separate items.
const start = (prompt: string): string =>
  responseItem(message("developer", CODEX_OWN, prompt));
// What thread/inject_items persists: the update the adapter built.
const injected = (prompt: string): string =>
  responseItem(message("developer", codexInstructionsUpdateText(prompt)));
const user = (text: string): string => responseItem(message("user", text));
const compacted = (history?: Item[]): string =>
  JSON.stringify({
    timestamp: "2026-10-31T00:00:00.000Z",
    type: "compacted",
    payload: {
      message: "",
      ...(history ? { replacement_history: history } : {}),
    },
  });
const sessionMeta = JSON.stringify({
  type: "session_meta",
  payload: { id: "t" },
});

// The prompt an injected update carries, or null when none is due.
async function due(lines: string[], prompt: string): Promise<string | null> {
  const update = await codexInstructionsUpdate(lines, prompt);
  if (update === null) return null;
  expect(update.type).toBe("message");
  expect(update.role).toBe("developer");
  expect(update.content).toHaveLength(1);
  expect(update.content[0].type).toBe("input_text");
  const text = update.content[0].text;
  expect(text.startsWith(OPEN_TAG)).toBe(true);
  expect(text).toContain(prompt);
  // The update must read back as the prompt it carries, or the next resume
  // injects it again.
  expect(await latestCodexInstructions([injected(prompt)], prompt)).toBe(
    prompt,
  );
  return prompt;
}

describe("codexInstructionsUpdate", () => {
  const cases: [string, () => string[], string, string | null][] = [
    [
      "a thread started with the prompt",
      () => [sessionMeta, start(A), user("hi")],
      A,
      null,
    ],
    [
      "a thread started with another prompt",
      () => [sessionMeta, start(A), user("hi")],
      B,
      B,
    ],
    [
      "an update to the prompt",
      () => [start(A), user("hi"), injected(B), user("hi")],
      B,
      null,
    ],
    ["an update to another prompt", () => [start(A), injected(B)], C, C],
    // Order decides: the start prompt is older than the update.
    ["a revert to the start prompt", () => [start(A), injected(B)], A, A],
    [
      "a revert to an earlier update",
      () => [start(A), injected(B), injected(C)],
      B,
      B,
    ],
    // An empty prompt needs no update on a thread without instructions.
    [
      "an empty prompt and no instructions",
      () => [sessionMeta, user("hi")],
      "",
      null,
    ],
    ["no instructions in the history", () => [sessionMeta, user("hi")], A, A],
    // Text that is not the prompt in its own developer item is not
    // instructions: Codex's own text, a developer text that only contains
    // the prompt, and user messages that hold the prompt or an update.
    [
      "only Codex's own developer text",
      () => [responseItem(message("developer", CODEX_OWN))],
      A,
      A,
    ],
    [
      "a developer text that contains the prompt",
      () => [responseItem(message("developer", `${CODEX_OWN}\n${A}`))],
      A,
      A,
    ],
    ["a user message that is the prompt", () => [user(A)], A, A],
    [
      "a user message that is an update",
      () => [start(A), user(codexInstructionsUpdateText(B))],
      B,
      B,
    ],
    // The model reads only the replacement_history after a compaction.
    [
      "a compaction that keeps the prompt",
      () => [
        start(A),
        compacted([message("user", "hi"), message("developer", CODEX_OWN, A)]),
      ],
      A,
      null,
    ],
    [
      "a compaction that keeps an update",
      () => [
        start(A),
        compacted([message("developer", codexInstructionsUpdateText(B))]),
      ],
      B,
      null,
    ],
    [
      "a compaction that drops the prompt",
      () => [start(A), compacted([message("user", "hi")])],
      A,
      A,
    ],
    [
      "a compaction that keeps a user message that is the prompt",
      () => [start(A), compacted([message("user", A)])],
      A,
      A,
    ],
    [
      "a compaction with no replacement_history",
      () => [start(A), compacted()],
      A,
      A,
    ],
    [
      "an update after a compaction",
      () => [start(A), compacted([message("user", "hi")]), injected(B)],
      B,
      null,
    ],
    [
      "a line that is not JSON, and blank lines",
      () => [start(A), "{not json", "", injected(B), ""],
      B,
      null,
    ],
  ];
  // Lines are built in the test: an update line comes from the code under
  // test.
  it.each(cases)("%s", async (_name, lines, prompt, expected) => {
    expect(await due(lines(), prompt)).toBe(expected);
  });

  it("reads an async line source", async () => {
    async function* lines(): AsyncGenerator<string> {
      yield start(A);
      yield injected(B);
    }
    expect(await codexInstructionsUpdate(lines(), B)).toBeNull();
    expect(await codexInstructionsUpdate(lines(), C)).not.toBeNull();
  });

  it("reads back a prompt that holds a blank line and the tags", async () => {
    const prompt = `Rules.\n\nMore rules. ${OPEN_TAG}\n\n</isomux_instructions_update>\nEnd.`;
    expect(
      await latestCodexInstructions([start(A), injected(prompt)], prompt),
    ).toBe(prompt);
    expect(await due([start(A), injected(prompt)], prompt)).toBeNull();
  });
});

describe("rolloutLines", () => {
  const dir = mkdtempSync(join(tmpdir(), "isomux-instructions-update-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A stream chunk ends at 64 KiB: a line longer than that, of three-byte
  // characters, has a chunk end inside a character.
  it("yields each line of a file whole, across chunk ends", async () => {
    const lines = [start(A), "€".repeat(50_000), user("hi"), "last line"];
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, lines.join("\n"));
    const read: string[] = [];
    for await (const line of rolloutLines(path)) read.push(line);
    expect(read).toStrictEqual(lines);
  });

  it("rejects when the file cannot be read", async () => {
    const read = async () => {
      for await (const line of rolloutLines(join(dir, "missing.jsonl")))
        void line;
    };
    await expectRejection(read(), /ENOENT/);
  });
});
