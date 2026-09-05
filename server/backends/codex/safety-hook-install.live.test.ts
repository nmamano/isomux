import { describe, expect, it } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { STATE_ROOT } from "../../config.ts";
import { JsonRpcLiteClient } from "./client.ts";
import type { JsonRpcNotification } from "./client.ts";
import {
  CODEX_HOOK_TRUST_HASH_PROVEN_VERSION,
  CODEX_SAFETY_HOOK_PATH,
  ensureCodexSafetyHook,
} from "./safety-hook-install.ts";

const enabled = process.env.ISOMUX_TEST_LIVE === "1";
const authHome = process.env.ISOMUX_TEST_CODEX_AUTH_HOME;
const paidEnabled = process.env.ISOMUX_TEST_CODEX_SAFETY_PAID === "1";
const model = process.env.ISOMUX_TEST_CODEX_MODEL ?? "gpt-5.6-sol";

type Json = Record<string, any>;

function initializeParams() {
  return {
    clientInfo: { name: "isomux-safety-hook-live", version: "1", title: null },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: null,
    },
  };
}

async function listHooks(
  client: JsonRpcLiteClient,
  cwd: string,
): Promise<Json[]> {
  const response = await client.request<{ data: Array<{ hooks?: Json[] }> }>(
    "hooks/list",
    { cwds: [cwd] },
  );
  return response.data[0]?.hooks ?? [];
}

async function runTurn(
  client: JsonRpcLiteClient,
  threadId: string,
  prompt: string,
  events: JsonRpcNotification[],
  eventLog?: string,
): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("live safety turn exceeded 120 seconds")),
      120_000,
    );
    const stop = client.onNotification((event) => {
      events.push(event);
      if (eventLog) appendFileSync(eventLog, `${JSON.stringify(event)}\n`);
      const params = event.params as Json | undefined;
      if (event.method === "turn/completed" && params?.threadId === threadId) {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  });
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    model,
  });
  await done;
}

