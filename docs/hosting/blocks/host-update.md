## Update the office

When a new release is out, the office header shows a "new release" notice. The owner can apply it from there; the confirm step shows how many busy agents the restart would interrupt. Or over SSH as root, with a tag from the [releases page](https://github.com/nmamano/isomux/releases):

```bash
isomux-update v2026.7.19
```

Either way, the update installs system dependencies, rebuilds and restarts the service, which interrupts running agents. If the new version fails to start, the updater restores the old code. To downgrade, add `--allow-downgrade`.
