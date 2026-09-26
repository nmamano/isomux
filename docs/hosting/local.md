# Run Isomux on this computer

Use this guide for a local office on Linux or macOS. You need an internet
connection and access to an AI provider. The office runs while its terminal is
open and the computer is awake. The Linux app supervisor requires systemd;
this guide does not set up background app services on macOS. OpenCode agents
need Linux; on macOS, use Claude or Codex agents.

<!-- include: install -->

<!-- include: claim -->

<!-- include: provider -->

Your office is ready at `http://localhost:4000`.

## Stop, return, or update

Press **Ctrl+C** in the server terminal to stop the office. To return, open a
terminal in the Isomux directory and run `bun run dev` again. Your office data
stays in `~/.isomux`.

To update, stop the office and run these commands from the Isomux directory:

```sh
git pull --ff-only
bun install
bun run dev
```

The server terminal shows office logs. For an office that starts at boot and is
reachable from other devices, choose another setup above.

<!-- include: backup -->
