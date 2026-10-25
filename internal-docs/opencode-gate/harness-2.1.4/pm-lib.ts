// pm probes (task 4840abc5): shared helpers on top of common.ts.
import { prompt, turnEnded, type EventTap, type Server } from "./common.ts"

export const AGENTS = ["build", "isomux-interactive-bypass", "isomux-cron"] as const

const r = (action: string, effect: "allow" | "ask" | "deny", resource = "*") => ({ action, resource, effect })

// supervisor.ts:42-77 mapped to v2 names. `literal` is a key-for-key rename;
// `proposed` adds the external_directory ask that v1 gave by default.
export function isomuxV2Config(variant: "literal" | "proposed"): Record<string, unknown> {
  const top = [r("shell", "ask"), r("edit", "ask"), r("question", "deny"), r("isomux_safety_active", "deny")]
  if (variant === "proposed") top.push(r("external_directory", "ask"))
  return {
    update: "disable",
    default_agent: "build",
    permissions: top,
    agents: {
      build: { permissions: [r("shell", "ask"), r("edit", "ask"), r("question", "deny")] },
      "isomux-interactive-bypass": {
        description: "Isomux interactive non-asking agent",
        mode: "primary",
        permissions: [r("shell", "ask"), r("edit", "ask"), r("subagent", "allow"), r("question", "deny")],
      },
      "isomux-cron": {
        description: "Isomux unattended cron run",
        mode: "primary",
        permissions: [r("shell", "ask"), r("edit", "ask"), r("subagent", "deny"), r("question", "deny")],
      },
    },
  }
}

export function gateCall(tool: string, args: unknown) {
  return `run GATE_CALL:${JSON.stringify({ tool, args })}`
}

export interface CallResult {
  asks: Array<{ session: string; action: string; resources: string[]; save?: string[]; decision: string }>
  tools: Array<{ session: string; type: string; error?: string; output?: string }>
  end: string
  outcome: string
  children: string[]
}

// Sends one prompt and drives it to the end of the turn. Each permission.asked
// in the session or its children is answered with `reply` (up to maxAsks, then reject).
export async function runCall(
  s: Server,
  tap: EventTap,
  sid: string,
  text: string,
  opts: { reply?: "once" | "reject" | "always"; maxAsks?: number; timeoutMs?: number; onAsk?: (a: any) => Promise<string | undefined> } = {},
): Promise<CallResult> {
  const reply = opts.reply ?? "once"
  const maxAsks = opts.maxAsks ?? 4
  const asks: CallResult["asks"] = []
  const tools: CallResult["tools"] = []
  const children = new Set<string>()
  const parentOf = new Map<string, string | null>()
  const inTree = async (id: string | undefined) => {
    if (!id) return false
    if (id === sid || children.has(id)) return true
    if (!parentOf.has(id)) {
      const g = await s.api("GET", `/api/session/${id}`)
      parentOf.set(id, g.body?.data?.parentID ?? g.body?.parentID ?? null)
    }
    const p = parentOf.get(id)
    if (p && (p === sid || children.has(p))) {
      children.add(id)
      return true
    }
    return false
  }
  let i = tap.events.length
  await prompt(s, sid, text)
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000)
  let end = "timeout"
  outer: while (Date.now() < deadline) {
    while (i < tap.events.length) {
      const e = tap.events[i++]
      const d = e.data ?? {}
      if (e.type === "permission.asked" && (await inTree(d.sessionID))) {
        let decision = asks.length >= maxAsks ? "reject" : reply
        if (opts.onAsk) decision = (await opts.onAsk(d)) ?? decision
        asks.push({ session: d.sessionID === sid ? "self" : "child", action: d.action, resources: d.resources, save: d.save, decision })
        const rr = await s.api("POST", `/api/session/${d.sessionID}/permission/${d.id}/reply`, { decision })
        if (rr.status >= 300) asks[asks.length - 1].decision += ` (reply HTTP ${rr.status})`
      }
      if ((e.type === "session.tool.success" || e.type === "session.tool.failed") && (await inTree(d.sessionID))) {
        const out = Array.isArray(d.content) ? d.content.map((c: any) => c.text ?? "").join("").slice(0, 200) : undefined
        tools.push({ session: d.sessionID === sid ? "self" : "child", type: e.type, error: d.error?.message?.slice(0, 300), output: out })
      }
      if (e.type === "session.created" && (await inTree(d.sessionID)) && d.sessionID !== sid) children.add(d.sessionID)
      if (turnEnded(sid)(e)) {
        end = e.type
        break outer
      }
    }
    await Bun.sleep(40)
  }
  const selfTool = tools.find((t) => t.session === "self")
  let outcome: string
  if (asks.length > 0) outcome = "ask:" + asks.map((a) => `${a.session === "child" ? "child." : ""}${a.action}`).join(",")
  else if (selfTool?.type === "session.tool.success") outcome = "allow"
  else if (selfTool?.type === "session.tool.failed") {
    const m = selfTool.error ?? ""
    outcome = /No tool named/.test(m) ? "deny(tool removed)" : /denied|Permission/i.test(m) ? "deny" : "failed:other"
  } else outcome = "no-tool-event"
  return { asks, tools, end, outcome, children: [...children] }
}

export function redact(v: unknown, pw: string[]): unknown {
  let t = JSON.stringify(v)
  for (const p of pw) if (p) t = t.split(p).join("<redacted-password>")
  return JSON.parse(t)
}
