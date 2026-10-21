// splitSpeechChunks (task 4481e64b): a reply longer than one OpenAI speech
// request goes in pieces. Every piece fits, nothing is lost or reordered, and
// a cut falls where a listener would pause.
import { describe, expect, it } from "bun:test";
import { splitSpeechChunks } from "./voice-output.ts";
import { MAX_SPEAK_CHARS } from "../shared/voice.ts";

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function expectLossless(text: string, chunks: string[], max: number) {
  for (const chunk of chunks) {
    expect(chunk.trim().length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(max);
  }
  expect(chunks.join(" ")).toBe(collapse(text));
}

describe("splitSpeechChunks", () => {
  it("keeps a reply that fits in one piece", () => {
    expect(splitSpeechChunks("Short reply.  Two sentences.")).toEqual([
      "Short reply. Two sentences.",
    ]);
  });

  it("gives nothing for empty or blank text", () => {
    expect(splitSpeechChunks("")).toEqual([]);
    expect(splitSpeechChunks("  \n ")).toEqual([]);
  });

  it("cuts at sentence ends when sentences fit", () => {
    const text = "One two three. Four five six! Seven eight nine? Ten.";
    const chunks = splitSpeechChunks(text, 20);
    expectLossless(text, chunks, 20);
    // Every piece but the last ends a sentence.
    for (const chunk of chunks.slice(0, -1)) {
      expect(/[.!?]$/.test(chunk)).toBe(true);
    }
  });

  it("cuts a sentence longer than a piece at a word boundary", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa.";
    const chunks = splitSpeechChunks(text, 16);
    expectLossless(text, chunks, 16);
    const words = new Set(collapse(text).split(" "));
    for (const chunk of chunks) {
      for (const word of chunk.split(" ")) expect(words.has(word)).toBe(true);
    }
  });

  it("hard-cuts a single word longer than a piece", () => {
    const word = "x".repeat(25);
    const chunks = splitSpeechChunks(`Go ${word} now.`, 10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
      expect(chunk.length).toBeGreaterThan(0);
    }
    expect(chunks.join("").replace(/ /g, "")).toBe(`Go${word}now.`);
  });

  it("splits a long reply at the default limit, with few pieces", () => {
    const sentence = "This sentence is part of a long reply. ";
    const text = sentence.repeat(300);
    const chunks = splitSpeechChunks(text);
    expectLossless(text, chunks, MAX_SPEAK_CHARS);
    // Pieces are filled, not one per sentence: each cost is a request.
    expect(chunks.length).toBe(
      Math.ceil(collapse(text).length / MAX_SPEAK_CHARS),
    );
  });
});
