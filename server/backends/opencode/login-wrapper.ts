import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { STATE_ROOT } from "../../config.ts";
import { resolveOpenCodeBinary } from "./runtime.ts";

export interface OpenCodeProfilePaths {
  profileDir: string;
  configPath: string;
  home: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
}

export function openCodeProfilePaths(
  environmentKey: string,
): OpenCodeProfilePaths {
  if (!environmentKey)
    throw new Error("OpenCode session environment identity is required.");
  const key = createHash("sha256")
    .update(environmentKey)
    .digest("hex")
    .slice(0, 16);
  const profileDir = join(STATE_ROOT, "opencode", "profiles", key);
  return {
    profileDir,
    configPath: join(profileDir, "opencode.json"),
    home: join(profileDir, "home"),
    configHome: join(profileDir, "config"),
    dataHome: join(profileDir, "data"),
    stateHome: join(profileDir, "state"),
    cacheHome: join(profileDir, "cache"),
  };
}

export function ensureOpenCodeLoginWrapper(
  environmentKey: string,
  provider: string,
): string {
  const paths = openCodeProfilePaths(environmentKey);
  const wrapperDir = join(STATE_ROOT, "bin");
  const profileName = paths.profileDir.slice(
    paths.profileDir.lastIndexOf("/") + 1,
  );
  if (!/^[a-zA-Z0-9._-]+$/.test(provider))
    throw new Error("OpenCode provider id is invalid.");
  const wrapperPath = join(
    wrapperDir,
    `opencode-login-${profileName}-${provider}`,
  );
  const lockPath = join(paths.profileDir, "auth.login.lock");
  const pendingPath = `${paths.profileDir}.auth-login-pending`;
  const runner = join(wrapperDir, "opencode-login-runner.ts");
  const source = `#!/bin/sh
set -eu
profile=${quoteShellWord(paths.profileDir)}
runner=${quoteShellWord(runner)}
bun=${quoteShellWord(process.execPath)}
binary=${quoteShellWord(resolveOpenCodeBinary())}
provider=${quoteShellWord(provider)}
pending=${quoteShellWord(pendingPath)}
mkdir -p "$profile"
exec 9>${quoteShellWord(lockPath)}
flock --exclusive 9
staging=$(mktemp -d "\${profile}.login-XXXXXXXX")
cleanup() {
  rm -f -- "$pending"
  rm -rf -- "$staging"
}
trap cleanup EXIT HUP INT TERM
chmod 700 "$staging"
before="$staging/auth.before.json"
if [ -f "$profile/data/opencode/auth.json" ]; then
  cp "$profile/data/opencode/auth.json" "$before"
  chmod 600 "$before"
fi
for name in $(env | sed -n 's/^\\(OPENCODE_[A-Za-z0-9_]*\\)=.*/\\1/p'); do
  unset "$name"
done
export HOME=${quoteShellWord(paths.home)}
export XDG_CONFIG_HOME=${quoteShellWord(paths.configHome)}
export XDG_DATA_HOME=${quoteShellWord(paths.dataHome)}
export XDG_STATE_HOME=${quoteShellWord(paths.stateHome)}
export XDG_CACHE_HOME=${quoteShellWord(paths.cacheHome)}
export OPENCODE_CONFIG=${quoteShellWord(paths.configPath)}
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_PROJECT_CONFIG=1
export OPENCODE_DISABLE_CLAUDE_CODE=1
cd "$profile"
"$bun" run "$runner" --assert-stopped "$profile"
"$binary" auth login --provider "$provider" --method "Manually enter API Key"
"$bun" run "$runner" --preserve "$profile" "$before" "$provider"
`;
  mkdirSync(wrapperDir, { recursive: true });
  mkdirSync(paths.profileDir, { recursive: true });
  writeFileSync(
    runner,
    readFileSync(join(import.meta.dir, "login-runner.ts")),
    { mode: 0o700 },
  );
  chmodSync(runner, 0o700);
  writeFileSync(wrapperPath, source, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  return wrapperPath;
}

export function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
