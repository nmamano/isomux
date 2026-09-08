# Linux manual install validation

Validated 2026-09-08 for task 7f2866b8 (manual install prerequisites).

The validation used a disposable fresh clone, a fresh HOME, an isolated TMPDIR
and a restricted PATH on the existing Ubuntu 24.04 x64 host. This was not a
fresh OS image. Docker was not used. The installer smoke-test program is a
separate task, b8971424.

## Results

- Bun 1.3.11, Node 24.19.0, Python 3.12.3 and node-gyp 13.0.2.
- With `python3` present and make/compiler commands hidden, `bun install`
  exited 1: `gyp ERR! stack Error: not found: make`.
- With make, GCC/G++, binutils and normal shell utilities available,
  `bun install --force` exited 0. These tools and development headers are
  supplied by Debian/Ubuntu's `build-essential`.
- Reviewer 5 tested with make and compilers present but `python3` and `python`
  absent on 2026-09-08. Node 24.19.0 with node-gyp 13.0.2 configure exited 1:
  `Error: Could not find any Python installation to use`
  (`/tmp/r5-lane/nopython.log`). This is the negative control for `python3`;
  the make control above ran with `python3` present.
- `bun run dev` served HTML with HTTP 200 in isolated Isomux state. Node loaded
  the newly built `node-pty`, spawned `/bin/sh`, received `PTY_OK` and exited 0.
- A separate Node 20.20.2 configure probe with node-gyp 13.0.2 exited 1:
  `TypeError: webidl.util.markAsUncloneable is not a function`.
- A Node 22.23.2 rebuild probe exited 0. The documented Node 24 LTS choice
  follows the unattended installer's Node 24 release line.

The restricted PATH still uses host libraries, development headers and compiler
internals. This verifies command availability and recovery, not the complete
package inventory of a minimal OS. No global node-gyp command was on PATH.

## Why node-gyp was available

Bun created a temporary executable named `node-gyp` whose default branch runs
`bun x --silent node-gyp $@`. Its other branch invokes `npm_config_node_gyp`.
The isolated cache resolved node-gyp 13.0.2, with Node engines
`^22.22.2 || ^24.15.0 || >=26.0.0`. That version is not pinned by Isomux.

[Bun 1.2.0 source](https://github.com/oven-sh/bun/blob/bun-v1.2.0/src/install/install.zig)
already contains `ensureTempNodeGypScript` and the same shim. The documented
Bun minimum therefore does not predate the shim.

The manifest requests `node-pty` with `^1.1.0`; the lock resolves 1.1.0. Its
install script is `node scripts/prebuild.js || node-gyp rebuild`. The package
ships Darwin and Windows prebuilds but no Linux prebuilds. The unattended
installer already installs `python3` and `build-essential`.

## Limits and unresolved report

The reported `/usr/bin/bash: node-gyp: command not found` was not reproduced.
A deliberately invalid `npm_config_node_gyp` produced exit 127 with the
missing override path named by the shim, which is a different message.
No evidence establishes an invalid override, a noexec/unwritable temporary
directory, or stale temporary state in the reporter's environment.

The separate login/invite lockout remains undiagnosed. The native build error
does not explain it. Existing GitHub Issues and Discord links cover reporting.
