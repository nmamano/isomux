import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export function normalizeTerminalProcess(value: string): string {
  return basename(value.trim()).replace(/^-/, "");
}

// tpgid is the controlling terminal's foreground process group, not the
// shell's own group. Both Linux procfs and macOS ps expose the kernel value.
export async function terminalOwner(shellPid: number): Promise<string | null> {
  try {
    let foreground: number;
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${shellPid}/stat`, "utf8");
      foreground = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
    } else {
      foreground = Number(await ps("tpgid=", shellPid));
    }
    if (!Number.isInteger(foreground) || foreground <= 0) return null;
    // Match node-pty's argv[0] on Linux; comm truncates names to 15 bytes.
    const name = process.platform === "linux"
      ? (await readFile(`/proc/${foreground}/cmdline`, "utf8")).split("\0")[0]
      : await ps("comm=", foreground);
    return normalizeTerminalProcess(name) || null;
  } catch {
    // The process can exit between the two reads. Never call an unknown
    // foreground owner a shell: command cards must not type into a program.
    return null;
  }
}

async function ps(column: string, pid: number): Promise<string> {
  const child = Bun.spawn(["/bin/ps", "-o", column, "-p", String(pid)], {
    stdout: "pipe", stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) return "";
  return output.trim();
}
