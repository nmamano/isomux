// A stand-in for /usr/bin/sudo (task 43a28eed), for the sudo runner and route
// tests. It never runs anything as root: after the password check it execs
// the rest of its argv as the current user, the same as sudo after auth.
//
// It answers the probe (-n with -l, or -n with -k true) from files the test
// writes, and for a run (-S) it records what it got: its argv, its
// environment, its cwd, its pid and what its stdin is. The environment is
// passed exactly, so the test talks to the script only through files in its
// directory. /bin/sh (dash) exports PWD itself; env() leaves it out.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sudo's own last line when it does not start the command.
export const FAKE_SUDO_WRONG_PASSWORD = "sudo: 1 incorrect password attempt";

export interface FakeSudo {
  dir: string;
  path: string;
  // The password the run accepts.
  setPassword(password: string): void;
  // sudo's last line on a refused run.
  setRefusal(line: string): void;
  // When set, a run that passes auth writes the start marker in two writes
  // with a pause between, then runs the command, in place of the wrapper.
  setSplitMarker(on: boolean): void;
  // When set, sudo waits this many seconds before it reads the password,
  // as PAM does after a wrong one.
  setAuthDelay(seconds: number | null): void;
  // The probe: the output and exit code of `sudo -n -l`, and the exit code
  // of `sudo -n -k true`. Without -k the stand-in answers 0 (a cached
  // timestamp); without LC_ALL=C it answers in Spanish.
  setProbe(list: { output: string; code: number }, trueCode: number): void;
  // The last run's argv, environment (without PWD), physical cwd, pid and
  // the target of its fd 0.
  argv(): string[];
  env(): Record<string, string>;
  cwd(): string;
  pid(): number;
  stdin(): string;
}

const SCRIPT = (dir: string) => `#!/bin/sh
d='${dir}'
case " $* " in
  *" -S "*) ;;
  *)
    list=0; keep=1; tru=0
    for a in "$@"; do
      case "$a" in -l) list=1 ;; -k) keep=0 ;; true) tru=1 ;; esac
    done
    if [ "$LC_ALL" != C ]; then
      printf '%s\\n' 'sudo: se requiere una contraseña' >&2
      exit 1
    fi
    if [ $list = 1 ]; then
      cat "$d/probe-list-out" >&2
      exit "$(cat "$d/probe-list-code")"
    fi
    if [ $tru = 1 ]; then
      [ $keep = 1 ] && exit 0
      exit "$(cat "$d/probe-true-code")"
    fi
    exit 64
    ;;
esac
printf '%s\\0' "$@" > "$d/argv"
/usr/bin/env > "$d/env"
pwd -P > "$d/cwd"
echo $$ > "$d/pid"
readlink /proc/$$/fd/0 > "$d/stdin"
if [ "$1" != -k ] || [ "$2" != -S ] || [ "$3" != -p ] || [ "$5" != -- ]; then
  printf '%s\\n' 'sudo: unexpected argv' >&2
  exit 64
fi
prompt=$4
printf '%s' "$prompt" >&2
[ -e "$d/auth-delay" ] && sleep "$(cat "$d/auth-delay")"
pw=
IFS= read -r pw
if [ "$pw" != "$(cat "$d/password")" ]; then
  printf '\\n%s\\n' 'Sorry, try again.' >&2
  printf '%s' "$prompt" >&2
  printf '%s\\n' 'sudo: no password was provided' >&2
  printf '%s\\n' "$(cat "$d/refusal")" >&2
  exit 1
fi
shift 5
if [ -e "$d/split" ]; then
  marker=$5
  half=$((\${#marker} / 2))
  printf '%s' "$(printf '%s' "$marker" | cut -c1-$half)" >&2
  sleep 0.2
  printf '%s' "$(printf '%s' "$marker" | cut -c$((half + 1))-)" >&2
  exec /bin/sh -c "$6"
fi
exec "$@"
`;

export function createFakeSudo(): FakeSudo {
  const dir = mkdtempSync(join(tmpdir(), "isomux-fake-sudo-"));
  const path = join(dir, "sudo");
  writeFileSync(path, SCRIPT(dir));
  chmodSync(path, 0o700);
  const write = (name: string, text: string) =>
    writeFileSync(join(dir, name), text, { mode: 0o600 });
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  write("password", "");
  write("refusal", FAKE_SUDO_WRONG_PASSWORD);
  write("probe-list-out", "sudo: a password is required\n");
  write("probe-list-code", "1");
  write("probe-true-code", "1");
  return {
    dir,
    path,
    setPassword: (password) => write("password", password),
    setRefusal: (line) => write("refusal", line),
    setSplitMarker: (on) => {
      if (on) write("split", "");
      else Bun.spawnSync(["rm", "-f", join(dir, "split")]);
    },
    setAuthDelay: (seconds) => {
      if (seconds !== null) write("auth-delay", String(seconds));
      else Bun.spawnSync(["rm", "-f", join(dir, "auth-delay")]);
    },
    setProbe: (list, trueCode) => {
      write("probe-list-out", list.output);
      write("probe-list-code", String(list.code));
      write("probe-true-code", String(trueCode));
    },
    argv: () => read("argv").split("\0").slice(0, -1),
    env: () =>
      Object.fromEntries(
        read("env")
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [
            line.slice(0, line.indexOf("=")),
            line.slice(line.indexOf("=") + 1),
          ])
          .filter(([name]) => name !== "PWD"),
      ),
    cwd: () => read("cwd").trim(),
    pid: () => Number(read("pid").trim()),
    stdin: () => read("stdin").trim(),
  };
}
