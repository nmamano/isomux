# Agent-built apps

Only register an app when a member or an agent with the same manager asks for one. The registry assigns its stable port and runs it as a systemd user service. The app reads `PORT` and passes `ISOMUX_APP_HOST` directly as the bind host when present. Persistent state belongs under `ISOMUX_APP_DATA_DIR`; the app's direct address, when available, is `ISOMUX_APP_URL`. A secret that a member gives the app is in its environment under the secret's name; the app restarts when the secret changes. To get one from a member, open a secret request with `app` (connections page).

Use `POST /api/apps` with `{name,command,cwd,description?}`. Set `messageTargetAgentId` later with `PATCH /api/apps/:name`. To move an app to another agent and its room, PATCH `{createdByAgentId}`; the app owner must also have access to that agent. Use `GET /api/apps` or `/api/apps/:name`, `POST /api/apps/:name/start|stop|restart`, `GET /api/apps/:name/logs?lines=N`, and `DELETE /api/apps/:name`. Delete retires credentials and routes, stops the service, frees the name and port, and preserves data under `.retired`.

After the app first runs, optionally upload a thumbnail: `PUT /api/apps/:name/thumbnail` with the raw PNG, JPEG or WebP bytes as the body, or with `Content-Type: application/json` and `{"path":"..."}` naming the image file, relative to your cwd. OpenCode agents use the JSON form. At most 2 MB. `POST /api/apps/:name/archive` moves a stopped app into the Apps page's Archived section; start and restart take it out.

A member sees the apps they own plus apps built by agents in rooms they can access; office owners see them all. Anyone who can see an app can open it and read its state and restart count. Its logs, command, working directory, thumbnail upload, and start/stop/restart/archive/delete controls stay with its owner and office owners.

Give members the registry `shortUrl` when present, else the direct `url`, else the box hostname and port; never give them server localhost. If only the office port is exposed, give an SSH port-forward command. The short address opens an office page with the app and its target agent's shared chat. Chat appears only for members who can access both the app and that agent's room. Members can paste, drop or attach screenshots to that shared chat. Isomux does not take screenshots. Add a path to open one page of the app: `<shortUrl>/blog`. The direct `url` opens the app alone.

On the short address, the office's Chat button and its other controls sit over the app's bottom-right corner, on every screen size: 20 px from the right, 20 px or the bottom safe area (whichever is larger) from the bottom, 60 px tall and about 180 px wide (wider while it offers a reload). Keep a fixed bottom bar's controls and toasts out of that corner: leave 200 px free at the bar's right, or lift them 100 px above the bottom of the page. The direct `url` has no such controls.

When a change to an app is ready for the member to see, call `POST /api/apps/:name/reload`: each open short-address page reloads the app once it serves, on the page the member is on. After a change to the server code, restart the app instead; a start or restart also reloads. Do not ask the member to reload. A tab that opened the direct `url` does not reload.

Before you write app code that messages agents, pages, opens asks, or acts for the member behind a request, fetch the `apps-server` page.

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
| `POST /api/apps/:name/reload`    | Empty body                                              | `AppWire`                        |
| `POST /api/apps/:name/archive`   | Empty body                                              | `AppWire`                        |
| `POST /api/apps/:name/unarchive` | Empty body                                              | `AppWire`                        |
| `PUT /api/apps/:name/thumbnail`  | Raw PNG, JPEG or WebP bytes, or JSON `{path}`; max 2 MB | `AppWire`                        |
| `GET /api/apps/:name/thumbnail`  | None                                                    | Image bytes                      |

An agent can create and manage apps for its manager; visibility also follows creator-room access. Invalid names, commands, cwd, targets, creators, or line counts return 400/422; invisible apps return 404; ownership failures return 403; lifecycle conflicts, including archive of an app that may be running, return 409; a thumbnail over 2 MB returns 413 (400 by path, as does a path to no readable file) and other bytes 415; supervisor failures return 500/502. A host that cannot run apps (no Linux systemd) answers every route that would change or run an app with 501 `apps_not_supported`; tell the member.
