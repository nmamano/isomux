// Voice input helpers for the composer mic (task 4481e64b).

import type { VoiceInput } from "../shared/voice.ts";

// Recorder types in order of preference, with the file extension OpenAI reads
// each one's format from.
const RECORDER_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
];

// The MediaRecorder type for an OpenAI clip: webm first (Chrome, Firefox,
// Edge), then mp4 (Safari). Null when neither records here.
export function pickRecorderMimeType(
  isTypeSupported: (type: string) => boolean,
): string | null {
  for (const [type] of RECORDER_TYPES) {
    if (isTypeSupported(type)) return type;
  }
  return null;
}

// The file extension OpenAI reads the clip's type from.
export function audioExtensionFor(mimeType: string): string {
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return RECORDER_TYPES.find(([type]) => type === base)?.[1] ?? "webm";
}

// Whether the composer shows a working mic. Both sources need a secure
// context; OpenAI needs a recorder type, the browser its recognizer.
export function micAvailable(opts: {
  speechRecognition: boolean;
  voiceInput: VoiceInput;
  secureContext: boolean;
  recorderMimeType: string | null;
}): boolean {
  if (!opts.secureContext) return false;
  return opts.voiceInput === "openai"
    ? opts.recorderMimeType !== null
    : opts.speechRecognition;
}
