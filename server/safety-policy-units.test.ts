// The systemd units the office owns (task 4b3adf60). An app reads its proxy
// secret and its vault secrets from its environment, so a unit file or a
// drop-in that applies to an app unit or to the office's own unit, or a
// change to the user manager's environment, would hand them to an agent at
// the next start. The hooks refuse those writes in every systemd user unit
// directory, and the systemctl verbs that change a unit or the manager's
// environment. Accident protection at the safety-hook level, not a boundary.
//
// Every denied case here is allowed by the policy before this task.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { officeUnitFromCgroup, unitPrefixFor } from "./office-units.ts";
import {
  evaluateProposedAction,
  type PolicyContext,
  type ProposedAction,
} from "./safety-policy.ts";
import { AGENT_ROOT, AGENT_ROOT_IS_DEFAULT } from "./split/roots.ts";

// The app units of the office under test, named as the app supervisor names
// them.
const PREFIX = unitPrefixFor(AGENT_ROOT, AGENT_ROOT_IS_DEFAULT);
// An office unit with dashes, so its dash-prefix drop-ins exist.
const OFFICE = "isomux-office-a.service";
const HOME = "/home/probe";
const CWD = "/tmp/probe-project";
const CONTEXT: PolicyContext = {
  cwd: CWD,
  shellHome: HOME,
  officeUnit: OFFICE,
};

const USER_DIR = `${HOME}/.config/systemd/user`;
// Every directory systemd reads user units or drop-ins from, matched by its
// own name wherever it sits.
const UNIT_DIRS = [
  USER_DIR,
  `${HOME}/.local/share/systemd/user`,
  "/etc/xdg/systemd/user",
  "/run/user/1001/systemd/user",
  "/run/user/1001/systemd/user.control",
  "/run/user/1001/systemd/transient",
  "/run/user/1001/systemd/generator",
  "/run/user/1001/systemd/generator.early",
  "/run/user/1001/systemd/generator.late",
];

// Entries of a unit directory that apply to a unit the office owns.
const OWNED_ENTRIES = [
  OFFICE,
  `${OFFICE}.d/override.conf`,
  `${PREFIX}hello.service`,
  `${PREFIX}hello.service.d/override.conf`,
  `${PREFIX}my-app.service`,
  // Every service.
  "service.d/override.conf",
  // Dash-prefix drop-ins of the office unit and of the app prefix.
  "isomux-.service.d/override.conf",
  "isomux-office-.service.d/override.conf",
  "isomux-app-.service.d/override.conf",
  `${PREFIX}.service.d/override.conf`,
  `${PREFIX}my-.service.d/override.conf`,
];

// Entries that apply to no unit of the office.
const OTHER_ENTRIES = [
  "myapp.service",
  "myapp.service.d/override.conf",
  "my-.service.d/override.conf",
  "isomux-office-a-backup.service",
  "default.target.wants/myapp.service",
];

const decide = (action: ProposedAction, context: PolicyContext = CONTEXT) =>
  evaluateProposedAction(action, context).decision;
const bash = (command: string, context: PolicyContext = CONTEXT) =>
  decide({ kind: "shell", command }, context);
const writeTool = (path: string, context: PolicyContext = CONTEXT) =>
  decide(
    { kind: "write-files", toolName: "Write", input: { file_path: path } },
    context,
  );

