// Test instrument, loaded with `bun --preload` in a child office (see
// server/boot-codex-prep.test.ts): the Codex safety-hook build never ends. It
// runs `sleep` in place of `bun build --compile` and writes that child's pid
// to $HANG_PID_FILE, so the test can show the build still runs. Every other
// spawn passes through.
import { writeFileSync } from "fs";

const spawn = Bun.spawn;
(Bun as { spawn: unknown }).spawn = (
  cmd: string[] | { cmd: string[] },
  options?: object,
) => {
  const argv = Array.isArray(cmd) ? cmd : cmd.cmd;
  if (
    argv.includes("--compile") &&
    argv.some((arg) => arg.endsWith("safety-hook.ts"))
  ) {
    const child = spawn(["sleep", "600"], { ...options });
    writeFileSync(process.env.HANG_PID_FILE!, String(child.pid));
    return child;
  }
  return (spawn as (...args: unknown[]) => unknown)(cmd, options);
};
