import { describe, expect, it } from "bun:test";
import { voiceInputErrorMessage } from "./voice-input-error.ts";

describe("voice input errors", () => {
  it("does not report benign recognition endings as failures", () => {
    expect(voiceInputErrorMessage("no-speech")).toBeNull();
    expect(voiceInputErrorMessage("aborted")).toBeNull();
  });

  it("maps recognized failures instead of collapsing them to the fallback", () => {
    const fallback = voiceInputErrorMessage("not-a-real-speech-error");
    const permission = voiceInputErrorMessage("not-allowed");
    const servicePermission = voiceInputErrorMessage("service-not-allowed");
    const capture = voiceInputErrorMessage("audio-capture");
    const network = voiceInputErrorMessage("network");

    for (const message of [permission, servicePermission, capture, network]) {
      expect(message).not.toBeNull();
      expect(message).not.toBe(fallback);
    }
    expect(permission).toBe(servicePermission);
    expect(capture).not.toBe(network);
  });

  it("never puts a raw browser code on screen", () => {
    // Kept separate from the case above, which uses a real Chrome code that
    // someone could later map deliberately. This one cannot be mapped, so the
    // fallback keeps a test whatever else changes.
    expect(voiceInputErrorMessage("not-a-real-speech-error")).not.toContain(
      "not-a-real-speech-error",
    );
  });
});
