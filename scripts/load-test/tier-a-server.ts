// Tier A load-test server: the real Isomux server (test harness boot) with a
// FakeBackend standing in for the engine. It measures the checkout it sits in.
// The name has no .test suffix, so `bun test` and CI never pick it up; run it
// by path from the checkout root:
//   LT_DIR=<run dir> LT_AGENTS=<n> LT_MEMBERS=<m> \
//     bun test ./scripts/load-test/tier-a-server.ts
// (env, not arguments: bun test takes no arguments for the file it runs).
// Writes $LT_DIR/server.json (port, origin, cookie name, sessions, agent ids,
// agent tokens) for gen.ts, then engine.jsonl (engine receipt times) and
// proc.jsonl (rss/cpu each second), until $LT_DIR/stop exists.
import { it } from "bun:test";
import { appendFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer } from "../../server/test-support/harness.ts";
import {
  FakeBackend,
  type FakeSession,
} from "../../server/test-support/fake-backend.ts";
import { getAgentTokenRaw } from "../../server/identity/tokens.ts";
import { buildPublicOrigin, sessionCookieName } from "../../server/auth.ts";

const DIR = process.env.LT_DIR;
if (!DIR) throw new Error("set LT_DIR to the run directory");
const AGENTS = Number(process.env.LT_AGENTS ?? 5);
const MEMBERS = Number(process.env.LT_MEMBERS ?? 5);
const now = () => performance.timeOrigin + performance.now();

let receipts: string[] = [];
let tid = 0;

// A turn: "LT <msgId> <events> <intervalMs> <bytes>". The engine answers with
// <events> entries, each carrying "LTOUT <msgId> <k> <emitMs> <pad>", spaced
// <intervalMs>: every fourth one (k % 4 === 1) a tool_call plus tool_result,
// the rest assistant_text. Then turn_completed.
const backend = new FakeBackend({
  session: {
    onSend: (text: string, _a: unknown, s: FakeSession) => {
      const t = now();
      const m = /LT (\S+) (\d+) (\d+) (\d+)/.exec(text);
      if (!m) {
        s.completeTurn({ text: "ok" });
        return;
      }
      const [, id, evs, iv, bytes] = m;
      receipts.push(JSON.stringify({ id, t }));
      const n = Number(evs);
      const pad = "x".repeat(Number(bytes));
      let k = 0;
      const step = () => {
        if (k < n) {
          if (k % 4 === 1) {
            const tu = `tu${++tid}`;
            s.push({
              kind: "tool_call",
              toolUseId: tu,
              name: "Bash",
              input: { command: `echo LTOUT ${id} ${k} ${now()}` },
            });
            s.push({
              kind: "tool_result",
              toolUseId: tu,
              content: `LTOUT ${id} ${k} ${now()} ${pad}`,
            });
          } else {
            s.push({
              kind: "assistant_text",
              text: `LTOUT ${id} ${k} ${now()} ${pad}`,
            });
          }
          k++;
          setTimeout(step, Number(iv));
        } else {
          s.completeTurn({});
        }
      };
      setTimeout(step, 0);
    },
  },
});

it(
  "load server",
  async () => {
    const srv = await startTestServer({ fakeBackend: backend });
    const owner = await srv.seedOwner("Owner");
    const members = [owner];
    for (let i = 1; i < MEMBERS; i++)
      members.push(await srv.seedMember(`M${i}`));
    // A room seats 108 agents (8 front desks, 100 in the back room).
    const rooms = [srv.agentManager.getRooms()[0].id];
    const ids: string[] = [];
    for (let i = 0; i < AGENTS; i++) {
      const r = Math.floor(i / 100);
      while (rooms.length <= r)
        rooms.push(srv.agentManager.createRoom(`R${rooms.length}`));
      const info = await srv.agentManager.spawn(
        `A${i}`,
        srv.stateRoot,
        "default",
        undefined,
        undefined,
        rooms[r],
      );
      if (!info) throw new Error("spawn failed");
      ids.push(info.id);
    }
    writeFileSync(
      join(DIR, "server.json"),
      JSON.stringify({
        port: srv.port,
        origin: buildPublicOrigin().origin,
        cookie: sessionCookieName(),
        sessions: members.map((m) => m.rawSessionId),
        agents: ids,
        tokens: ids.map((id) => getAgentTokenRaw(id)),
        pid: process.pid,
      }),
    );
    let lastCpu = process.cpuUsage();
    let lastT = now();
    while (!existsSync(join(DIR, "stop"))) {
      await Bun.sleep(1000);
      const cpu = process.cpuUsage();
      const t = now();
      const mu = process.memoryUsage();
      appendFileSync(
        join(DIR, "proc.jsonl"),
        JSON.stringify({
          t,
          rss: mu.rss,
          heap: mu.heapUsed,
          cpu:
            (cpu.user + cpu.system - lastCpu.user - lastCpu.system) /
            1000 /
            (t - lastT),
        }) + "\n",
      );
      lastCpu = cpu;
      lastT = t;
      if (receipts.length) {
        appendFileSync(join(DIR, "engine.jsonl"), receipts.join("\n") + "\n");
        receipts = [];
      }
    }
    await srv.stop();
  },
  { timeout: 24 * 3600 * 1000 },
);
