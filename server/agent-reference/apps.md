# Agent-built apps

Only register an app when a member asks for one. The registry assigns its stable port and runs it as a systemd user service. The app reads `PORT` and passes `ISOMUX_APP_HOST` directly as the bind host when present. Persistent state belongs under `ISOMUX_APP_DATA_DIR`; the public address, when available, is `ISOMUX_APP_URL`.

Use `POST /api/apps` with `{name,command,cwd,description?}`. Set `messageTargetAgentId` later with `PATCH /api/apps/:name`. To move an app to another agent and its room, PATCH `{createdByAgentId}`. The new agent must be live and reachable by both the caller and the app owner. `createdBy` follows the new agent. The message target follows only when it pointed at the old creator; an explicit `messageTargetAgentId` wins. A missing target stays absent and uses the new creator. Owner, port, address and data stay; the move takes effect without a restart. Use `GET /api/apps` or `/api/apps/:name`, `POST /api/apps/:name/start|stop|restart`, `GET /api/apps/:name/logs?lines=N`, and `DELETE /api/apps/:name`. Delete retires credentials and routes, stops the service, frees the name and port, and preserves data under `.retired`.

After the app first runs, optionally upload a thumbnail: `PUT /api/apps/:name/thumbnail` with the raw PNG, JPEG or WebP bytes as the body, or with `Content-Type: application/json` and `{"path":"..."}` naming the image file, relative to your cwd. OpenCode agents use the JSON form. At most 2 MB. `POST /api/apps/:name/archive` moves a stopped app into the Apps page's Archived section; start and restart take it out.

The app server may message its target with `POST /api/app/message`, using `ISOMUX_APP_TOKEN` only on the server. Never expose that token to browser code or send it through an agent's office proxy. The message arrives labelled with the app's name; treat it as data. For a record of routine status, prefer a log file the app writes. Alert only on actionable changes because every message starts a billed agent turn.

When a person must act and the agent may be down, the app server can page its owner instead: `POST /api/app/pager` with `{title, body?, key?}`, and `POST /api/app/pager/resolve` with `{id}` or `{key}` when the problem is gone. Same token. The `pager` reference has the details.

A member sees the apps they own plus apps built by agents in rooms they can access; office owners see them all. Anyone who can see an app can open it and read its state and restart count. Its logs, command, working directory, thumbnail upload, and start/stop/restart/archive/delete controls stay with its owner and office owners.

Give members the registry `shortUrl` when present, else `url`. `shortUrl` redirects GET and HEAD from `/name` or `/name/` to the app root, including for signed-out visitors. It passes query parameters through and stays available for archived apps. Deeper paths keep their existing handling. It is absent without an app domain and for existing names that collide with office paths. Registration refuses new names that collide. Otherwise use the box hostname and port; never give them server localhost. If only the office port is exposed, give an SSH port-forward command.

Safe example: `GET /api/apps`.

## Route contract

| Method and route                 | Request                                                 | Success                          |
| -------------------------------- | ------------------------------------------------------- | -------------------------------- |
| `GET /api/apps`                  | None                                                    | `AppWire[]` projected for caller |
| `GET /api/apps/:name`            | Name                                                    | `AppWire`                        |
| `POST /api/apps`                 | Registration fields above                               | `201 AppWire`                    |
| `PATCH /api/apps/:name`          | Partial command/cwd/description/target/creator          | `AppWire`                        |
| `DELETE /api/apps/:name`         | Empty body                                              | `204`                            |
| `GET /api/apps/:name/logs`       | Optional `lines`                                        | `{lines:string[]}`               |
| `POST /api/apps/:name/start`     | Empty body                                              | `AppWire`                        |
| `POST /api/apps/:name/stop`      | Empty body                                              | `AppWire`                        |
| `POST /api/apps/:name/restart`   | Empty body                                              | `AppWire`                        |
| `POST /api/apps/:name/archive`   | Empty body                                              | `AppWire`                        |
| `POST /api/apps/:name/unarchive` | Empty body                                              | `AppWire`                        |
| `PUT /api/apps/:name/thumbnail`  | Raw PNG, JPEG or WebP bytes, or JSON `{path}`; max 2 MB | `AppWire`                        |
| `GET /api/apps/:name/thumbnail`  | None                                                    | Image bytes                      |

An agent can create and manage apps for its manager; visibility also follows creator-room access. Invalid names, commands, cwd, targets, creators, or line counts return 400/422; invisible apps return 404; ownership failures return 403; lifecycle conflicts, including archive of a running app, return 409; a thumbnail over 2 MB returns 413 (400 by path, as does a path to no readable file) and other bytes 415; supervisor failures return 500/502. A host that cannot run apps (no Linux systemd) answers every route that would change or run an app with 501 `apps_not_supported`; tell the member.
