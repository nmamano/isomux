# Run Isomux on this computer

Use this guide for a local office on Linux or macOS. You need an internet
connection and access to an AI provider. The office runs while its terminal is
open and the computer is awake. On macOS, you can
[install with Homebrew](#install-with-homebrew) instead, and the office runs
in the background. Apps need Linux with systemd. On macOS the office runs
without them.

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

The server terminal shows office logs. For an office that starts at boot and
works from other devices, pick another [setup](self-hosted.md).

## Install with Homebrew

On macOS, Homebrew can install Isomux and run the office in the background.
The office starts when you log in and keeps running when you close the
terminal.

```sh
brew install isomux/isomux/isomux
brew services start isomux
```

Open the setup link from the office log:

```sh
grep 'setup#' "$(brew --prefix)/var/log/isomux.log"
```

The office uses `~/.isomux` and port 4000, the same as `bun run dev`. Stop one
before you start the other.

Agents get the `PATH` that your login shell sets in `~/.zprofile`. A `PATH`
set only in `~/.zshrc` does not reach them.

To stop the office, run `brew services stop isomux`.

### Update with Homebrew

```sh
brew upgrade isomux
brew services restart isomux
```

<!-- include: backup -->