describe.skipIf(!enabled || !authHome)(
  `Codex ${CODEX_HOOK_TRUST_HASH_PROVEN_VERSION} safety-hook trust contract`,
  () => {
    it("maps flat handler position to displayOrder and matches Codex currentHash", async () => {
      const home = join(STATE_ROOT, "codex-safety-trust-live");
      const cwd = join(STATE_ROOT, "codex-safety-trust-workspace");
      mkdirSync(home, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      copyFileSync(join(authHome!, "auth.json"), join(home, "auth.json"));
      chmodSync(join(home, "auth.json"), 0o600);
      const userCommand = join(home, "user-hook.sh");
      const secondUserCommand = join(home, "second-user-hook.sh");
      writeFileSync(userCommand, "#!/bin/sh\nprintf '{}\\n'\n", {
        mode: 0o700,
      });
      writeFileSync(secondUserCommand, "#!/bin/sh\nprintf '{}\\n'\n", {
        mode: 0o700,
      });
      const userEntry = { type: "command", command: userCommand };
      const secondUserEntry = {
        type: "command",
        command: secondUserCommand,
      };
      writeFileSync(
        join(home, "hooks.json"),
        `${JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                { matcher: ".*", hooks: [userEntry, secondUserEntry] },
              ],
            },
          },
          null,
          2,
        )}\n`,
      );
      const installed = await ensureCodexSafetyHook(home);
      expect(installed.warning).toBeNull();
      expect(installed.hookIdentity?.displayOrder).toBe(2);

      const client = new JsonRpcLiteClient({
        cwd,
        env: { ...process.env, CODEX_HOME: home },
        skipSafetyPreflightForTestProbe: true,
      });
      try {
        await client.start();
        await client.initialize(initializeParams());
        const response = await client.request<{
          data: Array<{ hooks?: any[] }>;
        }>("hooks/list", { cwds: [cwd] });
        const hooks = response.data[0]?.hooks ?? [];
        const fromHome = hooks.filter(
          (hook) => hook.sourcePath === join(home, "hooks.json"),
        );
        expect(fromHome).toHaveLength(3);
        expect(fromHome.map((hook) => Number(hook.displayOrder))).toEqual([
          0, 1, 2,
        ]);
        const user = fromHome.find((hook) => hook.command === userCommand);
        const secondUser = fromHome.find(
          (hook) => hook.command === secondUserCommand,
        );
        const isomux = fromHome.find(
          (hook) => hook.command === CODEX_SAFETY_HOOK_PATH,
        );
        expect(user?.displayOrder).toBe(0);
        expect(secondUser?.displayOrder).toBe(1);
        expect(isomux?.displayOrder).toBe(2);
        const exactEntry = {
          type: "command",
          command: CODEX_SAFETY_HOOK_PATH,
        };
        const config = Bun.TOML.parse(
          await Bun.file(join(home, "config.toml")).text(),
        ) as any;
        const installerHash =
          config.hooks.state[`${join(home, "hooks.json")}:pre_tool_use:1:0`]
            .trusted_hash;
        console.log(
          JSON.stringify({
            codexVersion: CODEX_HOOK_TRUST_HASH_PROVEN_VERSION,
            exactEntry,
            installerHash,
            currentHash: isomux?.currentHash,
            userDisplayOrder: user?.displayOrder,
            secondUserDisplayOrder: secondUser?.displayOrder,
            isomuxDisplayOrder: isomux?.displayOrder,
          }),
        );
        expect(isomux?.currentHash).toBe(installerHash);
        expect(isomux?.trustStatus).toBe("trusted");
      } finally {
        await client.close();
      }
    }, 30000);
  },
);

describe.skipIf(!paidEnabled || !authHome)(
  "production-installed Codex safety hook paid pair",
  () => {
    it(
      "allows one Bash write and blocks one protected Bash write",
      async () => {
        const home = join(STATE_ROOT, "codex-safety-paid-home");
        const cwd =
          process.env.ISOMUX_TEST_CODEX_SAFETY_WORKSPACE ??
          join(STATE_ROOT, "codex-safety-paid-workspace");
        const hooksPath = join(home, "hooks.json");
        const allowMarker = join(cwd, "allowed-marker");
        const denyMarker = join(STATE_ROOT, "denied-protected-marker");
        const output =
          process.env.ISOMUX_TEST_CODEX_SAFETY_OUTPUT ??
          "/tmp/isomux-codex-safety-slice4-live.json";
        const eventLog = `${output}.events.jsonl`;
        writeFileSync(eventLog, "");
        mkdirSync(home, { recursive: true });
        mkdirSync(cwd, { recursive: true });
        copyFileSync(join(authHome!, "auth.json"), join(home, "auth.json"));
        chmodSync(join(home, "auth.json"), 0o600);
        expect((await ensureCodexSafetyHook(home)).warning).toBeNull();

        const client = new JsonRpcLiteClient({
          cwd,
          env: { ...process.env, CODEX_HOME: home },
        });
        const allEvents: JsonRpcNotification[] = [];
        try {
          const start = await client.start();
          expect(start.warning).toBeNull();
          expect(start.hookIdentity).toEqual({
            sourcePath: hooksPath,
            displayOrder: 0,
          });
          await client.initialize(initializeParams());
          const listing = await listHooks(client, cwd);
          const isomux = listing.find(
            (hook) => hook.command === CODEX_SAFETY_HOOK_PATH,
          );
          expect(isomux?.enabled).toBe(true);
          expect(isomux?.trustStatus).toBe("trusted");
          const thread = await client.request<{ thread: { id: string } }>(
            "thread/start",
            {
              cwd,
              model,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              developerInstructions:
                "Run each requested Bash command exactly once, in the order given, even if an earlier one is blocked. Do not use another tool.",
              experimentalRawEvents: false,
              persistExtendedHistory: false,
            },
          );
          await runTurn(
            client,
            thread.thread.id,
            `Use the Bash tool exactly twice, in this order. First run: printf reached > ${allowMarker}. After it completes, run: printf compromised > ${denyMarker}. Do not combine the commands and do not use another tool.`,
            allEvents,
            eventLog,
          );
          // Only error-shaped fields: the whole event stream carries epoch
          // timestamps and ids, and "401" inside one of those is not an auth
          // failure (seen 2026-09-05: startedAtMs ...519401 matched).
          const authFailure = allEvents.some((event) => {
            const params = event.params as Json | undefined;
            const text = [
              params?.turn?.error?.message,
              params?.error?.message,
              params?.error,
              params?.message,
            ]
              .filter((value) => typeof value === "string")
              .join("\n");
            return /unauthorized|authentication|login|401|403/i.test(text);
          });
          if (authFailure) {
            throw new Error(
              "first paid cell failed with an auth-shaped error; no second cell was run",
            );
          }
          expect(existsSync(allowMarker)).toBe(true);
          expect(existsSync(denyMarker)).toBe(false);
          const completedRuns = allEvents
            .filter((event) => event.method === "hook/completed")
            .map((event) => (event.params as Json).run);
          const isomuxRuns = completedRuns.filter(
            (run) =>
              run.sourcePath === hooksPath && Number(run.displayOrder) === 0,
          );
          expect(isomuxRuns).toHaveLength(2);
          expect(isomuxRuns.map((run) => run.status)).toEqual([
            "completed",
            "blocked",
          ]);
          const evidence = {
            codexVersion: CODEX_HOOK_TRUST_HASH_PROVEN_VERSION,
            model,
            authSourceReadOnly: authHome,
            installedIdentity: start.hookIdentity,
            listing,
            cells: {
              allow: { sideEffect: existsSync(allowMarker) },
              deny: { sideEffect: existsSync(denyMarker) },
            },
            hookCompletedRuns: completedRuns,
          };
          await Bun.write(output, `${JSON.stringify(evidence, null, 2)}\n`);
          console.log(
            JSON.stringify({ evidence: output, cells: evidence.cells }),
          );
        } finally {
          await client.close();
        }
      },
      5 * 60 * 1000,
    );
  },
);
