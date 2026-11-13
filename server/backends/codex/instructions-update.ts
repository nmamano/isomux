// Codex writes a thread's developer instructions into its history once, at
// thread/start. thread/resume accepts developerInstructions but does not put
// them in the history (Codex 0.164), so a resumed agent kept the prompt its
// thread began with (task d6550a09). After a resume, the adapter appends the
// current prompt as a developer message (thread/inject_items) when the
// thread's latest instructions differ from it.

import { createReadStream } from "fs";
import { StringDecoder } from "string_decoder";

export interface CodexDeveloperMessage {
  type: "message";
  role: "developer";
  content: { type: "input_text"; text: string }[];
}

const OPEN_TAG = "<isomux_instructions_update>";
const CLOSE_TAG = "</isomux_instructions_update>";

// The text of an instructions update: the tag, one line for the model, a
// blank line, the prompt, the closing tag. Only the tags and the blank line
// are read back, so the line for the model can change.
export function codexInstructionsUpdateText(systemPrompt: string): string {
  return (
    `${OPEN_TAG}\n` +
    "Your Isomux instructions changed. These replace the earlier ones.\n\n" +
    `${systemPrompt}\n${CLOSE_TAG}`
  );
}

function updateBody(text: string): string | null {
  if (!text.startsWith(`${OPEN_TAG}\n`) || !text.endsWith(`\n${CLOSE_TAG}`))
    return null;
  const start = text.indexOf("\n\n");
  const end = text.length - CLOSE_TAG.length - 1;
  return start === -1 || start + 2 > end ? null : text.slice(start + 2, end);
}

// The instructions a thread reads last, from the lines of its rollout
// (JSONL): the body of the latest update, or the prompt itself where its
// text stands alone in a developer message (thread/start writes it so,
// beside Codex's own items, which are not instructions). A compaction
// replaces the history the model reads with its replacement_history, so the
// scan starts over there; Codex keeps the prompt as its own item in it. A
// compaction without the prompt in its history makes the next resume inject
// once. null when nothing the model reads carries the prompt or an update.
export async function latestCodexInstructions(
  lines: Iterable<string> | AsyncIterable<string>,
  systemPrompt: string,
): Promise<string | null> {
  let latest: string | null = null;
  const read = (item: unknown): void => {
    const message = item as
      { type?: unknown; role?: unknown; content?: unknown } | null | undefined;
    if (
      message?.type !== "message" ||
      message.role !== "developer" ||
      !Array.isArray(message.content)
    )
      return;
    for (const part of message.content as ({ text?: unknown } | null)[]) {
      if (typeof part?.text !== "string") continue;
      if (part.text === systemPrompt) latest = systemPrompt;
      else {
        const body = updateBody(part.text);
        if (body !== null) latest = body;
      }
    }
  };
  for await (const line of lines) {
    // Most lines are neither: skip them before JSON.parse.
    if (!line.includes('"developer"') && !line.includes('"compacted"'))
      continue;
    let entry: { type?: unknown; payload?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry?.type === "response_item") read(entry.payload);
    else if (entry?.type === "compacted") {
      latest = null;
      const history = (entry.payload as { replacement_history?: unknown })
        ?.replacement_history;
      if (Array.isArray(history)) history.forEach(read);
    }
  }
  return latest;
}

// The developer message to inject after a resume, or null when the thread
// already reads systemPrompt.
export async function codexInstructionsUpdate(
  lines: Iterable<string> | AsyncIterable<string>,
  systemPrompt: string,
): Promise<CodexDeveloperMessage | null> {
  if (
    ((await latestCodexInstructions(lines, systemPrompt)) ?? "") ===
    systemPrompt
  )
    return null;
  return {
    type: "message",
    role: "developer",
    content: [
      { type: "input_text", text: codexInstructionsUpdateText(systemPrompt) },
    ],
  };
}

// The lines of a rollout file, read as a stream: rollouts reach tens of MB,
// and a boot resumes many agents at once. A read error rejects the
// iteration.
export async function* rolloutLines(path: string): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of createReadStream(path)) {
    const parts = (pending + decoder.write(chunk as Buffer)).split("\n");
    pending = parts.pop() ?? "";
    yield* parts;
  }
  pending += decoder.end();
  if (pending) yield pending;
}
