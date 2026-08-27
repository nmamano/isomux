import { describe, expect, it } from "bun:test";
import { voiceInputErrorMessage } from "./voice-input-error.ts";

describe("voice input errors", () => {
  it("does not report benign recognition endings as failures", () => {
    expect(voiceInputErrorMessage("no-speech")).toBeNull();
    expect(voiceInputErrorMessage("aborted")).toBeNull();
  });

  it("turns recognition errors into plain guidance", () => {
    expect(voiceInputErrorMessage("not-allowed")).toBe(
      "Voice input is blocked. Check this site's microphone permission in your browser.",
    );
    expect(voiceInputErrorMessage("service-not-allowed")).toBe(
      "Voice input is blocked. Check this site's microphone permission in your browser.",
    );
    expect(voiceInputErrorMessage("audio-capture")).toBe(
      "No microphone was found.",
    );
    expect(voiceInputErrorMessage("network")).toBe(
      "Voice input could not reach the speech service.",
    );
    expect(voiceInputErrorMessage("language-not-supported")).toBe(
      "Voice input failed.",
    );
  });

  it("never puts a raw browser code on screen", () => {
    // Kept separate from the case above, which uses a real Chrome code that
    // someone could later map deliberately. This one cannot be mapped, so the
    // fallback keeps a test whatever else changes.
    expect(voiceInputErrorMessage("not-a-real-speech-error")).toBe(
      "Voice input failed.",
    );
  });
});
