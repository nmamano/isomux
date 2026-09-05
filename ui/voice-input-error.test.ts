import { describe, expect, it } from "bun:test";
import { voiceInputErrorMessage } from "./voice-input-error.ts";
import { translatorFor } from "../shared/i18n/translate.ts";

// The catalog's English: the same messages the box showed before they moved
// into the catalog (ruling 6).
const EN = translatorFor("en");

describe("voice input errors", () => {
  it("does not report benign recognition endings as failures", () => {
    expect(voiceInputErrorMessage(EN, "no-speech")).toBeNull();
    expect(voiceInputErrorMessage(EN, "aborted")).toBeNull();
  });

  it("maps recognized failures instead of collapsing them to the fallback", () => {
    const fallback = voiceInputErrorMessage(EN, "not-a-real-speech-error");
    const permission = voiceInputErrorMessage(EN, "not-allowed");
    const servicePermission = voiceInputErrorMessage(EN, "service-not-allowed");
    const capture = voiceInputErrorMessage(EN, "audio-capture");
    const network = voiceInputErrorMessage(EN, "network");

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
    expect(voiceInputErrorMessage(EN, "not-a-real-speech-error")).not.toContain(
      "not-a-real-speech-error",
    );
  });
});
