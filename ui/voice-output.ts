// Read aloud through OpenAI (task 4481e64b): the reply text in pieces the
// speech API takes.

import { MAX_SPEAK_CHARS } from "../shared/voice.ts";

// Sentence boundaries first, then word boundaries, then a hard cut. Every
// chunk is non-empty and at most `max` characters, and pieces are filled as
// far as they go: each one is a request.
export function splitSpeechChunks(
  text: string,
  max: number = MAX_SPEAK_CHARS,
): string[] {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return [];
  // Units no longer than max: whole sentences where they fit, else the
  // sentence's words, with a word over max cut into max-sized parts.
  const units: string[] = [];
  for (const sentence of collapsed.split(/(?<=[.!?])\s+/)) {
    if (sentence.length <= max) {
      units.push(sentence);
      continue;
    }
    for (const word of sentence.split(" ")) {
      for (let i = 0; i < word.length; i += max) {
        units.push(word.slice(i, i + max));
      }
    }
  }
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) current = unit;
    else if (current.length + 1 + unit.length <= max) current += " " + unit;
    else {
      chunks.push(current);
      current = unit;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
