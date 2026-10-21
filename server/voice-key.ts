// The OpenAI key that voice input and read aloud spend (task 4481e64b).
// OPENAI_VOICE_API_KEY first, then OPENAI_API_KEY, each read from the merged
// env the caller's agents get (buildEnvForUserId: member over office over the
// server's own env). The first name that is set decides. An unowned caller
// (userId null) gets the office and server layers, as its agents do. A secret
// source has no usable value here: the env holds the proxy's placeholder,
// which only the secret proxy swaps.

import type { EnvVariableSource } from "../shared/types.ts";
import {
  FALLBACK_VOICE_KEY_NAME,
  VOICE_KEY_NAME,
  type VoiceKeyName,
} from "../shared/voice.ts";
import { getAgentHost } from "./agent-host.ts";
import { buildEnvForUserId, envSourceForUserId } from "./env-loader.ts";

export interface VoiceKey {
  name: VoiceKeyName;
  source: EnvVariableSource;
  // Null when the source is a secret.
  key: string | null;
}

export function voiceKeyForUserId(
  userId: string | null | undefined,
): VoiceKey | null {
  const env = buildEnvForUserId(userId) ?? getAgentHost().baseEnv();
  for (const name of [VOICE_KEY_NAME, FALLBACK_VOICE_KEY_NAME] as const) {
    const value = env[name];
    if (!value) continue;
    const source = envSourceForUserId(userId, name) ?? "server";
    const secret = source === "member_secret" || source === "office_secret";
    return { name, source, key: secret ? null : value };
  }
  return null;
}
