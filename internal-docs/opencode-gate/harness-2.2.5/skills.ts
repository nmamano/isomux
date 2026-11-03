// Task 6dca5910: which skill folders 2.2.5 reads (member-skill-folder.ts note). GET /api/skill.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const H = `${import.meta.dir}/../harness-2.1.4`
const { makeProfile, makeRepo, startServer, GATE_ROOT } = await import(`${H}/common.ts`)
const out: any = {}
for (const [name, bin] of [["2.1.4", process.env.GATE_V1_BIN], ["2.2.5", process.env.GATE_V2_BIN]] as const) {
  for (const flag of [false, true]) {
    const root = `${GATE_ROOT}/run/skills-${name}-${flag}-${Date.now()}`
    const p = makeProfile(root)
    const cfgDir = join(root, "member-config")
    const put = (dir: string, id: string) => { mkdirSync(join(dir, id), { recursive: true }); writeFileSync(join(dir, id, "SKILL.md"), `---\nname: ${id}\ndescription: probe ${id}\n---\nbody\n`) }
    put(join(p.home, ".claude", "skills"), "home-claude")
    put(join(p.home, ".agents", "skills"), "home-agents")
    put(join(cfgDir, "skill"), "cfg-skill")
    put(join(cfgDir, "skills"), "cfg-skills")
    put(join(p.config, "opencode", "skills"), "xdg-skills")
    const repo = makeRepo(join(root, "repo"))
    const s = await startServer(p, { bin, env: { OPENCODE_CONFIG_DIR: cfgDir, ...(flag ? { OPENCODE_DISABLE_CLAUDE_CODE: "1" } : {}) } })
    let ids: string[] = []
    for (let i = 0; i < 40; i++) {
      const r = await s.api("GET", `/api/skill?location[directory]=${encodeURIComponent(repo)}`)
      const rows = (r.body?.data ?? r.body ?? []) as any[]
      ids = Array.isArray(rows) ? rows.map((x: any) => x.id ?? x.name).filter((x: string) => /^(home|cfg|xdg)-/.test(x)).sort() : []
      if (ids.length) { await Bun.sleep(1000); const r2 = await s.api("GET", `/api/skill?location[directory]=${encodeURIComponent(repo)}`); ids = ((r2.body?.data ?? []) as any[]).map((x: any) => x.id ?? x.name).filter((x: string) => /^(home|cfg|xdg)-/.test(x)).sort(); break }
      await Bun.sleep(250)
    }
    out[`${name} DISABLE_CLAUDE_CODE=${flag}`] = ids
    await s.stop()
  }
}
console.log(JSON.stringify(out, null, 1))
