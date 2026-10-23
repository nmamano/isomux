// voice.* handlers (task 4481e64b): the transcribe route sends the clip to
// OpenAI with the caller's user's key, refuses before any OpenAI call when it
// cannot succeed, and never lets the key or OpenAI's error body reach a
// response or a log line. OpenAI is the injected fetch.

import { afterEach, describe, expect, it } from "bun:test";
import { voiceHandlers, type VoiceDeps } from "./voice.ts";
import type { RouteHandlerContext } from "../executor.ts";
import {
  AGENT_CAPABILITIES,
  USER_CAPABILITIES,
  type Identity,
} from "../../identity/index.ts";
import type { VoiceKey } from "../../voice-key.ts";
import {
  DEFAULT_VOICE_NAME,
  MAX_SPEAK_CHARS,
  MAX_VOICE_AUDIO_BYTES,
  VOICE_SPEAK_MODEL,
  VOICE_TRANSCRIBE_MODEL,
} from "../../../shared/voice.ts";

const KEY = "sk-proj-VoIcEtEsTkEy4481e64b";
const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";

const member: Identity = {
  scope: "user",
  userId: "u-member",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

function ctx(
  identity: Identity,
  req: Request,
  body: unknown = undefined,
): RouteHandlerContext {
  return {
    identity,
    params: {},
    body,
    rawBody: "",
    query: new URLSearchParams(),
    req,
  };
}

function transcribeReq(fields: {
  audio?: File;
  language?: string;
  keywords?: string[];
}): Request {
  const form = new FormData();
  if (fields.audio) form.append("audio", fields.audio);
  if (fields.language !== undefined) form.append("language", fields.language);
  for (const k of fields.keywords ?? []) form.append("keywords", k);
  return new Request("http://localhost/api/voice/transcribe", {
    method: "POST",
    body: form,
  });
}

const clip = (name = "clip.webm", bytes = new Uint8Array([1, 2, 3, 4])) =>
  new File([bytes], name, { type: "audio/webm" });

interface Call {
  url: string;
  init: RequestInit;
}

function setup(opts: {
  key?: VoiceKey | null;
  reply?: () => Promise<Response>;
}) {
  const calls: Call[] = [];
  const keyCalls: (string | null)[] = [];
  const deps: VoiceDeps = {
    keyFor: (userId) => {
      keyCalls.push(userId);
      return opts.key === undefined
        ? { name: "OPENAI_VOICE_API_KEY", source: "member_variable", key: KEY }
        : opts.key;
    },
    fetch: (url, init) => {
      calls.push({ url, init });
      return opts.reply
        ? opts.reply()
        : Promise.resolve(Response.json({ text: "Hello there." }));
    },
  };
  return { handlers: voiceHandlers(deps), calls, keyCalls };
}

let restoreConsole: (() => void) | null = null;
afterEach(() => {
  restoreConsole?.();
  restoreConsole = null;
});

// Every console line a handler writes, so a test can say none carries the key.
function captureConsole(): string[] {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  }
  restoreConsole = () => methods.forEach((m, i) => (console[m] = originals[i]));
  return lines;
}

async function forwardedForm(call: Call): Promise<FormData> {
  expect(call.init.body).toBeInstanceOf(FormData);
  return call.init.body as FormData;
}

