import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { evidenceRoot, saveJson } from "./common"

type GateEvent = {
  type: string
  properties: Record<string, any>
}

const files = ["v1-events-a.jsonl", "v1-events-b.jsonl"]
const events: GateEvent[] = []
for (const file of files) {
  const text = await readFile(join(evidenceRoot, file), "utf8")
  events.push(...text.trim().split("\n").map((line) => JSON.parse(line)))
}

const tools = new Map<string, { callIDs: Set<string>; statuses: string[]; terminal: string[] }>()
for (const event of events) {
  if (event.type !== "message.part.updated" || event.properties.part?.type !== "tool") continue
  const part = event.properties.part
  const item = tools.get(part.id) ?? { callIDs: new Set(), statuses: [], terminal: [] }
  if (part.callID) item.callIDs.add(part.callID)
  if (part.state?.status) item.statuses.push(part.state.status)
  if (part.state?.status === "completed" || part.state?.status === "error") item.terminal.push(part.state.status)
  tools.set(part.id, item)
}

const toolAssertions = [...tools.entries()].map(([partID, item]) => ({
  partID,
  callIDs: [...item.callIDs],
  statuses: item.statuses,
  terminal: item.terminal,
  callIDStable: item.callIDs.size === 1,
  terminalExactlyOnce: item.terminal.length === 1,
}))

const completionOrdering: Array<Record<string, unknown>> = []
for (let index = 0; index < events.length; index++) {
  const event = events[index]
  if (event.type !== "session.idle") continue
  const sessionID = event.properties.sessionID
  let previousPart: any
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = events[cursor]
    if (candidate.type === "message.part.updated" && candidate.properties.part?.sessionID === sessionID) {
      previousPart = candidate.properties.part
      break
    }
  }
  completionOrdering.push({
    index,
    sessionID,
    precedingPartType: previousPart?.type,
    precedingPartID: previousPart?.id,
    completionAfterStepFinish: previousPart?.type === "step-finish",
  })
}

await saveJson("v1-event-analysis.json", {
  toolAssertions,
  allCallIDsStable: toolAssertions.every((item) => item.callIDStable),
  allTerminalExactlyOnce: toolAssertions.every((item) => item.terminalExactlyOnce),
  completionOrdering,
  completedTurnSignalsAfterStepFinish: completionOrdering.filter((item) => item.completionAfterStepFinish).length,
  nonStepFinishIdleSignals: completionOrdering.filter((item) => !item.completionAfterStepFinish),
})