// Every case that misses, so one red run lists them all.
function misses(
  cases: string[],
  run: (item: string) => string,
  decision: "allow" | "deny",
): string[] {
  return cases.filter((item) => run(item) !== decision);
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("a write to a systemd user unit directory", () => {
  it("is refused for each entry that applies to an office unit, in every unit directory", () => {
    const paths = UNIT_DIRS.flatMap((dir) =>
      OWNED_ENTRIES.map((entry) => `${dir}/${entry}`),
    );
    expect(misses(paths, writeTool, "deny")).toEqual([]);
    expect(misses(paths, (path) => bash(`echo x > ${path}`), "deny")).toEqual(
      [],
    );
  });

  it("is allowed for a unit the office does not own, and outside the unit directories", () => {
    const paths = [
      ...UNIT_DIRS.flatMap((dir) =>
        OTHER_ENTRIES.map((entry) => `${dir}/${entry}`),
      ),
      // An office unit name outside any unit directory.
      `${CWD}/${PREFIX}hello.service`,
      `${CWD}/systemd/${OFFICE}`,
    ];
    expect(misses(paths, writeTool, "allow")).toEqual([]);
    expect(misses(paths, (path) => bash(`echo x > ${path}`), "allow")).toEqual(
      [],
    );
  });

  it("is refused from each write surface", () => {
    const dropIn = `${USER_DIR}/${PREFIX}hello.service.d`;
    const file = `${dropIn}/override.conf`;
    const actions: ProposedAction[] = [
      { kind: "write-files", toolName: "Edit", input: { file_path: file } },
      {
        kind: "read-and-write-files",
        toolName: "NotebookEdit",
        input: { notebook_path: file },
      },
      {
        kind: "patch-files",
        toolName: "apply_patch",
        patch: `*** Begin Patch\n*** Add File: ${file}\n+[Service]\n*** End Patch`,
      },
      ...[
        `printf '[Service]\\n' >> ${file}`,
        `tee ${file} < /tmp/x.conf`,
        `sed -i s/a/b/ ${file}`,
        `mkdir -p ${dropIn}`,
        `touch ${file}`,
        `cp /tmp/x.conf ${file}`,
        // Into the directory: the entry is the source's name.
        `cp /tmp/${PREFIX}hello.service ${USER_DIR}/`,
        `mv /tmp/${PREFIX}hello.service.d ${USER_DIR}`,
        `install -m 644 /tmp/x.conf ${file}`,
        `ln -s /tmp/evil.d ${dropIn}`,
        `echo x > ~/.config/systemd/user/${PREFIX}hello.service`,
        `bash -c 'echo x > ${file}'`,
        `env A=1 sh -c "cat /tmp/x.conf > ${file}"`,
      ].map((command): ProposedAction => ({ kind: "shell", command })),
    ];
    expect(actions.filter((action) => decide(action) !== "deny")).toEqual([]);
    // A relative path, against the agent's cwd.
    expect(
      bash(`echo x > ${PREFIX}hello.service`, { ...CONTEXT, cwd: USER_DIR }),
    ).toBe("deny");
  });

  it("is refused through a symlink to a unit directory", () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-units-link-"));
    temps.push(root);
    const real = join(root, "real", "systemd", "user");
    mkdirSync(real, { recursive: true });
    const link = join(root, "units-link");
    symlinkSync(real, link);
    const path = join(link, `${PREFIX}hello.service`);
    expect(writeTool(path)).toBe("deny");
    expect(bash(`echo x > ${path}`)).toBe("deny");
    // The same name in the link's own directory is not a unit directory.
    expect(writeTool(join(root, `${PREFIX}hello.service`))).toBe("allow");
  });

  it("protects the app units and nothing of the office unit when the office runs outside the user manager", () => {
    const outside: PolicyContext = { ...CONTEXT, officeUnit: null };
    expect(writeTool(`${USER_DIR}/${PREFIX}hello.service`, outside)).toBe(
      "deny",
    );
    expect(writeTool(`${USER_DIR}/${OFFICE}`, outside)).toBe("allow");
    expect(
      writeTool(`${USER_DIR}/isomux-office-.service.d/x.conf`, outside),
    ).toBe("allow");
  });
});

