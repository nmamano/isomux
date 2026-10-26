import type { AgentInfo, BackendModelWire } from "../shared/types.ts";
import {
  preferredFreeOpenCodeModel,
  type OpenCodeFreeModelCandidate,
} from "../shared/opencode-model.ts";

export type WelcomeOpenCodeModelResult =
  | { kind: "selected"; model: string }
  | { kind: "no_free_model" }
  | { kind: "discovery_failed"; error: unknown };

function selectWelcomeOpenCodeModel(
  models: BackendModelWire[],
  preferredModel: string,
): WelcomeOpenCodeModelResult {
  const selected = preferredFreeOpenCodeModel(models, preferredModel);
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

export interface FreeModelProbeTiming {
  // One probe that has not answered by then counts as refused.
  probeTimeoutMs: number;
  // The whole search. A probe starts only while at least probeTimeoutMs of
  // the budget is left.
  probeBudgetMs: number;
}

// The free models a welcome agent can run on, best first: the preferred id,
// then the others of its provider in id order (preferredFreeOpenCodeModel
// returns the first).
export function freeOpenCodeCandidates(
  models: readonly OpenCodeFreeModelCandidate[],
  preferredId: string,
): string[] {
  const provider = preferredId.slice(0, preferredId.indexOf("/") + 1);
  const free = models
    .filter(
      (model) =>
        !model.hidden && model.isFree === true && model.id.startsWith(provider),
    )
    .map((model) => model.id)
    .sort((a, b) => a.localeCompare(b));
  return free.includes(preferredId)
    ? [preferredId, ...free.filter((id) => id !== preferredId)]
    : free;
}

// The first candidate that answers one probe, in order and one at a time, or
// null when none answers within the budget. A probe that throws, rejects or
// times out did not answer.
export async function firstAnsweringModel(
  candidates: readonly string[],
  probe: (model: string) => Promise<void>,
  timing: FreeModelProbeTiming,
  clock: WelcomeModelRetryClock = realClock,
): Promise<string | null> {
  const deadline = clock.now() + timing.probeBudgetMs;
  for (const model of candidates) {
    if (deadline - clock.now() < timing.probeTimeoutMs) return null;
    const timedOut = clock.sleep(timing.probeTimeoutMs).then(() => false);
    const answered = (async () => {
      await probe(model);
      return true;
    })().catch(() => false);
    if (await Promise.race([answered, timedOut])) return model;
  }
  return null;
}

// Finds the free model a refused office-seeded agent moves to: one that
// answers a probe, never refusedModel. Null when none answers.
export type RefusedFreeModelReplacer = (
  agent: AgentInfo,
  refusedModel: string,
) => Promise<string | null>;
