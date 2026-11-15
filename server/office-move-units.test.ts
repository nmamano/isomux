// The office user's own systemd user units at a move (task 78733adf, slice 1;
// SRE items 4 and 5). The runner is an emulator of `systemctl` and
// `systemd-run` over a unit table, not a script of expected argv: the code may
// ask systemctl any way it likes, and the tests read the units' state after.
// An argv the emulator does not know answers exit 1 with "unknown", so a gap
// shows as a red test, never as a silent pass.
//
// Never the real user manager: these names would be real units on this box.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "./app-supervisor.ts";
import {
  listAgentUnits,
  MOVE_UNITS_FILE,
  officeRestartPolicy,
  restoreUnitsAfterMove,
  stopUnitsForMove,
  type UnitContext,
} from "./office-move-units.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function stateRoot(): string {
  dir = mkdtempSync(join(tmpdir(), "office-move-units-"));
  const root = join(dir, ".isomux");
  mkdirSync(root);
  return root;
}

const HOME = "/home/isomux";
const UID = 1001;
const CTX: UnitContext = {
  home: HOME,
  appPrefix: "isomux-app-",
  officeUnit: "isomux.service",
  uid: UID,
};

interface FakeUnit {
  name: string;
  fragmentPath: string;
  unitFileState: string;
  activeState: "active" | "inactive" | "failed";
  /** For a transient unit: the command it runs. */
  argv?: string[];
  workingDirectory?: string;
  environment?: string[];
  restart?: string;
  /** A template file (foo@.service) is in list-unit-files only, and show
   *  refuses its name; a running instance (foo@x.service) is in list-units
   *  only. */
  kind?: "template" | "instance";
}

interface Emulator {
  run: (argv: string[]) => RunResult;
  unit(name: string, scope?: "user" | "system"): FakeUnit | undefined;
  /** Every argv that changed a unit (enable, disable, start, stop, run). */
  changes: string[][];
  /** Called before each change; a test checks what is on disk then. */
  beforeChange?: (argv: string[]) => void;
  /** Units whose change exits 1 (the change is not applied). */
  failing: Set<string>;
}

const transientPath = (name: string) =>
  `/run/user/${UID}/systemd/transient/${name}`;

