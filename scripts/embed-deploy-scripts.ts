// Keeps deploy/install.sh's embedded copies of the helper files identical to
// the files themselves.
//
// install.sh is fetched on its own (curl | bash), so it cannot read repo files:
// anything it installs on the box has to be inside it. The helper files are
// still real files in the repo so they can be read, linted, and run straight
// from a checkout. This script is what keeps the two in step - edit the helper,
// run this, commit both. deploy/install-sh.test.ts fails if they drift.
//
//   bun run scripts/embed-deploy-scripts.ts          # rewrite install.sh
//   bun run scripts/embed-deploy-scripts.ts --check  # fail if out of date

import { readFileSync, writeFileSync } from "fs";

const ROOT = new URL("..", import.meta.url).pathname;
const INSTALL_SH = `${ROOT}deploy/install.sh`;

export const EMBEDDED = [
  { path: "deploy/harden-ssh.sh", delimiter: "ISOMUX_HARDEN_SSH_SH" },
  { path: "deploy/oom-protect.sh", delimiter: "ISOMUX_OOM_PROTECT_SH" },
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
  let out = installSh;
  for (const { path, delimiter } of EMBEDDED) {
    const body = read(path);
    if (body.split("\n").includes(delimiter)) {
      throw new Error(`${path} contains a line equal to its heredoc delimiter`);
    }
    const re = new RegExp(
      `(<<'${delimiter}'\\n)[\\s\\S]*?(^${delimiter}$)`,
      "m",
    );
    if (!re.test(out)) {
      throw new Error(`no <<'${delimiter}' heredoc found in deploy/install.sh`);
    }
    out = out.replace(
      re,
      (_m, open: string, close: string) => open + body + close,
    );
  }
  return out;
}

if (import.meta.main) {
  const read = (p: string) => readFileSync(`${ROOT}${p}`, "utf8");
  const current = readFileSync(INSTALL_SH, "utf8");
  const next = embed(current, read);
  if (process.argv.includes("--check")) {
    if (next !== current) {
      console.error(
        "deploy/install.sh is out of date: run bun run scripts/embed-deploy-scripts.ts",
      );
      process.exit(1);
    }
    console.log("deploy/install.sh embedded copies are up to date");
  } else if (next === current) {
    console.log("deploy/install.sh embedded copies were already up to date");
  } else {
    writeFileSync(INSTALL_SH, next);
    console.log("deploy/install.sh embedded copies updated");
  }
}
