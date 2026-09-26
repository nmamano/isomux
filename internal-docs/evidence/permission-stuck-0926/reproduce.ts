// Reproduces task 7a185be0: permission-prompt clicks do nothing and the agent
// never continues. Real Claude agent (the box's default Claude login, no
// Bedrock), in-process manager, fresh ISOMUX_HOME. The prompt makes Claude run
// two subagents in parallel; each subagent asks for Bash permission.
//
// The harness models a member: it feeds every server event through the real UI
// reducer (ui/store.tsx) and clicks the card that LogView renders
// (interactions.find by agentId, ui/log-view/LogView.tsx). After the clicks it
// models a page reload (the UI rebuilt from getPendingInteractions) and clicks
// again.
//
//   d=$(mktemp -d /tmp/permstuck-XXXXXX); rm -f /tmp/permprobe/{a,b}.txt
//   ISOMUX_HOME="$d" systemd-run --user --scope -p MemoryMax=2G --quiet \
//     bun internal-docs/evidence/permission-stuck-0926/reproduce.ts
import { mkdir } from "node:fs/promises";
import { createAgentManager } from "../../../server/agent-manager.ts";
import { claudeBackend } from "../../../server/backends/claude.ts";
import { OfficeState } from "../../../shared/office-state.ts";
import { reducer, initialState } from "../../../ui/store.tsx";

const root = process.env.ISOMUX_HOME;
if (!root?.includes("permstuck-")) throw new Error("Use a fresh ISOMUX_HOME");
const work = "/tmp/permprobe";
await mkdir(work, { recursive: true });
const t0 = Date.now();
const log = (...a: unknown[]) =>
  console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", ...a);
// Topic generation is unrelated to the turn under test.
claudeBackend.oneShotPrompt = async () => "Diagnostic";

let ui = initialState;
const mgr = createAgentManager({
  resolveBackend: () => claudeBackend,
  initialRooms: [],
  officeState: new OfficeState({
    rooms: [{ id: "diag", name: "diag", prompt: null, canCloseWhenEmpty: false }],
  }),
  eventSink: (e: any) => {
    if (e.type === "interaction_added" || e.type === "interaction_removed") {
      ui = reducer(ui, e);
      log(e.type, (e.interaction?.id ?? e.interactionId).slice(0, 8));
    }
    if (e.type === "log_entry" && e.entry.kind !== "text")
      log("log", e.entry.kind, String(e.entry.content).slice(0, 120).replace(/\n/g, " | "));
  },
});
mgr.configureAgentTurnDeps();
const info = (await mgr.spawn(
  "Diag", work, "default", undefined, undefined, "diag", undefined,
  process.env.DIAG_MODEL, "low", undefined, "claude",
))!;
let done = false;
void mgr
  .sendMessage(
    info.id,
    "Launch TWO general-purpose subagents IN PARALLEL in one message (two Agent tool calls, foreground, not background). " +
      "Subagent 1 must run the Bash command `echo alpha > /tmp/permprobe/a.txt`. " +
      "Subagent 2 must run the Bash command `echo beta > /tmp/permprobe/b.txt`. Wait for both, then say done.",
    "tester",
  )
  .then(() => { done = true; log("turn finished"); });

const visibleCard = () => ui.interactions.find((i) => i.agentId === info.id);
const serverIds = () => mgr.getPendingInteractions().map((i) => i.id.slice(0, 8));

async function clickVisible(label: string, clicks: number) {
  for (let n = 0; n < clicks && !done; n++) {
    const card = visibleCard();
    if (!card) return;
    // Alternate Allow once and Deny, like a member trying both.
    const choice = card.choices[n % 2 === 0 ? 1 : card.choices.length - 1];
    const r = mgr.respondToChoiceInteraction(info.id, card.id, choice.value, "tester");
    log(label, "click", card.id.slice(0, 8), JSON.stringify(choice.label), "->", r.ok ? "ok" : `${r.status} ${r.code}`, "| server has:", serverIds());
    await Bun.sleep(4000);
  }
}

// Wait until both requests reached the server.
const waitUntil = Date.now() + 90_000;
while (!done && Date.now() < waitUntil && ui.interactions.filter((i) => i.agentId === info.id).length < 2)
  await Bun.sleep(500);
log("UI cards for agent:", ui.interactions.filter((i) => i.agentId === info.id).map((i) => i.id.slice(0, 8)), "| server has:", serverIds());
await Bun.sleep(2000);
await clickVisible("live-UI", 4);
// Page reload: the UI state is rebuilt from the server's pending interactions.
ui = { ...initialState, interactions: mgr.getPendingInteractions() };
log("after reload, UI cards:", ui.interactions.map((i) => i.id.slice(0, 8)));
await clickVisible("reloaded-UI", 1);
await Bun.sleep(Number(process.env.DIAG_WAIT ?? 60_000));
log("RESULT", JSON.stringify({
  turnFinished: done,
  aWritten: await Bun.file(`${work}/a.txt`).exists(),
  bWritten: await Bun.file(`${work}/b.txt`).exists(),
  serverPendingInteractions: serverIds(),
  uiCardsAfterReload: ui.interactions.map((i) => i.id.slice(0, 8)),
}));
process.exit(done ? 0 : 3);
