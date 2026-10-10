# Bun terminal replacement: 2026-10-10

The Linux feasibility probe passed on Bun 1.4.2 and 1.3.11 with
`detached: true`. That probe used a reusable terminal object; without the
flag, both versions printed Bash's no-job-control warning. Inline terminal
options also establish the session without the flag on both versions. The properties now live in `server/pty-sidecar.test.ts`; the scratch
probe is removed. The sidecar starts Bash with `-i -l` and passes the terminal
environment and working directory through unchanged.

Bun introduced the API in [1.3.5](https://bun.sh/blog/bun-v1.3.5).
The documented minimum is 1.3.11, the oldest version verified for this lane.
The sidecar reports an update instruction and exit 127 over JSONL when
Bun.Terminal is absent. The PM approved that behavior and minimum version.

## Runtime and process ownership

The PM approved a Bun TypeScript sidecar over the existing JSONL protocol.
`AgentHost.bunPath()` returns the host's executable. In split mode the runner
reports its own `process.execPath`; the server's path is not used.
A failed executable-identity request prevents the rig-only split host from
connecting, rather than deferring that failure until a terminal opens.

The sidecar explicitly sets `detached: true`. The tagged Bun implementations call
`setsid()` and `TIOCSCTTY` for PTY children:

- [Bun 1.4.2 spawn source](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/jsc/bindings/bun-spawn.cpp)
- [Bun 1.3.11 spawn source](https://github.com/oven-sh/bun/blob/bun-v1.3.11/src/bun.js/bindings/bun-spawn.cpp)

The sidecar uses inline terminal options so Bun closes its copy of the slave
FD. A reusable `new Bun.Terminal` keeps that FD open. One streaming decoder
preserves UTF-8 between callbacks. Terminal EOF and process exit together
produce the exit message. If a descendant keeps the slave open, the sidecar
keeps node-pty 1.1.0's existing 200 ms drain bound (`lib/unixTerminal.js`).
The server drains sidecar stdout before it uses the process-exit fallback.

Owner detection reads the kernel's foreground group: `/proc/<shell>/stat`
field 8 on Linux, `ps -o tpgid=` on macOS. The group leader's `cmdline` argv[0] on Linux and
`comm` on macOS supply the process name. Linux `comm` truncates long names;
using argv[0] keeps node-pty's behavior. Unknown owners report `shell: false` so command cards do
not type into an unknown foreground program. Activity polling and explicit
status replies preserve the existing protocol. Input starts a poll after 50 ms;
follow-up checks use 500 ms while a non-shell owner or recent input remains.
An idle panel does not start a poll.

The integration tests exercise stop/bg/fg, foreground-only Ctrl+C, resize,
TERM, numeric and signal exits, 1.6 MB of UTF-8 output before exit, a 1 MB paste,
and shell/foreground/background cleanup on panel close and sidecar SIGKILL.
The same cleanup checks passed against the previous Node sidecar on Linux.
The cleanup tests require the sidecar to exit. Only after the original parent
has exited can an orphan zombie count as stopped while PID 1 reaps it.
The panel-close tests also cover a stopped foreground job.
On 2026-10-10, the same panel-close test on Bun 1.3.11 failed 5/100
times when stop closed the master and sent an explicit SIGHUP; it failed
0/100 times with master close alone. The failures left background jobs alive.
The sidecar sends Bun's numeric exit status and a separate signal string;
`terminal.ts` passes the numeric status to the existing terminal-exit event.

macOS stays supported. The same tests run in `macos.yml` on Apple silicon and
Intel. The lane has no live macOS host; the PM checks that job after the batch
push and before release.

## Dependency audit

Checked 2026-10-10 for the dependency removal:

- The installed dependency tree's package manifests had install/postinstall
  hooks only for `node-pty` and `opencode-ai`. `bun pm untrusted` reported zero
  untrusted hooks. The only `binding.gyp` was node-pty's. Removing node-pty
  also removes its sole `node-addon-api` dependency from the lockfile.
- OpenCode 1.18.23's `postinstall.mjs` copies a platform binary; its fallback
  runs `npm install --ignore-scripts` for a platform package. It invokes no
  compiler or Python. The bundled Codex launcher uses Bun and a native
  platform binary (`server/backends/codex/client.ts`, `native-bin.ts`).
- Claude SDK execution selects its native platform binary (`cwd-utils.ts`).
  The public Claude Code 2.1.296 package has no regular dependencies. Its
  `install.cjs` copies an optional platform binary; its only spawned command
  is macOS `sysctl`. It invokes no compiler or Python.
- The full host installer, updater, and deploy scripts have no remaining
  Python/compiler caller on the host install path. This covers Isomux code,
  not arbitrary agent workloads. The PM ruled that python3 and build-essential
  stay in the host apt list as agent-workload tools, alongside ffmpeg, ripgrep,
  and tmux. Container compiler packages also stay. The node-pty rebuild guard
  and worktree native-binding repair are removed. The manual-install package
  list no longer requires Python or a compiler to install Isomux.
- Python stays in the container installer and images: the supervisor,
  entrypoint, update client, and privileged update helper use it. Their apt
  list is separate from the full host install list.

The PM ruled that NodeSource and nodejs stay: `install_claude_cli` still uses
`npm install -g`. No Claude installation method changes in this lane. The
installer comment and local setup docs now describe Node as a CLI install
dependency. The earlyoom preference for Node processes is unchanged.
