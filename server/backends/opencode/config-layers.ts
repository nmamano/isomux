import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OPENCODE_CLI_VERSION } from "./runtime.ts";

// A member's user-level OpenCode plugins and config: their OPENCODE_CONFIG_DIR
// when it is an absolute path, else the directory a stock OpenCode install
// reads for the OS user. The server's own XDG directories stay per profile,
// so start-server.ts hands this one to OpenCode as OPENCODE_CONFIG_DIR.
export function openCodeUserConfigDir(
  env: Record<string, string | undefined>,
): string {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim();
  if (explicit && isAbsolute(explicit)) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"),
    "opencode",
  );
}

// Isomux's config also goes in OPENCODE_CONFIG_CONTENT, the layer OpenCode
// merges after user and project config, so Isomux's permissions, agents and
// MCP endpoints win over theirs, and its plugin loads last. The environment is
// readable in /proc, so the MCP headers stay out of it: the config file, a
// lower layer, supplies them.
export function openCodeConfigOverride(
  config: Record<string, unknown>,
  safetyPlugin: string,
): Record<string, unknown> {
  const plugin = [
    ...(Array.isArray(config.plugin) ? config.plugin : []),
    safetyPlugin,
  ];
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") return { ...config, plugin };
  return {
    ...config,
    plugin,
    mcp: Object.fromEntries(
      Object.entries(mcp as Record<string, unknown>).map(([name, entry]) => {
        if (!entry || typeof entry !== "object") return [name, entry];
        const { headers: _headers, ...rest } = entry as Record<string, unknown>;
        return [name, rest];
      }),
    ),
  };
}

// OpenCode 1.18.35 skips its plugin SDK install in a config folder whose
// node_modules exists and whose lock names the SDK. For a folder whose plugins
// import nothing; a folder that already has node_modules is left alone.
export async function markPluginSdkInstalled(dir: string): Promise<void> {
  if (existsSync(join(dir, "node_modules"))) return;
  const dependencies = { "@opencode-ai/plugin": OPENCODE_CLI_VERSION };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies }));
  await writeFile(
    join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies } } }),
  );
  // Last: OpenCode checks for this folder first.
  await mkdir(join(dir, "node_modules"));
}
