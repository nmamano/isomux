// Evidence for internal-docs/steer-delivery-design.md (2026-09-26). Run from this folder with bun; makes real Claude calls.
// Probe: where does our PostToolBatch hook sit in the raw stream, and what does a failed hook look like?
// usage: bun probe2.ts <ok|throw|timeout|subagent>
import { query } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { makePushableInput } from "../../../server/backends/claude.ts";
import { CLAUDE_NATIVE_BIN } from "../../../server/cwd-utils.ts";
const mode = process.argv[2];
const dir = "/tmp/steer-repro/probe"; // needs slow.sh from this folder copied in
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
let armed = false; let fired = 0;
const input = makePushableInput<any>();
const q = query({
  prompt: input.iterable,
  options: {
    cwd: dir, model: "claude-opus-5-5", pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    settingSources: [], permissionMode: "default", includeHookEvents: true,
    canUseTool: async (_n: string, inp: any) => ({ behavior: "allow", updatedInput: inp }),
    hooks: { PostToolBatch: [{ timeout: mode === "timeout" ? 2 : 60, hooks: [async (inp: any) => {
      fired++;
      console.log(ts(), `HOOK-CALLBACK agent_id=${inp.agent_id ?? "-"} ids=${inp.tool_calls.map((t: any) => t.tool_use_id.slice(-6)).join(",")} armed=${armed}`);
      if (inp.agent_id || !armed) return {};
      armed = false;
      if (mode === "throw") throw new Error("probe hook failure");
      if (mode === "timeout") await new Promise((r) => setTimeout(r, 5000));
      return { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: 'Message from agent "Reviewer": please also put a second line "checked-by: Reviewer" in summary.txt.' } };
    }] }] },
  } as any,
});
const task = mode === "subagent"
  ? "Use the Agent tool (general-purpose subagent) to run `bash slow.sh 3` in /tmp/steer-repro/probe and report back. Then yourself run `tail -2 progress.txt`, then write summary.txt with the number of step lines. Then reply DONE."
  : "Do this job in order: (1) run `bash slow.sh 3` in your cwd, (2) then run `tail -2 progress.txt`, (3) then write summary.txt saying how many step lines progress.txt has. Then reply DONE.";
input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: task } });
setTimeout(() => { armed = true; console.log(ts(), "ARMED"); }, 6000);
for await (const msg of q as any) {
  const p = msg.parent_tool_use_id ? ` parent=${String(msg.parent_tool_use_id).slice(-6)}` : "";
  if (msg.type === "assistant") {
    for (const b of msg.message.content) {
      if (b.type === "text") console.log(ts(), `ASSISTANT${p} text:`, b.text.slice(0, 160).replace(/\n/g, " "));
      if (b.type === "tool_use") console.log(ts(), `ASSISTANT${p} tool_use ${b.id.slice(-6)}:`, JSON.stringify(b.input).slice(0, 80));
      if (b.type === "thinking") console.log(ts(), `ASSISTANT${p} thinking`);
    }
  } else if (msg.type === "user") {
    const c = msg.message?.content;
    const ids = Array.isArray(c) ? c.filter((x: any) => x.type === "tool_result").map((x: any) => x.tool_use_id.slice(-6)).join(",") : "";
    console.log(ts(), `USER${p}${msg.isSynthetic ? " synthetic" : ""} tool_results=${ids}`, Array.isArray(c) ? "" : JSON.stringify(c).slice(0, 80));
  } else if (msg.type === "system" && String(msg.subtype).startsWith("hook_")) {
    if (msg.hook_event === "PostToolBatch") console.log(ts(), `SYS ${msg.subtype} event=${msg.hook_event} name=${msg.hook_name} id=${String(msg.hook_id).slice(0,8)} outcome=${msg.outcome ?? ""} output=${String(msg.output ?? "").slice(0, 200)}`);
  } else if (msg.type === "result") {
    console.log(ts(), "RESULT", msg.subtype, String(msg.result ?? "").slice(0, 200).replace(/\n/g, " "));
    input.end();
  }
}
console.log(ts(), "END callbacks=", fired);
