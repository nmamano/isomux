import { afterEach, describe, expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { assertOpenCodeServerStopped, preserveOpenCodeAuthProviders } from "./login-runner.ts"
import { ensureOpenCodeLoginWrapper } from "./login-wrapper.ts"
import { expectRejection } from "../../test-support/expect-rejection.ts"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("OpenCode exact-profile authentication install", () => {
  it("restores prior providers after exact-profile login", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-auth-preserve-"))
    scratch.push(root)
    const profile = join(root, "profile")
    const authDir = join(profile, "data", "opencode")
    await mkdir(authDir, { recursive: true })
    const before = join(root, "before.json")
    await writeFile(before, JSON.stringify({ openai: { type: "api", key: "first" } }), { mode: 0o600 })
    await writeFile(
      join(authDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "api", key: "second" } }),
      { mode: 0o600 },
    )
    await preserveOpenCodeAuthProviders(profile, before, "anthropic")
    const target = join(authDir, "auth.json")
    const installed = JSON.parse(await readFile(target, "utf8"))
    expect(Object.keys(installed).sort()).toEqual(["anthropic", "openai"])
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect(await Bun.file(join(profile, "server.replace")).text()).toBe("authentication changed\n")
  })

  it("refuses exact-profile output that lacks the requested provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-auth-provider-"))
    scratch.push(root)
    const profile = join(root, "profile")
    const authDir = join(profile, "data", "opencode")
    await mkdir(authDir, { recursive: true })
    const before = join(root, "before.json")
    await writeFile(before, "{}", { mode: 0o600 })
    await writeFile(
      join(authDir, "auth.json"),
      JSON.stringify({ other: { type: "api", key: "value" } }),
      { mode: 0o600 },
    )
    await expectRejection(
      preserveOpenCodeAuthProviders(profile, before, "openai"),
      /did not create the requested openai credential/,
    )
  })

  it("generates a locked readable wrapper with mode 0700", async () => {
    const wrapper = ensureOpenCodeLoginWrapper("wrapper-test")
    const source = await readFile(wrapper, "utf8")
    const runner = join(wrapper.slice(0, wrapper.lastIndexOf("/")), "opencode-login-runner.ts")
    expect(source).toContain("flock --exclusive")
    expect(source).toContain("login-runner.ts")
    expect(source).toContain("provider=openai")
    expect(source).toContain("OPENCODE_[A-Za-z0-9_]*")
    expect(source).toContain('unset "$name"')
    expect(source).toContain("--preserve")
    expect(source).toContain("--assert-stopped")
    expect(spawnSync("/bin/sh", ["-n", wrapper]).status).toBe(0)
    expect((await stat(wrapper)).mode & 0o777).toBe(0o700)
    expect((await stat(runner)).mode & 0o777).toBe(0o700)
    await chmod(wrapper, 0o700)
  })

  it("fails fast when the shared server restarted before login", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-opencode-auth-running-"))
    scratch.push(root)
    await writeFile(join(root, "server.lock"), JSON.stringify({ pid: process.pid }))
    await expectRejection(assertOpenCodeServerStopped(root), /get a fresh login command/)
    await writeFile(join(root, "server.lock"), JSON.stringify({ pid: 999_999_999 }))
    await assertOpenCodeServerStopped(root)
  })
})
