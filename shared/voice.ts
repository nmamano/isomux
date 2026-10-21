// Voice input through OpenAI (task 4481e64b): what the mic uses, the limits
// the recorder and the transcribe route share, and the route wire shapes.
// Browser stays the default. With "openai", the browser records a clip and the
// office server sends it to OpenAI with the member's OPENAI_VOICE_API_KEY,
// falling back as server/voice-key.ts says (server/routes/handlers/voice.ts).

import type { EnvVariableSource } from "./types.ts";

export const VOICE_INPUTS = ["browser", "openai"] as const;
export type VoiceInput = (typeof VOICE_INPUTS)[number];

export function isVoiceInput(value: unknown): value is VoiceInput {
  return (VOICE_INPUTS as readonly unknown[]).includes(value);
}

// OpenAI's file limit for /v1/audio/transcriptions.
export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;

// The recorder stops itself here and transcribes what it has. OpenAI's docs
// name no duration cap (2026-10-21), but its transcribe models were reported
// to refuse clips over 1400 s, so this stays under that.
export const VOICE_MAX_RECORDING_MS = 20 * 60 * 1000;

// The file types OpenAI's speech-to-text guide lists (2026-10-21). OpenAI
// reads the type from the file name, so the route forwards only these.
export const VOICE_AUDIO_EXTENSIONS = [
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "wav",
  "webm",
] as const;

export const VOICE_TRANSCRIBE_MODEL = "gpt-transcribe";

// The variable the voice routes spend. OPENAI_API_KEY counts only when it is
// set anyway: setting it makes Codex agents sign in with it (Nil,
// 2026-10-21), so the Voice tab asks for the voice key only.
export const VOICE_KEY_NAME = "OPENAI_VOICE_API_KEY";
export const FALLBACK_VOICE_KEY_NAME = "OPENAI_API_KEY";
export type VoiceKeyName =
  | typeof VOICE_KEY_NAME
  | typeof FALLBACK_VOICE_KEY_NAME;

// GET /api/voice (voice.status). Which variable holds the caller's key and
// where it comes from, both null when none is set. A secret source is
// reported as such: the voice routes cannot use a secret's value.
export interface VoiceStatusRes {
  keySource: EnvVariableSource | null;
  keyName: VoiceKeyName | null;
}

// POST /api/voice/transcribe (voice.transcribe).
export interface VoiceTranscribeRes {
  text: string;
}

// Read aloud through OpenAI. OpenAI shuts the speech API down on 2027-01-06
// (its deprecations page, 2026-10-21); after that every call fails and the
// read-aloud error offers the browser voices.
export const VOICE_OUTPUTS = ["browser", "openai"] as const;
export type VoiceOutput = (typeof VOICE_OUTPUTS)[number];

export function isVoiceOutput(value: unknown): value is VoiceOutput {
  return (VOICE_OUTPUTS as readonly unknown[]).includes(value);
}

// OpenAI's built-in voices (text-to-speech guide, 2026-10-21). The UI shows
// the names as they are.
export const VOICE_NAMES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
export type VoiceName = (typeof VOICE_NAMES)[number];

export function isVoiceName(value: unknown): value is VoiceName {
  return (VOICE_NAMES as readonly unknown[]).includes(value);
}

// The guide recommends marin or cedar.
export const DEFAULT_VOICE_NAME: VoiceName = "marin";

export const VOICE_SPEAK_MODEL = "gpt-4o-mini-tts";

// OpenAI's input limit per speech request.
export const MAX_SPEAK_CHARS = 4096;

// POST /api/voice/speak (voice.speak); the answer is audio/mpeg bytes.
export interface VoiceSpeakReq {
  text: string;
  voice?: VoiceName;
}
