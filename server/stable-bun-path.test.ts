// stableBunPath: the Bun path the server writes into files that outlive it (app
// unit PATH, the codex wrapper). Bun's process.execPath resolves a symlink, so
// a service started through a symlink into a versioned directory (Linuxbrew, a
// hand-made `ln -s`) would bake that versioned directory in, and every app
// would break at the next Bun upgrade (task 61e6e3fd).
//
// The rule cases use a fake realpath. The real-process cases pin the Bun
// behaviour the rule depends on: argv0 keeps the unresolved path, and
// `bun run <script>` puts its own bun-node-* shim directory first on PATH.

import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { stableBunPath, type StableBunPathInput } from "./stable-bun-path.ts";

const EXEC = "/opt/bun/1.3.11/bin/bun";

// Paths the fake filesystem knows, each to its resolved path. Anything else
// cannot be resolved (realpath returns null).
function input(
  over: Partial<StableBunPathInput>,
  links: Record<string, string> = {},
): StableBunPathInput {
  const table: Record<string, string> = { [EXEC]: EXEC, ...links };
  return {
    argv0: EXEC,
    execPath: EXEC,
    envPath: "/usr/bin:/bin",
    cwd: "/home/u",
    realpath: (path) => table[path] ?? null,
    ...over,
  };
}

describe("stableBunPath: the rule", () => {
  it("keeps an absolute argv0 that is a symlink to the running binary", () => {
    const got = stableBunPath(
      input(
        { argv0: "/home/linuxbrew/.linuxbrew/bin/bun" },
        { "/home/linuxbrew/.linuxbrew/bin/bun": EXEC },
      ),
    );
    expect(got).toBe("/home/linuxbrew/.linuxbrew/bin/bun");
  });

  it("resolves a relative argv0 against the start directory", () => {
    const got = stableBunPath(
      input(
        { argv0: "./tools/bun", cwd: "/srv/office" },
        { "/srv/office/tools/bun": EXEC },
      ),
    );
    expect(got).toBe("/srv/office/tools/bun");
  });

  it("finds a bare argv0 in the first usable PATH entry that runs this binary", () => {
    const got = stableBunPath(
      input(
        {
          argv0: "bun",
          envPath: [
            "", // empty entry: skipped
            "rel/bin", // relative entry: skipped
            "/tmp/bun-node-1001-38afee6c8", // Bun's run-script shim: skipped
            "/usr/local/other/bin", // a different bun
            "/home/linuxbrew/.linuxbrew/bin", // the one that runs us
            "/usr/local/bin", // also runs us, but later on PATH
          ].join(":"),
        },
        {
          "rel/bin/bun": EXEC,
          "/tmp/bun-node-1001-38afee6c8/bun": EXEC,
          "/usr/local/other/bin/bun": "/usr/local/other/bin/bun",
          "/home/linuxbrew/.linuxbrew/bin/bun": EXEC,
          "/usr/local/bin/bun": EXEC,
        },
      ),
    );
    expect(got).toBe("/home/linuxbrew/.linuxbrew/bin/bun");
  });

  it("skips Bun's shim directory even when it is the only PATH entry that matches", () => {
    const got = stableBunPath(
      input(
        { argv0: "bun", envPath: "/tmp/bun-node-1001-38afee6c8:/usr/bin" },
        { "/tmp/bun-node-1001-38afee6c8/bun": EXEC },
      ),
    );
    expect(got).toBe(EXEC);
  });

  it("falls back to execPath for a bare argv0 that no PATH entry resolves to", () => {
    expect(
      stableBunPath(input({ argv0: "bun", envPath: "/usr/bin:/bin" })),
    ).toBe(EXEC);
    expect(stableBunPath(input({ argv0: "bun", envPath: undefined }))).toBe(
      EXEC,
    );
  });

  it("falls back to execPath when argv0 is a different program (a version-manager shim)", () => {
    // mise/asdf: the shim is a script that execs the real binary, so argv0
    // resolves to the shim, not to the running Bun.
    const got = stableBunPath(
      input(
        { argv0: "/home/u/.local/share/mise/shims/bun" },
        {
          "/home/u/.local/share/mise/shims/bun":
            "/home/u/.local/share/mise/shims/bun",
        },
      ),
    );
    expect(got).toBe(EXEC);
  });

  it("falls back to execPath when argv0 cannot be resolved", () => {
    expect(stableBunPath(input({ argv0: "/gone/bun" }))).toBe(EXEC);
    expect(stableBunPath(input({ argv0: "" }))).toBe(EXEC);
  });

  it("returns execPath when argv0 is execPath (a regular file or a hardlink)", () => {
    expect(stableBunPath(input({}))).toBe(EXEC);
  });

  it("compares resolved paths, so a symlinked execPath directory still matches", () => {
    // execPath as Bun reports it can itself sit under a symlinked directory;
    // the comparison is between the two resolved paths, not against execPath.
    const got = stableBunPath(
      input(
        { argv0: "/usr/local/bin/bun", execPath: "/opt/bun/current/bin/bun" },
        {
          "/usr/local/bin/bun": EXEC,
          "/opt/bun/current/bin/bun": EXEC,
        },
      ),
    );
    expect(got).toBe("/usr/local/bin/bun");
  });
});

