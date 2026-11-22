import { loadavg } from "node:os";
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

// The models catalog of a live-tier supervisor: empty, so a server start
// neither parses the models.dev catalog nor fetches it. The tier's providers
// are mocks in the config; the catalog cost several seconds per start on a
// loaded box (task 51aa8b13).
export const OPENCODE_LIVE_MODELS_CATALOG = join(
  import.meta.dir,
  "../backends/opencode/fixtures/models-catalog-empty.json",
);

// A launch env whose member OpenCode folder is missing, so a live server
// never reads the OS user's real one (a missing folder is left out).
export function openCodeLiveLaunchEnv(
  profileDir: string,
): Record<string, string> {
  return { OPENCODE_CONFIG_DIR: join(profileDir, "member-opencode") };
}

// Runs one phase of a live OpenCode test and logs its time and the box load,
// so a slow run in the nightly log names the phase that was slow.
export async function livePhase<T>(
  phase: string,
  action: () => Promise<T>,
  label = "OpenCode live timing",
): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    console.info(
      label,
      JSON.stringify({
        phase,
        ms: Math.round(performance.now() - started),
        load: loadavg(),
      }),
    );
  }
}
