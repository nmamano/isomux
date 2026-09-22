## Update the office

When a new release is out, the office header shows a "new release" notice. The owner can apply it from there; the confirm step shows how many busy agents the restart would interrupt. Or over SSH as root, with a tag from the [releases page](https://github.com/nmamano/isomux/releases):

```bash
isomux-update v2026.7.19
```

Either way, the update installs any system dependencies the new release needs, rebuilds at the new version, snapshots the office state, and restarts the service - interrupting running agents. If the new version fails to come up, the updater rolls code and state back to what you had. Downgrading to an older release needs `--allow-downgrade`. The Updates pane asks the owner to keep it open until the server restarts, checks the running version after reconnecting, and offers a browser refresh.
