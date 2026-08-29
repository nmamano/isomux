/** Ask the pinned Codex App Server for its private hook-entry trust hash. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JsonRpcLiteClient } from "./client.ts";

export const CODEX_HOOK_TRUST_PROBE_TIMEOUT_MS = 10_000;

function withTrustProbeDeadline<T>(
  operation: Promise<T>,
  timeoutMs = CODEX_HOOK_TRUST_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Codex hook trust probe exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function discoverCodexHookTrustedHash(
  commandPath: string,
): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "isomux-codex-hook-hash-"));
  const cwd = join(home, "workspace");
  mkdirSync(cwd);
  writeFileSync(
    join(home, "hooks.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: ".*",
              hooks: [{ type: "command", command: commandPath }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  const client = new JsonRpcLiteClient({
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    skipSafetyPreflightForTestProbe: true,
  });
  try {
    return await withTrustProbeDeadline(
      (async () => {
        await client.start();
        await client.initialize({
          clientInfo: {
            name: "isomux-safety-hook-trust-measurement",
            version: "1",
            title: null,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: null,
          },
        });
        const response = await client.request<{
          data: Array<{
            hooks?: Array<{
              command?: unknown;
              currentHash?: unknown;
              displayOrder?: unknown;
            }>;
          }>;
        }>("hooks/list", { cwds: [cwd] });
        const hook = (response.data[0]?.hooks ?? []).find(
          (candidate) => candidate.command === commandPath,
        );
        if (
          hook?.displayOrder !== 0 ||
          typeof hook.currentHash !== "string" ||
          !hook.currentHash.startsWith("sha256:")
        ) {
          throw new Error(
            `pinned Codex returned invalid hook trust metadata: ${JSON.stringify(hook)}`,
          );
        }
        return hook.currentHash;
      })(),
    );
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}

export const _test = { withTrustProbeDeadline };