// The user manager's environment reaches every unit it starts later: a
// systemd user.conf (DefaultEnvironment=, at daemon-reexec) or an
// environment.d file (at every daemon-reload, which each app register runs).
describe("a write to the user manager's environment", () => {
  it("is refused for user.conf, user.conf.d and environment.d", () => {
    const paths = [
      `${HOME}/.config/systemd/user.conf`,
      `${HOME}/.config/systemd/user.conf.d/50-env.conf`,
      `${HOME}/.config/environment.d/50-env.conf`,
      "/etc/xdg/environment.d/50-env.conf",
    ];
    expect(misses(paths, writeTool, "deny")).toEqual([]);
    expect(
      misses(
        paths,
        (path) => bash(`echo LD_PRELOAD=/tmp/x.so > ${path}`),
        "deny",
      ),
    ).toEqual([]);
  });

  it("is allowed for other config files", () => {
    const paths = [
      `${HOME}/.config/myapp/environment.conf`,
      `${HOME}/.config/myapp/user.conf`,
      `${HOME}/.config/environment.d.bak`,
    ];
    expect(misses(paths, writeTool, "allow")).toEqual([]);
  });
});

describe("systemctl", () => {
  it("refuses set-environment and import-environment for any manager, in any wrapper", () => {
    expect(
      misses(
        [
          "systemctl --user set-environment LD_PRELOAD=/tmp/x.so",
          "systemctl --user import-environment",
          "systemctl --user import-environment PATH",
          "systemctl set-environment A=1",
          "systemctl --user --no-pager set-environment A=1",
          "bash -c 'systemctl --user set-environment A=1'",
          "env A=1 systemctl --user import-environment A",
          "true && systemctl --user set-environment A=1",
        ],
        bash,
        "deny",
      ),
    ).toEqual([]);
  });

  it("refuses edit and set-property on an office unit, with or without the suffix, and on a name it cannot read", () => {
    expect(
      misses(
        [
          `systemctl --user edit ${PREFIX}hello.service`,
          `systemctl --user edit ${PREFIX}hello`,
          `systemctl --user edit --full ${PREFIX}hello.service`,
          `systemctl --user edit --drop-in=x ${OFFICE}`,
          `systemctl --user edit isomux-office-a`,
          `systemctl --user set-property ${PREFIX}hello.service CPUQuota=100%`,
          'systemctl --user edit "$UNIT"',
          "systemctl --user edit $(cat /tmp/unit-name)",
        ],
        bash,
        "deny",
      ),
    ).toEqual([]);
  });

  it("allows the verbs that change no office unit and no environment", () => {
    expect(
      misses(
        [
          "systemctl --user edit myapp.service",
          "systemctl --user set-property myapp.service CPUQuota=100%",
          `systemctl --user status ${PREFIX}hello.service`,
          `systemctl --user cat ${OFFICE}`,
          `systemctl --user restart ${PREFIX}hello.service`,
          "systemctl --user show-environment",
          "systemctl --user daemon-reload",
          "systemctl --user list-units 'isomux-*'",
        ],
        bash,
        "allow",
      ),
    ).toEqual([]);
  });
});

describe("officeUnitFromCgroup", () => {
  it("names the service the office runs as under the user manager", () => {
    expect(
      officeUnitFromCgroup(
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/isomux.service\n",
      ),
    ).toBe("isomux.service");
    expect(
      officeUnitFromCgroup(
        "0::/user.slice/user-1001.slice/user@1001.service/isomux-office-a.service\n",
      ),
    ).toBe("isomux-office-a.service");
    // A hybrid hierarchy: the v1 lines come first.
    expect(
      officeUnitFromCgroup(
        [
          "12:pids:/user.slice/user-1001.slice/user@1001.service",
          "1:name=systemd:/user.slice/user-1001.slice/user@1001.service/app.slice/isomux.service",
          "0::/user.slice/user-1001.slice/user@1001.service/app.slice/isomux.service",
          "",
        ].join("\n"),
      ),
    ).toBe("isomux.service");
  });

  it("names none for a session, a scope, a system unit or no text", () => {
    for (const text of [
      "0::/user.slice/user-1001.slice/session-3.scope\n",
      "0::/user.slice/user-1001.slice/user@1001.service/app.slice/run-r1a2b3.scope\n",
      "0::/system.slice/isomux.service\n",
      "0::/\n",
      "",
    ])
      expect({ text, unit: officeUnitFromCgroup(text) }).toEqual({
        text,
        unit: null,
      });
  });
});