describe("voice.transcribe: refusals before OpenAI", () => {
  it("answers 409 voice_key_missing with no key, or with a secret source", async () => {
    for (const key of [
      null,
      { name: "OPENAI_VOICE_API_KEY", source: "member_secret", key: null },
      { name: "OPENAI_VOICE_API_KEY", source: "office_secret", key: null },
    ] as const) {
      const { handlers, calls } = setup({ key });
      const res = await handlers["voice.transcribe"](
        ctx(member, transcribeReq({ audio: clip() })),
      );
      expect({ key, res }).toMatchObject({
        key,
        res: { kind: "error", status: 409, code: "voice_key_missing" },
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("answers 422 with no audio file", async () => {
    const { handlers, calls } = setup({});
    const res = await handlers["voice.transcribe"](
      ctx(member, transcribeReq({ language: "en" })),
    );
    expect(res).toMatchObject({
      kind: "error",
      status: 422,
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });

  it("answers 413 audio_too_large over OpenAI's file limit, and takes one exactly at it", async () => {
    const over = setup({});
    const res = await over.handlers["voice.transcribe"](
      ctx(
        member,
        transcribeReq({
          audio: clip("long.webm", new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1)),
        }),
      ),
    );
    expect(res).toMatchObject({
      kind: "error",
      status: 413,
      code: "audio_too_large",
    });
    expect(over.calls).toHaveLength(0);

    const atLimit = setup({});
    const okRes = await atLimit.handlers["voice.transcribe"](
      ctx(
        member,
        transcribeReq({
          audio: clip("long.webm", new Uint8Array(MAX_VOICE_AUDIO_BYTES)),
        }),
      ),
    );
    expect(okRes).toMatchObject({ kind: "json" });
    expect(atLimit.calls).toHaveLength(1);
  });

  // OpenAI reads the format from the file name, so a name it does not list
  // would come back as a provider 400 the member cannot fix by retrying.
  it("answers 422 unsupported_audio_format for a name OpenAI does not read", async () => {
    for (const name of ["clip.ogg", "clip", "clip.webm.exe"]) {
      const { handlers, calls } = setup({});
      const res = await handlers["voice.transcribe"](
        ctx(member, transcribeReq({ audio: clip(name) })),
      );
      expect({ name, res }).toMatchObject({
        name,
        res: { kind: "error", status: 422, code: "unsupported_audio_format" },
      });
      expect(calls).toHaveLength(0);
    }
  });
});

describe("voice.transcribe: the OpenAI call", () => {
  it("sends the clip with the caller's key, model, language and keywords, and returns the text", async () => {
    const { handlers, calls, keyCalls } = setup({});
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const res = await handlers["voice.transcribe"](
      ctx(
        member,
        transcribeReq({
          audio: clip("dictation.mp4", bytes),
          language: "es-ES",
          keywords: [" Isomux Main ", "Reviewer 2"],
        }),
      ),
    );
    expect(res).toMatchObject({ kind: "json", body: { text: "Hello there." } });
    expect(keyCalls).toEqual(["u-member"]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(OPENAI_URL);
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("authorization")).toBe(
      `Bearer ${KEY}`,
    );
    const form = await forwardedForm(call);
    expect(form.get("model")).toBe(VOICE_TRANSCRIBE_MODEL);
    expect(form.getAll("languages[]")).toEqual(["es"]);
    expect(form.getAll("keywords[]")).toEqual(["Isomux Main", "Reviewer 2"]);
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("dictation.mp4");
    expect([...new Uint8Array(await (file as File).arrayBuffer())]).toEqual([
      ...bytes,
    ]);
  });

  it("sends no language when none is given, and the lowercased base of one", async () => {
    const none = setup({});
    await none.handlers["voice.transcribe"](
      ctx(member, transcribeReq({ audio: clip() })),
    );
    expect((await forwardedForm(none.calls[0])).getAll("languages[]")).toEqual(
      [],
    );

    const upper = setup({});
    await upper.handlers["voice.transcribe"](
      ctx(member, transcribeReq({ audio: clip(), language: "ZH-Hans-CN" })),
    );
    expect((await forwardedForm(upper.calls[0])).getAll("languages[]")).toEqual(
      ["zh"],
    );
  });

  it("keeps at most 50 keywords and drops blank and over-long ones", async () => {
    const { handlers, calls } = setup({});
    const many = Array.from({ length: 60 }, (_, i) => `Agent ${i}`);
    await handlers["voice.transcribe"](
      ctx(
        member,
        transcribeReq({
          audio: clip(),
          keywords: ["   ", "x".repeat(101), "y".repeat(100), ...many],
        }),
      ),
    );
    const sent = (await forwardedForm(calls[0])).getAll("keywords[]");
    expect(sent).toHaveLength(50);
    expect(sent[0]).toBe("y".repeat(100));
    expect(sent).not.toContain("x".repeat(101));
    expect(sent).not.toContain("");
  });

  // An agent's call spends its manager's key: identity.userId is the manager.
  it("spends the agent's manager's key", async () => {
    const { handlers, keyCalls, calls } = setup({});
    const agent: Identity = {
      scope: "agent",
      userId: "u-manager",
      agentId: "a-1",
      role: "member",
      capabilities: AGENT_CAPABILITIES,
    };
    const res = await handlers["voice.transcribe"](
      ctx(agent, transcribeReq({ audio: clip() })),
    );
    expect(res).toMatchObject({ kind: "json" });
    expect(keyCalls).toEqual(["u-manager"]);
    expect(calls).toHaveLength(1);
  });
});

// Both routes share one OpenAI failure mapping: voice.speak below owns its
// table; this case proves the mic answers through it.
describe("voice.transcribe: OpenAI failures", () => {
  // OpenAI's 401 message quotes part of the key it refused.
  const echo = `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`;
  const openAiError = (status: number) => () =>
    Promise.resolve(
      Response.json(
        { error: { message: echo, type: "invalid_request_error" } },
        { status },
      ),
    );

  it("a refused key is 502 voice_provider_failed with keyRejected, and neither key nor body leaks", async () => {
    const lines = captureConsole();
    const { handlers } = setup({ reply: openAiError(401) });
    const res = await handlers["voice.transcribe"](
      ctx(member, transcribeReq({ audio: clip() })),
    );
    expect(res).toMatchObject({
      kind: "error",
      status: 502,
      code: "voice_provider_failed",
      detail: { status: 401, keyRejected: true },
    });
    const everything = JSON.stringify(res) + "\n" + lines.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("Incorrect API key");
  });
});

describe("voice.status", () => {
  it("names where the caller's key comes from, never a value", async () => {
    for (const [key, keySource, keyName] of [
      [
        { name: "OPENAI_VOICE_API_KEY", source: "member_variable", key: KEY },
        "member_variable",
        "OPENAI_VOICE_API_KEY",
      ],
      [
        { name: "OPENAI_API_KEY", source: "server", key: KEY },
        "server",
        "OPENAI_API_KEY",
      ],
      [
        { name: "OPENAI_VOICE_API_KEY", source: "member_secret", key: null },
        "member_secret",
        "OPENAI_VOICE_API_KEY",
      ],
      [null, null, null],
    ] as const) {
      const { handlers, calls, keyCalls } = setup({ key });
      const res = await handlers["voice.status"](
        ctx(member, new Request("http://localhost/api/voice")),
      );
      expect(res).toEqual({ kind: "json", body: { keySource, keyName } });
      expect(JSON.stringify(res)).not.toContain(KEY);
      expect(keyCalls).toEqual(["u-member"]);
      expect(calls).toHaveLength(0);
    }
  });
});

// Read aloud (voice.speak): text in, OpenAI's mp3 out, with the same key rules
// and the same failure mapping as the mic. After OpenAI retires the speech
// model its 4xx lands on voice_provider_rejected, which the UI answers with
// the browser voices.
describe("voice.speak", () => {
  const SPEAK_URL = "https://api.openai.com/v1/audio/speech";
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 5, 6]);
  const speakReq = () =>
    new Request("http://localhost/api/voice/speak", { method: "POST" });
  const speak = (
    handlers: ReturnType<typeof voiceHandlers>,
    body: unknown,
    identity: Identity = member,
  ) => handlers["voice.speak"](ctx(identity, speakReq(), body));
  const audioReply = () =>
    Promise.resolve(
      new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } }),
    );

  it("sends the text, voice and model with the caller's key, and returns the audio bytes", async () => {
    const { handlers, calls, keyCalls } = setup({ reply: audioReply });
    const res = await speak(handlers, { text: "Read this.", voice: "cedar" });
    expect(res).toMatchObject({ kind: "bytes", contentType: "audio/mpeg" });
    expect([...(res as { body: Uint8Array }).body]).toEqual([...mp3]);
    expect(keyCalls).toEqual(["u-member"]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(SPEAK_URL);
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(call.init.body as string)).toEqual({
      model: VOICE_SPEAK_MODEL,
      input: "Read this.",
      voice: "cedar",
      response_format: "mp3",
    });
  });

  it("uses the default voice when none is given, and takes text exactly at the limit", async () => {
    const { handlers, calls } = setup({ reply: audioReply });
    const text = "a".repeat(MAX_SPEAK_CHARS);
    const res = await speak(handlers, { text });
    expect(res).toMatchObject({ kind: "bytes" });
    const sent = JSON.parse(calls[0].init.body as string) as {
      voice: string;
      input: string;
    };
    expect(sent.voice).toBe(DEFAULT_VOICE_NAME);
    expect(sent.input).toBe(text);
  });

  it("refuses empty, blank, over-long or non-string text, and an unknown voice, before OpenAI", async () => {
    for (const [body, code] of [
      [{ text: "" }, "invalid_request"],
      [{ text: "   " }, "invalid_request"],
      [{ text: "a".repeat(MAX_SPEAK_CHARS + 1) }, "invalid_request"],
      [{ text: 7 }, "invalid_request"],
      [{}, "invalid_request"],
      [{ text: "Hi.", voice: "robot" }, "invalid_voice"],
    ] as const) {
      const { handlers, calls } = setup({ reply: audioReply });
      const res = await speak(handlers, body);
      expect({ body, res }).toMatchObject({
        body,
        res: { kind: "error", status: 422, code },
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("answers 409 voice_key_missing with no key or a secret source, before OpenAI", async () => {
    for (const key of [
      null,
      { name: "OPENAI_VOICE_API_KEY", source: "office_secret", key: null },
    ] as const) {
      const { handlers, calls } = setup({ key, reply: audioReply });
      const res = await speak(handlers, { text: "Hi." });
      expect({ key, res }).toMatchObject({
        key,
        res: { kind: "error", status: 409, code: "voice_key_missing" },
      });
      expect(calls).toHaveLength(0);
    }
  });

  // Retry cannot fix a 4xx other than 401 and 429, so the UI must be able to
  // tell it from an outage.
  it("maps each OpenAI failure class, and leaks neither key nor body", async () => {
    const echo = `Incorrect API key provided: ${KEY}.`;
    for (const [status, code, keyRejected] of [
      [401, "voice_provider_failed", true],
      [429, "voice_provider_failed", undefined],
      [500, "voice_provider_failed", undefined],
      [400, "voice_provider_rejected", undefined],
      [404, "voice_provider_rejected", undefined],
    ] as const) {
      const lines = captureConsole();
      const { handlers } = setup({
        reply: () =>
          Promise.resolve(
            Response.json({ error: { message: echo } }, { status }),
          ),
      });
      const res = await speak(handlers, { text: "Hi." });
      expect({ status, res }).toMatchObject({
        status,
        res: { kind: "error", status: 502, code, detail: { status } },
      });
      const detail = (res as { detail?: Record<string, unknown> }).detail;
      expect({ status, keyRejected: detail?.keyRejected }).toEqual({
        status,
        keyRejected,
      });
      const everything = JSON.stringify(res) + lines.join("\n");
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain("Incorrect API key");
      restoreConsole?.();
      restoreConsole = null;
    }
  });

  it("a network failure is voice_provider_failed, and its message does not leak", async () => {
    const lines = captureConsole();
    const { handlers } = setup({
      reply: () => Promise.reject(new Error(`socket hang up ${KEY}`)),
    });
    const res = await speak(handlers, { text: "Hi." });
    expect(res).toMatchObject({
      kind: "error",
      status: 502,
      code: "voice_provider_failed",
    });
    expect(JSON.stringify(res) + lines.join("\n")).not.toContain(KEY);
  });
});
