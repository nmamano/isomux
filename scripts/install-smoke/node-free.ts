// Run inside a fresh office, as the account running it.
// No credentials or model calls. The SDK resolver is the production module.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
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
