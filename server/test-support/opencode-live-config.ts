import { join } from "node:path";
import { openCodeDefaultConfig } from "../backends/opencode/supervisor.ts";

// A mock provider in the 2.1.4 config keys, on the OpenAI-compatible package
// (the shape the gate probes used, 2026-10-25).
export function openCodeMockProvider(
  baseURL: string,
  options: {
    name?: string;
    model?: string;
    apiKey?: string;
    modelConfig?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const model = options.model ?? "gate-model";
  return {
    name: options.name ?? "Gate mock",
    env: [],
    package: "@opencode/ai/providers/openai-compatible",
    settings: { apiKey: options.apiKey ?? "test-only", baseURL },
    models: {
      [model]: {
        name: "Gate model",
        cost: { input: 0, output: 0 },
        ...options.modelConfig,
      },
    },
  };
}

// The config a live-tier supervisor gets: Isomux's own keys, as production
// sends them, plus the mock providers and the default model.
export function openCodeLiveConfig(
  model: string,
  providers: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...openCodeDefaultConfig(), model, providers, ...extra };
}

// A launch env whose member OpenCode folder is missing, so a live server
// never reads the OS user's real one (a missing folder is left out).
export function openCodeLiveLaunchEnv(
  profileDir: string,
): Record<string, string> {
  return { OPENCODE_CONFIG_DIR: join(profileDir, "member-opencode") };
}
