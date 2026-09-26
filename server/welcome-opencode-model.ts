import type { BackendModelWire } from "../shared/types.ts";
import { preferredFreeOpenCodeModel } from "../shared/opencode-model.ts";

export type WelcomeOpenCodeModelResult =
  | { kind: "selected"; model: string }
  | { kind: "no_free_model" }
  | { kind: "discovery_failed"; error: unknown };

function selectWelcomeOpenCodeModel(
  models: BackendModelWire[],
  preferredModel: string,
): WelcomeOpenCodeModelResult {
  // Only the preferred model's provider. Another connected provider can list
  // cost-0 models that still need a subscription: OpenCode Go refuses its
  // "-free" models without one (measured 2026-09-26).
  const provider = preferredModel.slice(0, preferredModel.indexOf("/") + 1);
  const selected = preferredFreeOpenCodeModel(
    models.filter((model) => model.id.startsWith(provider)),
    preferredModel,
  );
  return selected
    ? { kind: "selected", model: selected.id }
    : { kind: "no_free_model" };
}

export async function resolveWelcomeOpenCodeModel(
  discover: () => Promise<BackendModelWire[]>,
  preferredModel: string,
  timeoutMs: number,
): Promise<WelcomeOpenCodeModelResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      discover(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("OpenCode model discovery timed out")),
          timeoutMs,
        );
      }),
    ]);
    return selectWelcomeOpenCodeModel(models, preferredModel);
  } catch (error) {
    return { kind: "discovery_failed", error };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface WelcomeModelRetryTiming {
  delayMs: number;
  windowMs: number;
}

export interface WelcomeModelRetryClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: WelcomeModelRetryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const WELCOME_MODEL_RETRY_WINDOW_CLOSED =
  "OpenCode model discovery retry window closed";

// Discovery again until one request succeeds or the window closes. Each
// request is awaited until it settles, so attempts never run in parallel, and
// a request that never settles ends the retry. A result that arrives after the
// window counts as a failure.
export async function retryWelcomeOpenCodeModel(
  discover: () => Promise<BackendModelWire[]>,
  preferredModel: string,
  timing: WelcomeModelRetryTiming,
  clock: WelcomeModelRetryClock = realClock,
): Promise<WelcomeOpenCodeModelResult> {
  const deadline = clock.now() + timing.windowMs;
  const windowClosed: WelcomeOpenCodeModelResult = {
    kind: "discovery_failed",
    error: new Error(WELCOME_MODEL_RETRY_WINDOW_CLOSED),
  };
  for (;;) {
    // A late timer can wake the loop after the window.
    if (clock.now() > deadline) return windowClosed;
    let result: WelcomeOpenCodeModelResult;
    try {
      result = selectWelcomeOpenCodeModel(await discover(), preferredModel);
    } catch (error) {
      result = { kind: "discovery_failed", error };
    }
    if (clock.now() > deadline) return windowClosed;
    if (result.kind !== "discovery_failed") return result;
    if (clock.now() + timing.delayMs >= deadline) return result;
    await clock.sleep(timing.delayMs);
  }
}
