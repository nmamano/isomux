// The voice routes' failures as the mic and read aloud show them (task
// 4481e64b). keyMissing and keyRejected send the member to Variables;
// rejected is a request Retry cannot fix; failed is one it may.

export type VoiceFailureKind =
  | "keyMissing"
  | "keyRejected"
  | "tooLarge"
  | "rejected"
  | "failed";

export async function voiceFailureOf(res: Response): Promise<VoiceFailureKind> {
  let error: { code?: unknown; keyRejected?: unknown } | undefined;
  try {
    error = ((await res.json()) as { error?: typeof error }).error;
  } catch {
    error = undefined;
  }
  switch (error?.code) {
    case "voice_key_missing":
      return "keyMissing";
    case "audio_too_large":
      return "tooLarge";
    case "voice_provider_failed":
      return error.keyRejected === true ? "keyRejected" : "failed";
    case "voice_provider_rejected":
    case "unsupported_audio_format":
    case "invalid_request":
    case "invalid_voice":
      return "rejected";
    default:
      return "failed";
  }
}