// --- real processes ----------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "stable-bun-path-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A directory whose only entry is a symlink to the Bun running this test.
const linkDir = join(scratch, "linkbin");
mkdirSync(linkDir);
const link = join(linkDir, "bun");
symlinkSync(process.execPath, link);

const moduleUrl = new URL("./stable-bun-path.ts", import.meta.url).pathname;

// The child prints what the rule needs and what it returned.
const probe = join(scratch, "probe.ts");
writeFileSync(
  probe,
  `import { stableBunPath } from ${JSON.stringify(moduleUrl)};
console.log(JSON.stringify({
  argv0: process.argv0,
  execPath: process.execPath,
  path0: (process.env.PATH ?? "").split(":")[0],
  got: stableBunPath(),
}));
`,
);

interface ProbeOut {
  argv0: string;
  execPath: string;
  path0: string;
  got: string;
}

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`child exited ${code}: ${err}`);
  return out;
}

const lastJson = <T>(out: string): T =>
  JSON.parse(out.trim().split("\n").at(-1) ?? "") as T;

describe("stableBunPath: real Bun processes", () => {
  it("returns the symlink a process was started through by absolute path", async () => {
    const out = lastJson<ProbeOut>(
      await run([link, probe], scratch, {
        HOME: process.env.HOME ?? scratch,
        PATH: "/usr/bin:/bin",
      }),
    );
    // Enabling conditions: Bun resolved the link for execPath and kept it in
    // argv0. Without both, this case proves nothing.
    expect(out.execPath).toBe(realpathSync(process.execPath));
    expect(out.execPath).not.toBe(link);
    expect(out.argv0).toBe(link);
    expect(out.got).toBe(link);
  });

  it("skips the bun-node shim of `bun run <script>` and finds the PATH link", async () => {
    const project = join(scratch, "project");
    mkdirSync(project);
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ scripts: { probe: `bun ${probe}` } }),
    );
    // Only the link directory on PATH, so there is no `node` and Bun adds its
    // shim directory (as on a self-hosted box without node, under `bun run dev`).
    const out = lastJson<ProbeOut>(
      await run([link, "run", "probe"], project, {
        HOME: process.env.HOME ?? scratch,
        PATH: linkDir,
      }),
    );
    // Enabling conditions: the child was found by a PATH lookup, and Bun's
    // shim directory came first on its PATH.
    expect(out.argv0).toBe("bun");
    expect(basename(out.path0).startsWith("bun-node-")).toBe(true);
    expect(out.got).toBe(link);
  });

  it("writes the start path into an app unit PATH and the codex wrapper", async () => {
    const home = join(scratch, "office");
    mkdirSync(home);
    const callers = join(scratch, "callers.ts");
    const server = dirname(moduleUrl);
    writeFileSync(
      callers,
      `import { join } from "path";
import { createAppSupervisor } from ${JSON.stringify(join(server, "app-supervisor.ts"))};
import { ensureCodexWrapperScript } from ${JSON.stringify(join(server, "backends/codex/native-bin.ts"))};
import { STATE_ROOT } from ${JSON.stringify(join(server, "config.ts"))};
const files = new Map<string, string>();
const supervisor = createAppSupervisor({
  host: {
    unitDir: "/units",
    launcherDir: "/launchers",
    writeFile: (path, contents) => void files.set(path, contents),
    readFile: (path) => files.get(path) ?? null,
    removeFile: (path) => void files.delete(path),
    run: () => ({ code: 0, stdout: "", stderr: "" }),
  },
  unitPrefix: "isomux-app-test-",
  appHostDomain: () => null,
  secretsDir: join(STATE_ROOT, "secrets"),
});
try {
  supervisor.install({
    name: "hello", hostLabel: "hello", hostGen: 1, port: 21000,
    command: "true", cwd: "/", dataDir: join(STATE_ROOT, "data"),
    userId: "u1", username: "U", createdBy: "A", createdAt: 1,
  });
} catch {
  // The fake systemd answers nothing useful; the unit is written first.
}
ensureCodexWrapperScript();
const unit = [...files].find(([path]) => path.endsWith(".service"))?.[1] ?? "";
console.log(JSON.stringify({
  execPath: process.execPath,
  unit,
  wrapper: await Bun.file(join(STATE_ROOT, "bin", "codex")).text(),
}));
`,
    );
    const out = lastJson<{ execPath: string; unit: string; wrapper: string }>(
      await run([link, callers], scratch, {
        HOME: process.env.HOME ?? scratch,
        PATH: "/usr/bin:/bin",
        ISOMUX_HOME: home,
      }),
    );
    // Enabling condition: the child's execPath is the resolved binary, not
    // the link, so a caller that used execPath would write another directory.
    expect(dirname(out.execPath)).not.toBe(linkDir);

    const pathLine = out.unit
      .split("\n")
      .find((line) => line.includes("PATH="));
    expect(pathLine).toBeDefined();
    const dirs = (pathLine ?? "").replace(/^.*PATH=/, "").replace(/"$/, "");
    expect(dirs.split(":")).toContain(linkDir);

    const execLine = out.wrapper
      .split("\n")
      .find((line) => line.startsWith("exec "));
    expect(execLine?.split(" ")[1]).toBe(`'${link}'`);
  });
});
