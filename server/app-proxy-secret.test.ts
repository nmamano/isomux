// The per-app proxy secret (task 4b3adf60): an HMAC under one office key of
// the app's registration, so it changes only when the app is registered
// again. The relay and the secrets file both use it; the chain is pinned in
// test-support/app-member-headers.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appProxyKeyPath,
  appProxySecret,
  appProxySecretsOf,
  loadOrCreateAppProxyKey,
} from "./app-proxy-secret.ts";
import type { AppRecord } from "../shared/types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "isomux-app-proxy-secret-"));
  roots.push(root);
  return root;
}

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

describe("appProxySecret", () => {
  it("is the same for the same key and registration, and differs when either changes", () => {
    const bot = { name: "bot", createdAt: 1700000000000 };
    const secret = appProxySecret(KEY_A, bot);
    // Header- and env-file-safe.
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(appProxySecret(KEY_A, { ...bot })).toBe(secret);
    const others = [
      appProxySecret(KEY_B, bot),
      appProxySecret(KEY_A, { ...bot, name: "web" }),
      appProxySecret(KEY_A, { ...bot, createdAt: bot.createdAt + 1 }),
      // Name and time are kept apart: "a1" at 23 is not "a" at 123.
      appProxySecret(KEY_A, { name: "a1", createdAt: 23 }),
      appProxySecret(KEY_A, { name: "a", createdAt: 123 }),
    ];
    expect(new Set([secret, ...others]).size).toBe(others.length + 1);
  });
});

describe("loadOrCreateAppProxyKey", () => {
  it("makes a 32-byte key, 0600 in a 0700 directory, and reads the same key back", () => {
    const path = appProxyKeyPath(tempRoot());
    const key = loadOrCreateAppProxyKey(path);
    expect(key.length).toBe(32);
    expect(readFileSync(path).equals(key)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(loadOrCreateAppProxyKey(path).equals(key)).toBe(true);
  });

  it("replaces a stored key of the wrong length", () => {
    const root = tempRoot();
    const path = appProxyKeyPath(root);
    loadOrCreateAppProxyKey(path);
    const short = Buffer.alloc(16, 7);
    writeFileSync(path, short, { mode: 0o644 });
    const key = loadOrCreateAppProxyKey(path);
    expect(key.length).toBe(32);
    expect(readFileSync(path).equals(key)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("appProxySecretsOf", () => {
  it("gives the secret of each app, and nothing for one whose secret throws", () => {
    const apps = ["bot", "broken", "web"].map(
      (name, i) => ({ name, createdAt: i }) as AppRecord,
    );
    const secrets = appProxySecretsOf(apps, (a) => {
      if (a.name === "broken") throw new Error("fake key unreadable");
      return `fake-proxy-${a.name}`;
    });
    expect([...secrets].sort()).toEqual(["fake-proxy-bot", "fake-proxy-web"]);
  });
});

// The production secret, in a process of its own: the key is cached per
// process, and STATE_ROOT is fixed at import, so this cannot run in the test
// process.
describe("productionAppProxySecret", () => {
  it("tries the key again after a failure, and uses the key at its path under the state root", () => {
    const home = tempRoot();
    const script = join(tempRoot(), "probe.ts");
    const module = fileURLToPath(
      new URL("./app-proxy-secret.ts", import.meta.url),
    );
    writeFileSync(
      script,
      `import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productionAppProxySecret } from ${JSON.stringify(module)};
const app = { name: "bot", createdAt: 5 };
// secrets/ is a file: the key can be neither read nor made.
const blocker = join(process.env.ISOMUX_HOME!, "secrets");
writeFileSync(blocker, "x");
let first = "returned";
try {
  productionAppProxySecret(app);
} catch {
  first = "threw";
}
rmSync(blocker);
console.log(JSON.stringify({ first, second: productionAppProxySecret(app) }));
`,
    );
    const run = spawnSync(process.execPath, [script], {
      cwd: dirname(script),
      env: { ...process.env, ISOMUX_HOME: home },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect({ status: run.status, stderr: run.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    const out = JSON.parse(run.stdout) as { first: string; second: string };
    expect(out.first).toBe("threw");
    const key = readFileSync(appProxyKeyPath(home));
    expect(out.second).toBe(appProxySecret(key, { name: "bot", createdAt: 5 }));
  });
});
