import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCodeUnsupportedReason, resolveOpenCodeBinary } from "./runtime.ts";
import { OpenCodeSupervisor } from "./supervisor.ts";
import { OpenCodeTransport } from "./transport.ts";
import type { NormalizedEvent } from "../types.ts";

const repoRoot = join(import.meta.dir, "../../..");
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "isomux-opencode-platform-"));
  scratch.push(path);
  return path;
}

describe("OpenCode on a non-Linux host", () => {
  it("is supported only on Linux", () => {
    expect(openCodeUnsupportedReason("linux")).toBeNull();
    for (const platform of ["darwin", "win32"] as const) {
      const reason = openCodeUnsupportedReason(platform);
      expect(reason).not.toBeNull();
      expect(() => resolveOpenCodeBinary(platform)).toThrow(reason!);
    }
  });

  it("refuses a lease with the reason and touches nothing on disk", async () => {
    const profileDir = join(await root(), "profile");
    const supervisor = new OpenCodeSupervisor({
      profileDir,
      platform: "darwin",
    });
    const refusal = await supervisor.acquire().then(
      () => null,
      (error: unknown) => (error as Error).message,
    );
    expect(refusal).toBe(openCodeUnsupportedReason("darwin"));
    await supervisor.shutdown();
    expect(existsSync(profileDir)).toBe(false);
  });

  it("fails a turn with the reason, not a reduced error name", async () => {
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(await root(), "profile"),
      platform: "darwin",
    });
    const transport = new OpenCodeTransport({
      supervisor,
      cwd: await root(),
      model: "provider/model",
      systemPrompt: "system",
    });
    const events: NormalizedEvent[] = [];
    await transport.send([{ type: "text", text: "go" }], (event) =>
      events.push(event),
    );
    expect(events).toEqual([
      {
        kind: "turn_completed",
        status: "failed",
        error: openCodeUnsupportedReason("darwin")!,
      },
    ]);
  });

  // The office crashed at boot on macOS because the default supervisor
  // resolved the Linux binary when its module loaded. Load every backend in a
  // process that reports darwin.
  it("loads every backend module on darwin", async () => {
    const dir = await root();
    const preload = join(dir, "darwin.ts");
    await writeFile(
      preload,
      'Object.defineProperty(process, "platform", { value: "darwin" });\n',
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        "-e",
        `await import(${JSON.stringify(join(repoRoot, "server/backends/index.ts"))}); console.log(process.platform);`,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ISOMUX_HOME: join(dir, "home") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout.trim()).toBe("darwin");
  }, 30_000);
});
