## Updates and logs

To update, finish active agent work first. On the server, from the Isomux
checkout, run:

```sh
systemctl --user stop isomux
git pull --ff-only
bun install
systemctl --user start isomux
```

The service rebuilds the UI when it starts. Reload the browser after it starts.
A stop or restart interrupts active agent turns.

Read office logs with:

```sh
journalctl --user -u isomux -n 50 --no-pager
```

For memory protection, browser control, and deployment boundaries, see the
[hosting reference](hosting-reference.md).
