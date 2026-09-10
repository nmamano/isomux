// Opt-in real-provider certification for OC1 S5.
//
// Run only from a scratch Isomux home and a named memory-limited user scope:
//   ISOMUX_HOME=/tmp/isomux-opencode-s5-live \
//   ISOMUX_TEST_LIVE=1 \
//   ISOMUX_OPENCODE_CERT_MODELS=provider/model[,provider/model...] \
//   systemd-run --user --scope -p MemoryMax=2G \
//     --unit=isomux-opencode-s5-live bun test \
//     server/backends/opencode/live-certification.test.ts
//
// At most three explicit models are accepted. The harness records billed
// input-plus-output tokens and fails after a response exceeds 200,000; this is
// not a pre-spend cap. The actual pre-spend bound is one short prompt with a
// 120-second response wait per model, plus a stated $2-per-model intent.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE } from "../../test-support/live-gate.ts";
import type { NormalizedEvent } from "../types.ts";
import { createOpenCodeBackend } from "./adapter.ts";
import { OpenCodeSupervisor } from "./supervisor.ts";

const TOKEN_LIMIT_PER_MODEL = 200_000;
const requestedModels = (process.env.ISOMUX_OPENCODE_CERT_MODELS ?? "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

let root: string | null = null;
let supervisor: OpenCodeSupervisor | null = null;

afterAll(async () => {
  await supervisor?.shutdown();
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("OpenCode OC1 real-provider certification", () => {
  it("certifies at most three explicit connected models within the token budget", async () => {
    if (requestedModels.length === 0) {
      throw new Error(
        "Set ISOMUX_OPENCODE_CERT_MODELS to one to three provider/model IDs.",
      );
    }
    if (requestedModels.length > 3) {
      throw new Error("OpenCode certification accepts at most three models.");
    }
    root = await mkdtemp(join(tmpdir(), "isomux-opencode-s5-live-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    await Bun.write(join(repo, ".keep"), "OC1 S5 live scratch repo\n");
    supervisor = new OpenCodeSupervisor({
      profileDir: join(root, "profile"),
      serverCwd: repo,
      launchEnv: { ...process.env },
    });
    const backend = createOpenCodeBackend({ supervisor });
    const discovered = await backend.listModels({ cwd: repo });
    const freeModel = discovered.find((model) => model.isFree && !model.hidden);
    expect(freeModel).toBeDefined();
    expect(
      (
        await backend.oneShotPrompt("Output only: LIVE_TOPIC_OK", {
          cwd: repo,
          modelFamily: freeModel!.id,
          systemPrompt:
            "You are a labelling tool. Output only the requested label.",
        })
      ).trim(),
    ).toContain("LIVE_TOPIC_OK");
    const variantModel = discovered.find(
      (model) =>
        model.isFree && !model.hidden && model.supportedEfforts.length > 0,
    );
    expect(variantModel).toBeDefined();
    // This is a real-provider smoke, not proof that OpenCode applied the
    // variant. The pinned API also returns 204 for an unknown variant; the
    // transport request-body test proves that Isomux sends the known one.
    const variantEffort = variantModel!.supportedEfforts[0].level;
    const variantSession = backend.createSession({
      agentId: "live-variant-check",
      cwd: repo,
      systemPrompt: "Reply briefly and do not use tools.",
      modelFamily: variantModel!.id,
      effort: variantEffort,
      permissionMode: "default",
    });
    const variantEvents: NormalizedEvent[] = [];
    const variantComplete = (async () => {
      for await (const event of variantSession.stream()) {
        variantEvents.push(event);
        if (event.kind === "turn_completed") return event;
      }
      throw new Error("OpenCode variant check ended before completion.");
    })();
    await variantSession.send("Reply with exactly OC1_VARIANT_OK.");
    const variantTerminal = await Promise.race([
      variantComplete,
      Bun.sleep(120_000).then(() => {
        throw new Error("OpenCode variant check timed out.");
      }),
    ]);
    variantSession.close();
    expect(variantTerminal.status).toBe("completed");
    expect(
      variantEvents
        .filter((event) => event.kind === "assistant_text")
        .map((event) => event.text)
        .join(""),
    ).toContain("OC1_VARIANT_OK");
    const connected = new Set(discovered.map((model) => model.id));
    for (const model of requestedModels) {
      expect(connected.has(model)).toBe(true);
    }
    for (const model of requestedModels) {
      const session = backend.createSession({
        agentId: `live-${model.replaceAll(/[^a-zA-Z0-9]/g, "-")}`,
        cwd: repo,
        systemPrompt: "Reply briefly and do not use tools.",
        modelFamily: model,
        effort: "high",
        permissionMode: "default",
      });
      const events: NormalizedEvent[] = [];
      const complete = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.kind === "turn_completed") return event;
        }
        throw new Error("OpenCode live stream ended before completion.");
      })();
      await session.send("Reply with exactly OC1_S5_OK.");
      const terminal = await Promise.race([
        complete,
        Bun.sleep(120_000).then(() => {
          throw new Error("OpenCode live certification timed out.");
        }),
      ]);
      session.close();
      expect(terminal.status).toBe("completed");
      expect(
        events
          .filter((event) => event.kind === "assistant_text")
          .map((event) => event.text)
          .join(""),
      ).toContain("OC1_S5_OK");
      const billedTokens =
        (terminal.usage?.inputTokens ?? 0) +
        (terminal.usage?.outputTokens ?? 0);
      expect(billedTokens).toBeGreaterThan(0);
      expect(billedTokens).toBeLessThanOrEqual(TOKEN_LIMIT_PER_MODEL);
    }
  }, 520_000); // Adds one 120-second variant smoke to the prior 400-second bound.
});
