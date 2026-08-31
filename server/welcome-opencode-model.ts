import type { BackendModelWire } from "../shared/types.ts";
import { preferredFreeOpenCodeModel } from "../shared/opencode-model.ts";

export type WelcomeOpenCodeModelResult =
  | { kind: "selected"; model: string }
  | { kind: "no_free_model" }
  | { kind: "discovery_failed"; error: unknown };

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
    const selected = preferredFreeOpenCodeModel(models, preferredModel);
    return selected
      ? { kind: "selected", model: selected.id }
      : { kind: "no_free_model" };
  } catch (error) {
    return { kind: "discovery_failed", error };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
