import { readFile, writeFile } from "node:fs/promises";
import { createOpenCodeBackend } from "./adapter.ts";
import { OpenCodeSupervisor } from "./supervisor.ts";
import type { NormalizedEvent } from "../types.ts";

const phase = process.env.S4_PHASE;
const root = required("S4_ROOT");
const resultPath = required("S4_RESULT");
const config = JSON.parse(required("S4_CONFIG")) as Record<string, unknown>;
const supervisor = new OpenCodeSupervisor({
  profileDir: `${root}/profile`,
  serverCwd: root,
  config,
  environmentRevision: "s4-process-loss",
});
const backend = createOpenCodeBackend({ supervisor });
const opts = {
  agentId: "s4-process-loss",
  cwd: root,
  systemPrompt: "test",
  modelFamily: "gate/gate-model",
  effort: "high",
  permissionMode: "default",
  environmentKey: "s4-process-loss",
  environmentRevision: "s4-process-loss",
};

if (phase === "first") {
  const session = backend.createSession(opts);
  const events = await oneTurn(session, "S4_CONTEXT_CANARY");
  const sessionId = systemSessionId(events);
  await writeFile(
    resultPath,
    JSON.stringify({
      sessionId,
      serverPid: JSON.parse(await readFile(supervisor.recordPath, "utf8")).pid,
    }),
  );
  process.kill(process.pid, "SIGKILL");
} else if (phase === "resume") {
  const prior = JSON.parse(await readFile(resultPath, "utf8")) as {
    sessionId: string;
    serverPid: number;
  };
  const session = backend.resumeSession(prior.sessionId, opts);
  const events = await oneTurn(session, "GATE_RECALL");
  const text = events
    .filter(
      (event): event is Extract<NormalizedEvent, { kind: "assistant_text" }> =>
        event.kind === "assistant_text",
    )
    .map((event) => event.text)
    .join("");
  session.close();
  const adoptedPid = JSON.parse(
    await readFile(supervisor.recordPath, "utf8"),
  ).pid;
  await supervisor.shutdown();
  await writeFile(resultPath, JSON.stringify({ ...prior, adoptedPid, text }));
} else {
  throw new Error("S4_PHASE must be first or resume");
}

async function oneTurn(
  session: ReturnType<typeof backend.createSession>,
  text: string,
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  const done = (async () => {
    for await (const event of session.stream()) {
      events.push(event);
      if (event.kind === "turn_completed") return;
    }
  })();
  await session.send(text);
  await done;
  return events;
}

function systemSessionId(events: NormalizedEvent[]): string {
  const event = events.find(
    (value): value is Extract<NormalizedEvent, { kind: "system_init" }> =>
      value.kind === "system_init" && Boolean(value.sessionId),
  );
  if (!event?.sessionId)
    throw new Error("OpenCode did not report a session id");
  return event.sessionId;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
