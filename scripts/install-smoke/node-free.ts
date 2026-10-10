// Run inside a fresh installer/manual office, as the account running it.
// No credentials or model calls. The SDK resolver is the production module.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
if (!repo) throw new Error("Expected the installed checkout path");
for (const command of ["node", "npm", "npx"]) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 127)
    throw new Error(
      `Expected ${command} to be absent, exit=${result.status}: ${result.stdout}${result.stderr}`,
    );
  console.log(`PASS command -v ${command}: exit=${result.status}`);
}
const { CLAUDE_NATIVE_BIN } = await import(
  pathToFileURL(join(repo, "server/cwd-utils.ts")).href
);
const native = spawnSync(CLAUDE_NATIVE_BIN, ["--version"], {
  encoding: "utf8",
  timeout: 30_000,
});
if (native.status !== 0) throw new Error(`SDK Claude failed: ${native.stderr}`);
console.log(
  `PASS SDK Claude: ${native.stdout.trim()} (uid=${process.getuid?.()})`,
);
if (process.argv.includes("--standalone")) {
  if (process.env.ISOMUX_AGENT_RUNNER)
    throw new Error("The installer smoke expects the default local agent host");
  const { isClaudeCodeInstalled } = await import(
    pathToFileURL(join(repo, "server/backends/claude-install-check.ts")).href
  );
  if (!isClaudeCodeInstalled())
    throw new Error("Production Claude install check failed");
  console.log(
    "PASS production isClaudeCodeInstalled(): true (running service environment)",
  );
  const serviceCli = spawnSync(
    "/bin/sh",
    ["-c", "command -v claude && claude --version"],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (serviceCli.status !== 0)
    throw new Error(`Service-PATH Claude failed: ${serviceCli.stderr}`);
  console.log(`PASS service-PATH Claude: ${serviceCli.stdout.trim()}`);
  console.log(
    `PASS system launcher target: ${realpathSync("/usr/local/bin/claude")}`,
  );
  const cli = spawnSync(
    "/bin/bash",
    [
      "-lc",
      'command -v claude && readlink -f "$(command -v claude)" && claude --version',
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (cli.status !== 0)
    throw new Error(`Standalone Claude failed: ${cli.stderr}`);
  console.log(`PASS login-shell Claude: ${cli.stdout.trim()}`);
}
