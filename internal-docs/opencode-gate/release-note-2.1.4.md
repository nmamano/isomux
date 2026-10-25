OpenCode agents now run OpenCode 2 (`@opencode/cli` 2.1.4).

For members:

- OpenCode 1 plugins in your own OpenCode config stop working. OpenCode 2 reports them as failed.
- OpenCode 2 maps some OpenCode 1 config keys (`permission`, `plugin`, `autoupdate`) and ignores other unknown keys.
- OpenCode agents read `AGENTS.md`, not `CLAUDE.md`.
- npm plugins in your OpenCode config install again at the first start. A plugin without a version gets the latest one. OpenCode checks for newer versions once a day but does not install them.
- MCP servers that you set up with OAuth in your own OpenCode config need a new sign-in. MCP servers registered in Isomux are not affected.
- OpenCode provider sign-ins carry over, unless OpenCode's database was deleted. Then sign in again.
- Browsers that last opened the office on a release before v2026.10.23 must sign in again. After an update from a release before v2026.10.23, that is every browser.

For self-hosters and Hosted:

- The first time an OpenCode agent runs after the update, Isomux copies its OpenCode database for OpenCode 2, which then imports it. The first turn waits for the import. On a 241 MB database with 28 conversations, the copy took 1.3 to 3.5 s (the slowest from a cold cache) and the import 2.3 to 3.3 s (2026-10-25). The copy needs free disk about the size of the database.
- Backups now include OpenCode provider sign-ins. OpenCode 2 keeps them in its database, and backups keep that database because it holds every OpenCode conversation. Backups still leave out the other sign-ins.
- After a rollback to the previous release, OpenCode 1 runs on its own database, which OpenCode 2 never writes. Conversations from before the update continue; OpenCode 2 conversations are not there. A later update continues the OpenCode 2 database from before the rollback, without the OpenCode 1 conversations of the rollback period.

API: the old names renamed in v2026.10.23 are gone.

- GET /agents returns manager, not username. Memory uses scope=member, not scope=boss.
- Instructions are read and written only at the .../instructions routes. The old routes return 404, and a write with an old field name gets a 400 that names the new one. docs/developer-api.md lists the current routes.
