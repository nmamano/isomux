// Voice handlers (opIds voice.status, voice.transcribe, voice.speak), task
// 4481e64b. voice.transcribe sends a recorded clip to OpenAI with the caller's
// OpenAI key (server/voice-key.ts) and returns the text; voice.speak sends
// reply text and returns OpenAI's mp3. The key never leaves the server, and no
// response or log line carries OpenAI's error body (its 401 message quotes the
// key it refused).
//
// The caller's user is whose key is spent: a member's own, an agent's
// manager's (identity.userId). Every refusal that a call cannot get past comes
// before OpenAI is reached.

import { bytes, fail, ok, type RouteHandler } from "../executor.ts";
import type { VoiceKey } from "../../voice-key.ts";
import {
  DEFAULT_VOICE_NAME,
  isVoiceName,
  MAX_SPEAK_CHARS,
  MAX_VOICE_AUDIO_BYTES,
  VOICE_AUDIO_EXTENSIONS,
  VOICE_SPEAK_MODEL,
  VOICE_TRANSCRIBE_MODEL,
  VOICE_KEY_NAME,
  type VoiceStatusRes,
  type VoiceTranscribeRes,
} from "../../../shared/voice.ts";

const OPENAI_API = "https://api.openai.com/v1";
// A 20-minute clip is the longest the recorder makes (VOICE_MAX_RECORDING_MS).
const OPENAI_TIMEOUT_MS = 120_000;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD_CHARS = 100;

export interface VoiceDeps {
  keyFor(userId: string | null): VoiceKey | null;
  // OpenAI is reached only through this, so tests stub it.
  fetch(url: string, init: RequestInit): Promise<Response>;
}

type Ctx = Parameters<RouteHandler>[0];

function usableKey(deps: VoiceDeps, ctx: Ctx): string | null {
  return deps.keyFor(ctx.identity.userId)?.key ?? null;
}

const keyMissing = () =>
  fail(
    409,
    "voice_key_missing",
    `Set ${VOICE_KEY_NAME} as a variable in Integrations > Variables.`,
  );

// OpenAI's answer, or the error result for it. Only the HTTP status crosses:
// a 401 is a refused key, which the member fixes in Variables; another 4xx is
// a request Retry cannot fix (bad audio, a retired model); the rest is an
// outage or a rate limit, which Retry can.
async function callOpenAI(
  deps: VoiceDeps,
  path: string,
  key: string,
  init: { body: BodyInit; contentType?: string },
): Promise<Response | ReturnType<typeof fail>> {
  let res: Response;
  try {
    res = await deps.fetch(`${OPENAI_API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init.contentType ? { "Content-Type": init.contentType } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
  } catch {
    console.error(`[voice] OpenAI ${path} could not be reached`);
    return fail(502, "voice_provider_failed", "OpenAI could not be reached.");
  }
  if (res.ok) return res;
  // Drain without reading it into a log line.
  await res.body?.cancel().catch(() => {});
  const status = res.status;
  console.error(`[voice] OpenAI ${path} answered ${status}`);
  if (status === 401) {
    return fail(502, "voice_provider_failed", "OpenAI refused the key.", {
      status,
      keyRejected: true,
    });
  }
  if (status >= 400 && status < 500 && status !== 429) {
    return fail(502, "voice_provider_rejected", "OpenAI refused the request.", {
      status,
    });
  }
  return fail(502, "voice_provider_failed", "OpenAI did not answer.", {
    status,
  });
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function keywordsOf(form: FormData): string[] {
  return form
    .getAll("keywords")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value && value.length <= MAX_KEYWORD_CHARS)
    .slice(0, MAX_KEYWORDS);
}

export function voiceHandlers(deps: VoiceDeps): Record<string, RouteHandler> {
  return {
    "voice.status": (ctx) => {
      const found = deps.keyFor(ctx.identity.userId);
      return ok({
        keySource: found?.source ?? null,
        keyName: found?.name ?? null,
      } satisfies VoiceStatusRes);
    },

    "voice.transcribe": async (ctx) => {
      let form: FormData;
      try {
        form = await ctx.req.formData();
      } catch {
        return fail(422, "invalid_request", "send the audio as form data");
      }
      const audio = form.get("audio");
      if (!(audio instanceof File)) {
        return fail(422, "invalid_request", "audio is required");
      }
      if (audio.size > MAX_VOICE_AUDIO_BYTES) {
        return fail(413, "audio_too_large", "audio is over 25 MB");
      }
      const extension = extensionOf(audio.name);
      if (!(VOICE_AUDIO_EXTENSIONS as readonly string[]).includes(extension)) {
        return fail(
          422,
          "unsupported_audio_format",
          `audio must be one of: ${VOICE_AUDIO_EXTENSIONS.join(", ")}`,
        );
      }
      const key = usableKey(deps, ctx);
      if (!key) return keyMissing();

      const outbound = new FormData();
      outbound.append("model", VOICE_TRANSCRIBE_MODEL);
      outbound.append("file", audio, audio.name);
      const language = form.get("language");
      if (typeof language === "string" && language.trim()) {
        const base = (language.trim().split(/[-_]/)[0] ?? "").toLowerCase();
        if (base) outbound.append("languages[]", base);
      }
      for (const keyword of keywordsOf(form)) {
        outbound.append("keywords[]", keyword);
      }
      const res = await callOpenAI(deps, "/audio/transcriptions", key, {
        body: outbound,
      });
      if (!(res instanceof Response)) return res;
      let text: unknown;
      try {
        text = ((await res.json()) as { text?: unknown }).text;
      } catch {
        text = undefined;
      }
      if (typeof text !== "string") {
        console.error("[voice] OpenAI transcription had no text");
        return fail(502, "voice_provider_failed", "OpenAI sent no text.");
      }
      return ok({ text } satisfies VoiceTranscribeRes);
    },

    "voice.speak": async (ctx) => {
      const body = ctx.body as { text?: unknown; voice?: unknown } | undefined;
      const text = body?.text;
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > MAX_SPEAK_CHARS
      ) {
        return fail(
          422,
          "invalid_request",
          `text must be 1 to ${MAX_SPEAK_CHARS} characters`,
        );
      }
      const voice = body?.voice ?? DEFAULT_VOICE_NAME;
      if (!isVoiceName(voice)) {
        return fail(422, "invalid_voice", "voice is not an OpenAI voice");
      }
      const key = usableKey(deps, ctx);
      if (!key) return keyMissing();

      const res = await callOpenAI(deps, "/audio/speech", key, {
        contentType: "application/json",
        body: JSON.stringify({
          model: VOICE_SPEAK_MODEL,
          input: text,
          voice,
          response_format: "mp3",
        }),
      });
      if (!(res instanceof Response)) return res;
      let audio: Uint8Array<ArrayBuffer>;
      try {
        audio = new Uint8Array(await res.arrayBuffer());
      } catch {
        console.error("[voice] OpenAI speech could not be read");
        return fail(502, "voice_provider_failed", "OpenAI sent no audio.");
      }
      return bytes(audio, "audio/mpeg");
    },
  };
}
