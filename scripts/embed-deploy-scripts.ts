// Keeps deploy/install.sh's embedded copies of the helper files identical to
// the files themselves.
//
// install.sh is downloaded and run on its own, so it cannot read repo files:
// anything it installs on the box has to be inside it. The helper files are
// still real files in the repo so they can be read, linted, and run straight
// from a checkout. This script is what keeps the two in step - edit the helper,
// run this, commit both. A helper can carry a nested copy of another (NESTED). deploy/install-sh.test.ts fails if they drift.
//
//   bun run scripts/embed-deploy-scripts.ts          # rewrite install.sh
//   bun run scripts/embed-deploy-scripts.ts --check  # fail if out of date

import { readFileSync, writeFileSync } from "fs";

const ROOT = new URL("..", import.meta.url).pathname;
const INSTALL_SH = `${ROOT}deploy/install.sh`;

// Copies embedded in another helper before that helper is embedded in
// install.sh: the container's install-update-support.sh runs from the target
// release on an update, so what it carries reaches the box on the first one.
export const NESTED = [
  {
    path: "scripts/rescue-root.sh",
    delimiter: "ISOMUX_CONTAINER_RESCUE_ROOT_SH",
    into: "deploy/container/install-update-support.sh",
  },
];

export const EMBEDDED = [
  {
    path: "deploy/container/update-helper.py",
    delimiter: "ISOMUX_CONTAINER_UPDATE_HELPER",
  },
  {
    path: "deploy/container/isomux-container-update.socket",
    delimiter: "ISOMUX_CONTAINER_UPDATE_SOCKET",
  },
  {
    path: "deploy/container/isomux-container-update@.service",
    delimiter: "ISOMUX_CONTAINER_UPDATE_SERVICE",
  },
  {
    path: "deploy/container/install-update-support.sh",
    delimiter: "ISOMUX_CONTAINER_UPDATE_INSTALL",
  },

  {
    path: "deploy/container/compose.yaml",
    delimiter: "ISOMUX_CONTAINER_COMPOSE",
  },
  {
    path: "deploy/container/isomux-container.service",
    delimiter: "ISOMUX_CONTAINER_UNIT",
  },
  {
    path: "deploy/container/mount-check.sh",
    delimiter: "ISOMUX_CONTAINER_MOUNT_CHECK",
  },
  {
    path: "deploy/container/seccomp/chromium.json",
    delimiter: "ISOMUX_CONTAINER_SECCOMP",
  },
  {
    path: "deploy/container/seccomp/LICENSE",
    delimiter: "ISOMUX_CONTAINER_SECCOMP_LICENSE",
  },

  { path: "deploy/harden-ssh.sh", delimiter: "ISOMUX_HARDEN_SSH_SH" },
  { path: "scripts/rescue-root.sh", delimiter: "ISOMUX_RESCUE_ROOT_SH" },
  {
    path: "deploy/verify-hardening.sh",
    delimiter: "ISOMUX_VERIFY_HARDENING_SH",
  },
  { path: "deploy/oom-protect.sh", delimiter: "ISOMUX_OOM_PROTECT_SH" },
  { path: "deploy/bwrap-apparmor.sh", delimiter: "ISOMUX_BWRAP_APPARMOR_SH" },
  // Not a script: the AppArmor profile the installer falls back to when the
  // box has no apparmor-profiles package to copy it from. Same reason it is
  // embedded, same reason it stays a real file - `apparmor_parser -Q` can
  // syntax-check the repo copy.
  {
    path: "deploy/bwrap-userns-restrict.apparmor",
    delimiter: "ISOMUX_BWRAP_USERNS_RESTRICT",
  },
];

/** install.sh with every embedded copy replaced by the current file contents. */
export function embed(installSh: string, read: (p: string) => string): string {
  return embedEntries(installSh, EMBEDDED, read, "deploy/install.sh");
}

/** `into` with the copies NESTED puts in it replaced by the current files. */
export function embedNested(
  into: string,
  content: string,
  read: (p: string) => string,
): string {
  return embedEntries(
    content,
    NESTED.filter((entry) => entry.into === into),
    read,
    into,
  );
}

function embedEntries(
  target: string,
  entries: readonly { path: string; delimiter: string }[],
  read: (p: string) => string,
  name: string,
): string {
  let out = target;
  for (const { path, delimiter } of entries) {
    const body = read(path);
    if (body.split("\n").includes(delimiter)) {
      throw new Error(`${path} contains a line equal to its heredoc delimiter`);
    }
    const re = new RegExp(
      `(<<'${delimiter}'\\n)[\\s\\S]*?(^${delimiter}$)`,
      "m",
    );
    if (!re.test(out)) {
      throw new Error(`no <<'${delimiter}' heredoc found in ${name}`);
    }
    out = out.replace(
      re,
      (_m, open: string, close: string) => open + body + close,
    );
  }
  return out;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  // The nested helpers first, so install.sh embeds their current form.
  const updated = new Map<string, string>();
  const read = (p: string) =>
    updated.get(p) ?? readFileSync(`${ROOT}${p}`, "utf8");
  for (const into of new Set(NESTED.map((entry) => entry.into))) {
    const current = read(into);
    const next = embedNested(into, current, read);
    if (next === current) continue;
    if (check) {
      console.error(
        `${into} is out of date: run bun run scripts/embed-deploy-scripts.ts`,
      );
      process.exit(1);
    }
    updated.set(into, next);
    writeFileSync(`${ROOT}${into}`, next);
  }
  const current = readFileSync(INSTALL_SH, "utf8");
  const next = embed(current, read);
  if (check) {
    if (next !== current) {
      console.error(
        "deploy/install.sh is out of date: run bun run scripts/embed-deploy-scripts.ts",
      );
      process.exit(1);
    }
    console.log("deploy/install.sh embedded copies are up to date");
  } else if (next === current && updated.size === 0) {
    console.log("deploy/install.sh embedded copies were already up to date");
  } else {
    writeFileSync(INSTALL_SH, next);
    console.log("deploy/install.sh embedded copies updated");
  }
}
