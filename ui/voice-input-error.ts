const VOICE_INPUT_ERROR_MESSAGES: Record<string, string> = {
  "not-allowed":
    "Voice input is blocked. Check this site's microphone permission in your browser.",
  "service-not-allowed":
    "Voice input is blocked. Check this site's microphone permission in your browser.",
  "audio-capture": "No microphone was found.",
  network: "Voice input could not reach the speech service.",
};

export function voiceInputErrorMessage(code: string): string | null {
  if (code === "no-speech" || code === "aborted") return null;
  return VOICE_INPUT_ERROR_MESSAGES[code] ?? "Voice input failed.";
}