function emulator(user: FakeUnit[], system: FakeUnit[] = []): Emulator {
  const tables = {
    user: new Map(user.map((u) => [u.name, { ...u }])),
    system: new Map(system.map((u) => [u.name, { ...u }])),
  };
  const em: Emulator = {
    changes: [],
    failing: new Set(),
    unit: (name, scope = "user") => tables[scope].get(name),
    run: (argv) => {
      const unknown = (): RunResult => ({
        code: 1,
        stdout: "",
        stderr: `emulator: unknown argv ${JSON.stringify(argv)}`,
      });
      if (argv[0] === "systemd-run") return systemdRun(argv.slice(1));
      if (argv[0] !== "systemctl") return unknown();
      let scope: "user" | "system" = "system";
      const props: string[] = [];
      const types: string[] = [];
      const positional: string[] = [];
      let value = false;
      let all = false;
      let now = false;
      const args = argv.slice(1);
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--user") scope = "user";
        else if (a === "--system") scope = "system";
        else if (
          [
            "--no-legend",
            "--no-pager",
            "--plain",
            "--full",
            "-l",
            "--quiet",
            "-q",
            "--no-block",
            "--no-ask-password",
          ].includes(a)
        ) {
          // Output-only flags.
        } else if (a === "--all" || a === "-a") all = true;
        else if (a === "--value") value = true;
        else if (a === "--now") now = true;
        else if (a === "-p" || a === "--property")
          props.push(...args[++i].split(","));
        else if (a.startsWith("--property="))
          props.push(...a.slice("--property=".length).split(","));
        else if (a.startsWith("-p") && a.length > 2)
          props.push(...a.slice(2).split(","));
        else if (a === "-t" || a === "--type")
          types.push(...args[++i].split(","));
        else if (a.startsWith("--type="))
          types.push(...a.slice("--type=".length).split(","));
        else if (a.startsWith("-")) return unknown();
        else positional.push(a);
      }
      const table = tables[scope];
      const [verb, ...names] = positional;
      const typeOk = (n: string) =>
        types.length === 0 || types.some((t) => n.endsWith(`.${t}`));
      const listed = [...table.values()].filter((u) => typeOk(u.name));
      if (verb === "list-unit-files") {
        const rows = listed.filter(
          (u) =>
            u.kind !== "instance" &&
            (names.length === 0 || names.some((p) => globMatch(p, u.name))),
        );
        return ok(rows.map((u) => `${u.name} ${u.unitFileState} -`).join("\n"));
      }
      if (verb === "list-units") {
        const rows = listed.filter(
          (u) =>
            u.kind !== "template" &&
            (all || u.activeState !== "inactive") &&
            (names.length === 0 || names.some((p) => globMatch(p, u.name))),
        );
        return ok(
          rows
            .map(
              (u) =>
                `${u.name} loaded ${u.activeState} ${u.activeState === "active" ? "running" : "dead"} ${u.name}`,
            )
            .join("\n"),
        );
      }
      if (verb === "show") {
        // systemd fails the whole call on a template name (seen on this
        // box, 2026-11-15, Isomux Worker 1).
        const template = names.find((n) => table.get(n)?.kind === "template");
        if (template)
          return {
            code: 1,
            stdout: "",
            stderr: `Failed to get properties: Unit name ${template} is neither a valid invocation ID nor unit name.`,
          };
        const blocks = names.map((n) => {
          const u = table.get(n);
          const all: Record<string, string> = u
            ? {
                Id: u.name,
                Names: u.name,
                LoadState: "loaded",
                FragmentPath: u.fragmentPath,
                UnitFileState: u.unitFileState,
                ActiveState: u.activeState,
                SubState: u.activeState === "active" ? "running" : "dead",
                Transient: u.fragmentPath.startsWith("/run/") ? "yes" : "no",
                Restart: u.restart ?? "no",
                WorkingDirectory: u.workingDirectory ?? "",
                // As systemd prints it: an entry with a space, a quote or a
                // backslash in double quotes.
                Environment: (u.environment ?? [])
                  .map((e) =>
                    /[\s"\\]/.test(e)
                      ? `"${e.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
                      : e,
                  )
                  .join(" "),
                ExecStart: u.argv
                  ? `{ path=${u.argv[0]} ; argv[]=${u.argv.join(" ")} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`
                  : "",
              }
            : {
                Id: n,
                Names: n,
                LoadState: "not-found",
                FragmentPath: "",
                UnitFileState: "",
                ActiveState: "inactive",
                SubState: "dead",
                Transient: "no",
                Restart: "no",
                WorkingDirectory: "",
                Environment: "",
                ExecStart: "",
              };
          const keys = props.length > 0 ? props : Object.keys(all);
          return keys
            .map((k) => (value ? (all[k] ?? "") : `${k}=${all[k] ?? ""}`))
            .join("\n");
        });
        return ok(blocks.join("\n\n"));
      }
      if (verb === "cat") {
        // As systemd prints it: a "# <path>" line, then the file.
        const out: string[] = [];
        for (const n of names) {
          const u = table.get(n);
          if (!u)
            return { code: 1, stdout: "", stderr: `No files found for ${n}.` };
          out.push(`# ${u.fragmentPath}`, fragmentText(u));
        }
        return ok(out.join("\n"));
      }
      if (["enable", "disable", "start", "stop", "restart"].includes(verb)) {
        em.beforeChange?.(argv);
        em.changes.push(argv);
        let code = 0;
        for (const n of names) {
          const u = table.get(n);
          if (!u || em.failing.has(n)) {
            code = 1;
            continue;
          }
          if (verb === "enable") {
            // A static unit has no [Install]: systemd warns and changes
            // nothing. A disabled or linked one becomes enabled.
            if (["disabled", "linked"].includes(u.unitFileState))
              u.unitFileState = "enabled";
            if (now) u.activeState = "active";
          } else if (verb === "disable") {
            // Disable removes the enable links, and a linked unit's link.
            if (
              ["enabled", "linked", "enabled-runtime"].includes(u.unitFileState)
            )
              u.unitFileState = "disabled";
            if (now) u.activeState = "inactive";
          } else if (verb === "start" || verb === "restart") {
            u.activeState = "active";
          } else {
            u.activeState = "inactive";
            // A stopped transient unit is gone.
            if (u.fragmentPath.startsWith("/run/")) table.delete(n);
          }
        }
        return { code, stdout: "", stderr: code ? "emulator: failed" : "" };
      }
      return unknown();
    },
  };

  function systemdRun(args: string[]): RunResult {
    em.beforeChange?.(["systemd-run", ...args]);
    em.changes.push(["systemd-run", ...args]);
    let scope: "user" | "system" = "system";
    let unit = "";
    let wd: string | undefined;
    const env: string[] = [];
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "--") {
        i++;
        break;
      }
      if (!a.startsWith("-")) break;
      if (a === "--user") scope = "user";
      else if (
        [
          "--collect",
          "-G",
          "--quiet",
          "-q",
          "--no-block",
          "--same-dir",
          "-d",
        ].includes(a)
      ) {
        if (a === "--same-dir" || a === "-d") wd = "(same-dir)";
      } else if (a === "--unit" || a === "-u") unit = args[++i];
      else if (a.startsWith("--unit=")) unit = a.slice("--unit=".length);
      else if (a.startsWith("--working-directory="))
        wd = a.slice("--working-directory=".length);
      else if (a === "--working-directory") wd = args[++i];
      else if (a === "-E" || a === "--setenv") env.push(args[++i]);
      else if (a.startsWith("--setenv=")) env.push(a.slice("--setenv=".length));
      else if (
        a === "-p" ||
        a === "--property" ||
        a.startsWith("--property=")
      ) {
        const p = a.startsWith("--property=")
          ? a.slice("--property=".length)
          : args[++i];
        if (p.startsWith("WorkingDirectory="))
          wd = p.slice("WorkingDirectory=".length);
        else if (p.startsWith("Environment="))
          env.push(...p.slice("Environment=".length).split(" "));
        else
          return {
            code: 1,
            stdout: "",
            stderr: `emulator: unknown property ${p}`,
          };
      } else
        return { code: 1, stdout: "", stderr: `emulator: unknown option ${a}` };
    }
    const argv = args.slice(i);
    if (!unit || argv.length === 0 || em.failing.has(`run:${unit}`))
      return { code: 1, stdout: "", stderr: "emulator: systemd-run refused" };
    const name = unit.includes(".") ? unit : `${unit}.service`;
    tables[scope].set(name, {
      name,
      fragmentPath: transientPath(name),
      unitFileState: "transient",
      activeState: "active",
      argv,
      workingDirectory: wd,
      environment: env,
    });
    return { code: 0, stdout: "", stderr: "" };
  }
  return em;
}

// A unit file as systemd writes a transient one (checked on this box,
// systemd 255, 2026-11-15, systemd-run --user ... bash -c 'sleep 120; echo
// "$HOME" 50% x\y'): every ExecStart word in double quotes, with \ and "
// escaped, every $ written as $$ and every % as %%. Environment= words the
// same, except that $ stays $ (Isomux Worker 1's probe, systemd 255:
// -E 'A=x$HOME 5% y' is written Environment="A=x$HOME 5%% y"). `systemctl
// show` prints the same argv joined with spaces and no quotes, which loses
// the word boundaries.
function fragmentText(u: FakeUnit): string {
  const quote = (w: string, command: boolean) => {
    let out = w.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    if (command) out = out.replace(/\$/g, "$$$$");
    return `"${out.replace(/%/g, "%%")}"`;
  };
  const q = (w: string) => quote(w, true);
  const qEnv = (w: string) => quote(w, false);
  const lines = [
    "# This is a transient unit file, created programmatically via the systemd API. Do not edit.",
    "[Unit]",
    `Description=${(u.argv ?? []).join(" ")}`,
    "",
    "[Service]",
  ];
  if (u.workingDirectory) lines.push(`WorkingDirectory=${u.workingDirectory}`);
  if (u.environment && u.environment.length > 0)
    lines.push(`Environment=${u.environment.map(qEnv).join(" ")}`);
  if (u.argv) lines.push("ExecStart=", `ExecStart=${u.argv.map(q).join(" ")}`);
  return lines.join("\n");
}

function ok(stdout: string): RunResult {
  return { code: 0, stdout: stdout ? `${stdout}\n` : "", stderr: "" };
}

function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return re.test(name);
}

const cfg = (name: string) => `${HOME}/.config/systemd/user/${name}`;

// The office user's units as the 2026-11-15 move found them, plus the edge
// cases: the office's own units, a system-wide user unit, a unit in a home
// whose path only starts with this home's, and units not to enable.
function officeUnits(): FakeUnit[] {
  return [
    {
      name: "tailscaled.service",
      fragmentPath: cfg("tailscaled.service"),
      unitFileState: "enabled",
      activeState: "active",
    },
    {
      name: "lab-tunnel.service",
      fragmentPath: `${HOME}/.local/share/systemd/user/lab-tunnel.service`,
      unitFileState: "enabled",
      activeState: "inactive",
    },
    {
      name: "contract-check.path",
      fragmentPath: cfg("contract-check.path"),
      unitFileState: "enabled",
      activeState: "active",
    },
    {
      name: "contract-check.service",
      fragmentPath: cfg("contract-check.service"),
      unitFileState: "static",
      activeState: "active",
    },
    {
      name: "linked-worker.service",
      fragmentPath: `${HOME}/projects/worker/linked-worker.service`,
      unitFileState: "linked",
      activeState: "active",
    },
    // A template the agent wrote, and one instance of it running.
    {
      name: "mongo-backup@.service",
      fragmentPath: cfg("mongo-backup@.service"),
      unitFileState: "disabled",
      activeState: "inactive",
      kind: "template",
    },
    {
      name: "mongo-backup@daily.service",
      fragmentPath: cfg("mongo-backup@.service"),
      unitFileState: "disabled",
      activeState: "active",
      kind: "instance",
    },
    // Started by hand, never enabled.
    {
      name: "manual-job.service",
      fragmentPath: cfg("manual-job.service"),
      unitFileState: "disabled",
      activeState: "active",
    },
    {
      name: "pg-tunnel.service",
      fragmentPath: transientPath("pg-tunnel.service"),
      unitFileState: "transient",
      activeState: "active",
      argv: [
        "/usr/bin/ssh",
        "-N",
        "-L",
        "5433:localhost:5432",
        "db.example.com",
      ],
      workingDirectory: `${HOME}/projects/db`,
      environment: ["PATH=/usr/local/bin:/usr/bin:/bin", "TUNNEL_MODE=lab"],
    },
    // Not the agents': the office, its apps, the distribution's units.
    {
      name: "isomux.service",
      fragmentPath: cfg("isomux.service"),
      unitFileState: "enabled",
      activeState: "active",
    },
    {
      name: "isomux-app-board.service",
      fragmentPath: cfg("isomux-app-board.service"),
      unitFileState: "enabled",
      activeState: "active",
    },
    {
      name: "dbus.service",
      fragmentPath: "/usr/lib/systemd/user/dbus.service",
      unitFileState: "static",
      activeState: "active",
    },
    // Another user's home whose path starts with this home's.
    {
      name: "neighbour.service",
      fragmentPath: "/home/isomuxer/.config/systemd/user/neighbour.service",
      unitFileState: "enabled",
      activeState: "active",
    },
    // Not a type the move touches.
    {
      name: "lab.target",
      fragmentPath: cfg("lab.target"),
      unitFileState: "enabled",
      activeState: "active",
    },
  ];
}

const AGENT_UNITS = [
  "contract-check.path",
  "contract-check.service",
  "lab-tunnel.service",
  "linked-worker.service",
  "manual-job.service",
  "mongo-backup@daily.service",
  "pg-tunnel.service",
  "tailscaled.service",
];

const state = (em: Emulator, name: string) => {
  const u = em.unit(name);
  return u ? `${u.unitFileState}/${u.activeState}` : "gone";
};

describe("listing the agents' units", () => {
  it("keeps the units under the office user's home (unit files and transient), minus the office's own, the apps', other homes' and other types", () => {
    const em = emulator(officeUnits());
    const units = listAgentUnits(em.run, CTX);
    expect(units.map((u) => u.name).sort()).toEqual(AGENT_UNITS);
    const byName = new Map(units.map((u) => [u.name, u]));
    expect(byName.get("tailscaled.service")).toMatchObject({
      fragmentPath: cfg("tailscaled.service"),
      unitFileState: "enabled",
      activeState: "active",
      transient: false,
    });
    expect(byName.get("linked-worker.service")?.unitFileState).toBe("linked");
    expect(byName.get("pg-tunnel.service")).toMatchObject({
      transient: true,
      activeState: "active",
      exec: {
        argv: [
          "/usr/bin/ssh",
          "-N",
          "-L",
          "5433:localhost:5432",
          "db.example.com",
        ],
        workingDirectory: `${HOME}/projects/db`,
        environment: ["PATH=/usr/local/bin:/usr/bin:/bin", "TUNNEL_MODE=lab"],
      },
    });
    // Listing changes nothing.
    expect(em.changes).toEqual([]);
  });
});

describe("the lock's stop and the restore", () => {
  it("writes the record before the first change, disables only what was enabled, and stops what was active, transient units included", () => {
    const root = stateRoot();
    const em = emulator(officeUnits());
    const units = listAgentUnits(em.run, CTX);
    const recordAtFirstChange: (string[] | null)[] = [];
    em.beforeChange = () => {
      if (recordAtFirstChange.length > 0) return;
      const path = join(root, MOVE_UNITS_FILE);
      recordAtFirstChange.push(
        existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as { name: string }[])
              .map((u) => u.name)
              .sort()
          : null,
      );
    };
    stopUnitsForMove(root, em.run, units);
    expect(recordAtFirstChange).toEqual([AGENT_UNITS]);
    expect(
      Object.fromEntries(AGENT_UNITS.map((n) => [n, state(em, n)])),
    ).toEqual({
      "contract-check.path": "disabled/inactive",
      "contract-check.service": "static/inactive",
      "lab-tunnel.service": "disabled/inactive",
      // A linked unit is stopped, not disabled: disable would remove its link.
      "linked-worker.service": "linked/inactive",
      "manual-job.service": "disabled/inactive",
      "mongo-backup@daily.service": "disabled/inactive",
      "pg-tunnel.service": "gone",
      "tailscaled.service": "disabled/inactive",
    });
    // The office's own units and the others are untouched.
    for (const n of [
      "isomux.service",
      "isomux-app-board.service",
      "dbus.service",
      "neighbour.service",
      "lab.target",
    ])
      expect(state(em, n)).toBe(
        n === "dbus.service" ? "static/active" : "enabled/active",
      );
  });

  it("a failed unit does not stop the next one", () => {
    const root = stateRoot();
    const em = emulator(officeUnits());
    const units = listAgentUnits(em.run, CTX);
    em.failing.add("tailscaled.service");
    stopUnitsForMove(root, em.run, units);
    expect(state(em, "tailscaled.service")).toBe("enabled/active");
    expect(state(em, "contract-check.path")).toBe("disabled/inactive");
    expect(state(em, "pg-tunnel.service")).toBe("gone");
  });

  it('the restore puts every unit back as it was: enable only for exactly "enabled", start what was active, and the transient unit runs again with its command, folder and environment', () => {
    const root = stateRoot();
    const em = emulator(officeUnits());
    stopUnitsForMove(root, em.run, listAgentUnits(em.run, CTX));
    em.changes.length = 0;

    const result = restoreUnitsAfterMove(root, em.run);
    expect(result.failed).toEqual([]);
    expect([...result.restored].sort()).toEqual(AGENT_UNITS);
    expect(
      Object.fromEntries(AGENT_UNITS.map((n) => [n, state(em, n)])),
    ).toEqual({
      "contract-check.path": "enabled/active",
      "contract-check.service": "static/active",
      // Enabled but was not running: enabled again, not started.
      "lab-tunnel.service": "enabled/inactive",
      // Started again, not enabled: neither was enabled before the move.
      "linked-worker.service": "linked/active",
      "manual-job.service": "disabled/active",
      "mongo-backup@daily.service": "disabled/active",
      "pg-tunnel.service": "transient/active",
      "tailscaled.service": "enabled/active",
    });
    const tunnel = em.unit("pg-tunnel.service");
    expect(tunnel?.argv).toEqual([
      "/usr/bin/ssh",
      "-N",
      "-L",
      "5433:localhost:5432",
      "db.example.com",
    ]);
    expect(tunnel?.workingDirectory).toBe(`${HOME}/projects/db`);
    expect(tunnel?.environment).toEqual(
      expect.arrayContaining([
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "TUNNEL_MODE=lab",
      ]),
    );
    expect(existsSync(join(root, MOVE_UNITS_FILE))).toBe(false);
  });

  it("a transient unit's command comes back word for word: an argument with spaces and quotes stays one argument", () => {
    // How agents start long-lived work: systemd-run ... bash -c '<script>'.
    const argv = [
      "/usr/bin/bash",
      "-c",
      // A variable, a percent sign and a backslash, as scripts have them.
      'cd "$HOME/projects/db" && echo 50% x\\y && exec ssh -N -L "5433:localhost:5432" db.example.com',
    ];
    const root = stateRoot();
    const em = emulator([
      {
        name: "db-tunnel.service",
        fragmentPath: transientPath("db-tunnel.service"),
        unitFileState: "transient",
        activeState: "active",
        argv,
        workingDirectory: HOME,
        // A $ and a % in a value: systemd writes the % as %% and the $ as is.
        environment: [
          "PATH=/usr/bin:/bin",
          "LABEL=lab tunnel",
          "CACHE=$HOME/.cache 5%",
        ],
      },
    ]);
    const units = listAgentUnits(em.run, CTX);
    expect(units[0]?.exec?.argv).toEqual(argv);
    expect(units[0]?.exec?.environment).toEqual([
      "PATH=/usr/bin:/bin",
      "LABEL=lab tunnel",
      "CACHE=$HOME/.cache 5%",
    ]);
    stopUnitsForMove(root, em.run, units);
    expect(state(em, "db-tunnel.service")).toBe("gone");
    expect(restoreUnitsAfterMove(root, em.run).failed).toEqual([]);
    expect(em.unit("db-tunnel.service")?.argv).toEqual(argv);
    expect(em.unit("db-tunnel.service")?.environment).toEqual(
      expect.arrayContaining(["LABEL=lab tunnel", "CACHE=$HOME/.cache 5%"]),
    );
  });

  it("a transient unit that cannot run again is named in the result, and the others are still restored", () => {
    const root = stateRoot();
    const em = emulator(officeUnits());
    stopUnitsForMove(root, em.run, listAgentUnits(em.run, CTX));
    em.failing.add("run:pg-tunnel");
    em.failing.add("run:pg-tunnel.service");
    const result = restoreUnitsAfterMove(root, em.run);
    expect(result.failed.map((f) => f.name)).toEqual(["pg-tunnel.service"]);
    expect(result.restored).not.toContain("pg-tunnel.service");
    expect(state(em, "tailscaled.service")).toBe("enabled/active");
  });

  it("without a record the restore changes nothing", () => {
    const root = stateRoot();
    const em = emulator(officeUnits());
    expect(restoreUnitsAfterMove(root, em.run)).toEqual({
      restored: [],
      failed: [],
    });
    expect(em.changes).toEqual([]);
  });
});

describe("the office unit's restart policy", () => {
  it("reads Restart= of the office's own unit from the manager that runs it, and nothing without a unit", () => {
    const em = emulator(
      [
        {
          name: "isomux.service",
          fragmentPath: cfg("isomux.service"),
          unitFileState: "enabled",
          activeState: "active",
          restart: "always",
        },
      ],
      [
        {
          name: "isomux.service",
          fragmentPath: "/etc/systemd/system/isomux.service",
          unitFileState: "enabled",
          activeState: "active",
          restart: "on-failure",
        },
      ],
    );
    expect({
      user: officeRestartPolicy(
        `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/isomux.service\n`,
        em.run,
      ),
      system: officeRestartPolicy("0::/system.slice/isomux.service\n", em.run),
      session: officeRestartPolicy(
        `0::/user.slice/user-${UID}.slice/session-3.scope\n`,
        em.run,
      ),
    }).toEqual({
      user: { unit: "isomux.service", manager: "user", restart: "always" },
      system: {
        unit: "isomux.service",
        manager: "system",
        restart: "on-failure",
      },
      session: null,
    });
  });
});
