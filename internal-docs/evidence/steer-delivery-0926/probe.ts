// Evidence for internal-docs/steer-delivery-design.md (2026-09-26). Run from this folder with bun; makes real Claude calls.
// Probe: push a user message into a running Claude turn; observe fold vs abort.
// usage: bun probe.ts <priority|none> <pushDelayMs>
import { query } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { makePushableInput } from "../../../server/backends/claude.ts";
import { CLAUDE_NATIVE_BIN } from "../../../server/cwd-utils.ts";
import { rmSync, existsSync, readFileSync } from "node:fs";
const [prio, delay, mode] = [process.argv[2], Number(process.argv[3] ?? 12000), process.argv[4] ?? "tool"];
const dir = "/tmp/steer-repro/probe"; // needs slow.sh from this folder copied in
rmSync(dir + "/progress.txt", { force: true });
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const lines = () => existsSync(dir + "/progress.txt") ? readFileSync(dir + "/progress.txt", "utf8").trim().split("\n").length : 0;
const input = makePushableInput<any>();
let hookSteer: string | null = null;
const q = query({
  prompt: input.iterable,
  options: {
    cwd: dir, model: "claude-opus-5-5", pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    settingSources: [], permissionMode: "default",
    hooks: { PostToolBatch: [{ hooks: [async (inp: any) => {
      console.log(ts(), "HOOK PostToolBatch agent_id=" + (inp.agent_id ?? "-") + " tools=" + inp.tool_calls.map((t: any) => t.tool_name).join(","), "hookSteer=" + (hookSteer ? "yes" : "no"));
      if (!hookSteer) return {};
      const text = hookSteer; hookSteer = null;
      return { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: text } };
    }] }] },
    canUseTool: async (name: string, inp: any) => {
      const c = String(inp?.command ?? "");
      if (name === "Bash" && /^(bash slow\.sh|tail|cat|wc|grep|echo)/.test(c)) return { behavior: "allow", updatedInput: inp };
      if (name === "Write" && String(inp?.file_path ?? "").startsWith(dir)) return { behavior: "allow", updatedInput: inp };
      return { behavior: "deny", message: "not allowed in probe" };
    },
  } as any,
});
input.push({ type: "user", uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: "user", content:
  mode === "text" ? "Without using any tools, write a 500-word story about a lighthouse keeper. Then reply DONE." : "Do this job in order: (1) run `bash slow.sh 6` in your cwd (about 30 seconds), (2) then run `tail -3 progress.txt`, (3) then write summary.txt saying how many step lines progress.txt has. Then reply DONE." } });
const steerUuid = crypto.randomUUID();
setTimeout(() => {
  const m: any = { type: "user", uuid: steerUuid, parent_tool_use_id: null, message: { role: "user", content: "FYI from a teammate: I am starting on the docs now. No action needed from you." } };
  if (prio === "hook") { hookSteer = process.env.STEER_TEXT ?? "FYI from a teammate: I am starting on the docs now. No action needed from you."; console.log(ts(), "HOOK-ARMED progressLines=" + lines()); pushed = true; return; }
  if (prio !== "none") m.priority = prio;
  console.log(ts(), `PUSH steer uuid=${steerUuid.slice(0,8)} priority=${prio} progressLines=${lines()}`);
  input.push(m); pushed = true; pending.add(steerUuid);
}, delay);
let results = 0; const pending = new Set<string>(); let pushed = false;
for await (const msg of q as any) {
  const t = msg.type + (msg.subtype ? "/" + msg.subtype : "");
  if (msg.type === "assistant") {
    for (const b of msg.message.content) {
      if (b.type === "text") console.log(ts(), "ASSISTANT text:", b.text.slice(0, 300).replace(/\n/g, " "));
      if (b.type === "tool_use") console.log(ts(), "ASSISTANT tool_use:", JSON.stringify(b.input).slice(0, 120));
    }
  } else if (msg.type === "user") {
    const c = msg.message?.content;
    console.log(ts(), "USER", msg.uuid?.slice(0,8) ?? "", msg.isSynthetic ? "synthetic" : "", JSON.stringify(c).slice(0, 400), "progressLines=" + lines());
  } else if (msg.type === "result") {
    results++;
    console.log(ts(), "RESULT", msg.subtype, "uuids=", JSON.stringify((msg.user_message_uuids ?? []).map((u: string) => u.slice(0,8))), "queued_turn_count=", msg.queued_turn_count, "text=", String(msg.result ?? "").slice(0, 200).replace(/\n/g, " "));
    for (const u of msg.user_message_uuids ?? []) pending.delete(u);
    if (!msg.queued_turn_count && pushed && pending.size === 0 && !hookSteer) { input.end(); }
  } else if (t === "system/init") {
    console.log(ts(), "INIT session=" + msg.session_id, "caps=", JSON.stringify(msg.capabilities ?? msg.protocol_capabilities ?? null));
  } else if (msg.type !== "stream_event") {
    console.log(ts(), "OTHER", t, JSON.stringify(msg).slice(0, 200));
  }
}
console.log(ts(), "END results=", results, "progressLines=", lines());
